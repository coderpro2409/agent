# Email Agent: LLD

## Architecture

```
env vars (.env)
    |
    v
IMAP4_SSL --- login --- select inbox --- search ON <date> --- fetch RFC822
                                                                  |
                                                                  v
                                           email.message_from_bytes + parse
                                                                  |
                                                                  v
                                          classify_email (keyword first-match)
                                                                  |
                            +---------------+--------------------+----------------+
                            |               |                    |                |
                            v               v                    v                |
                  Marketing? skip   summarize_email     generate_reply             |
                                    (ollama CLI)        (ollama CLI)               |
                                          |                    |                   |
                                          +--------------------+-------------------+
                                                                  |
                                                                  v
                                                         format_output to stdout
```

The whole thing is one file, `agent.py`, around 230 lines. I considered splitting parser/classifier/generator into modules and decided against it; the surface area doesn't justify the navigation cost.

## The Ollama path

The thing that surprises people: I shell out to `ollama run <model>` rather than hitting the HTTP endpoint at `localhost:11434`. Two reasons. One, no Python HTTP dependency (the whole agent uses stdlib only for everything except the subprocess call). Two, the CLI path made debugging easier early on because I could paste the same prompt into a terminal and compare. The HTTP API would be slightly faster; I haven't needed the latency.

```python
def ollama_generate(prompt):
    process = subprocess.run(
        ["ollama", "run", OLLAMA_MODEL],
        input=prompt,
        text=True,
        encoding="utf-8",
        errors="ignore",
        capture_output=True,
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr)
    return process.stdout.strip()
```

UTF-8 with `errors="ignore"` is mandatory on Windows. Without it, a single non-ASCII character in an email body crashes the subprocess.

## Configuration

Everything is env vars:

```
IMAP_SERVER     default imap.gmail.com
IMAP_PORT       default 993
EMAIL_ADDRESS   required
APP_PASSWORD    required
OLLAMA_MODEL    default llama3.1:8b
```

`_require_env()` runs on startup. If `EMAIL_ADDRESS` or `APP_PASSWORD` is missing, it writes a clear message to stderr and exits non-zero. The other three have sensible defaults.

## The IMAP fetch

```python
mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
mail.login(EMAIL_ADDRESS, APP_PASSWORD)
mail.select("inbox")
date_str = date.strftime("%d-%b-%Y")   # e.g. "13-Jun-2026"
status, data = mail.search(None, f'(ON "{date_str}")')
```

The `dd-Mon-YYYY` format isn't optional. IMAP's `ON` search rejects any other date format. Took me embarrassingly long to figure that out.

For each UID returned, `fetch(uid, "(RFC822)")` pulls the full message, which `email.message_from_bytes` parses into something with `.walk()`, `.get()`, and `.get_payload()`.

## Parsing one message

`parse_email` returns `(subject, sender, body)`:

- Subject: `decode_header` handles encoded-words (`=?UTF-8?B?...?=`); fall back to UTF-8 with errors ignored.
- Sender: raw From header.
- Body: walk the multipart tree, take the first `text/plain` part that isn't an attachment, decode as UTF-8 with errors ignored.

HTML-only messages produce an empty body. The summarizer and drafter handle this fine (they just produce shorter output) but the result is less useful. Adding an `html2text` fallback would help; not in v1.

## Classification

```python
def classify_email(subject, body):
    text = f"{subject} {body}".lower()
    if any(k in text for k in ["invoice", "payment", "bill", "transaction"]):
        return "Payments"
    if any(k in text for k in ["internship", "application", "hr", "selection"]):
        return "Internship"
    if any(k in text for k in ["meeting", "assignment", "project", "submission", "school"]):
        return "Work"
    if any(k in text for k in ["connect", "linkedin", "network", "collaborate"]):
        return "Networking"
    if any(k in text for k in ["sale", "offer", "discount", "promo", "unsubscribe"]):
        return "Marketing/Promotion"
    return "Work"
```

The ordering is the only interesting decision. Financial keywords are unambiguous; recruiting keywords are mostly unambiguous; "meeting" and "project" dominate my actual work mail, so Work catches the bulk. Networking sits after Work because a LinkedIn message often also mentions "project" or "meeting". Marketing sits last because its keywords are noisy. The default fallback is Work because that's the most common type of mail I actually act on.

## Senior detection

```python
def is_elder_professional(sender):
    keywords = ["principal", "teacher", "sir", "ma'am"]
    return any(k in sender.lower() for k in keywords)
```

It looks at the raw From header, which on Gmail typically includes the display name (`"Mr. Verma (Principal) <verma@example.com>"`). When matched, the greeting becomes "Good Morning Sir/Ma'am," and the sign-off is "Thank You\n\nRegards\nPrahaan Sanghvi". Otherwise it's "Hello," and "Regards\nPrahaan Sanghvi".

The senior list is biased toward an Indian school context, which is where this got built. Easy to extend.

## Prompts

Two prompts, both small, both grounded in not-trusting-the-model.

Summary:

```
Summarize the following email in EXACTLY 2-3 bullet points.
Rules:
- No assumptions
- No added information

Email:
<body>
```

Reply:

```
Write a professional and concise reply to the email below.
Rules:
- Polite
- Clear
- No emojis
- Do NOT include greetings or sign-offs

Email:
<body>
```

The "no greetings or sign-offs" rule is load-bearing. It lets the wrapper code own the tone, and stops the model from inventing its own sign-off ("Best regards, AI") that I'd then have to strip.

## Output format

```
Email Category:
<category>

Summary:
<summary or "Not required">

Reply Required:
<Yes or No>

Draft Reply:
<draft or "Not required">
```

Fixed and stable. If I ever want to pipe this into a Markdown formatter or an Obsidian importer, the block boundaries make it easy.

## Where it breaks

| What happens | What the agent does |
|---|---|
| Env vars missing | `_require_env` prints to stderr, exits non-zero |
| IMAP auth fails | `imaplib.IMAP4.error` propagates uncaught (acceptable; fix is "set the app password right") |
| Ollama not installed | `FileNotFoundError: 'ollama'` from subprocess |
| Ollama subprocess returns non-zero | `RuntimeError(process.stderr)` propagates and kills the run (known bug; one bad message stops the loop) |
| Body encoding is weird | `errors="ignore"` strips bad bytes |
| No mail today | Empty list, agent exits silently |

The "Ollama failure kills the run" bug is the most annoying one. Easy fix: wrap each per-message pipeline in try/except, log to stderr, continue. Not yet done.

## Privacy

App password lives in `.env`, gitignored. The agent never writes mail content to disk. Email body goes to the Ollama subprocess via stdin, not as a command-line argument, so it doesn't appear in process listings. No outbound HTTP except IMAP/TLS to Gmail.

## What's missing

In rough priority:

1. **Don't die on one Ollama failure.** Try/except per message.
2. **Persist UIDs already processed.** A small JSON file keyed by `(account, date)` containing the set of UIDs handled. Lets re-runs skip work.
3. **Env-driven sign-off.** `SIGNOFF_NAME`, `SIGNOFF_TEMPLATE`. Killing the hardcoded "Prahaan Sanghvi".
4. **Date range.** A CLI flag for `--since` and `--until`, so I can backfill missed days.
5. **HTML body fallback.** `html2text` if no plain-text part exists.
