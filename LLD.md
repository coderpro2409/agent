# Email Agent: Low-Level Design

> Version 1.0 - describes `agent.py` as it stands today.

## 1. Architecture

```
+---------------+      +---------+      +-------------+
| Env vars      | ---> | IMAP    | ---> | Email parse |
| (.env)        |      | client  |      | (stdlib)    |
+---------------+      +---------+      +------+------+
                                               |
                                               v
                                       +---------------+
                                       | Classifier    |
                                       | (keyword)     |
                                       +-------+-------+
                                               |
                       +-----------------------+----------------------+
                       |                       |                      |
                       v                       v                      v
              +----------------+      +----------------+    +----------------+
              | Summarizer     |      | Reply drafter  |    | Output         |
              | (Ollama CLI)   |      | (Ollama CLI)   |    | formatter      |
              +-------+--------+      +-------+--------+    +-------+--------+
                      |                       |                     |
                      +-----------+-----------+                     |
                                  |                                 |
                                  +---------------------------------+
                                                  |
                                                  v
                                              stdout
```

## 2. Modules in `agent.py`

| Function | Inputs | Outputs | Notes |
|---|---|---|---|
| `_require_env()` | none | exits if env vars missing | Validates `EMAIL_ADDRESS` and `APP_PASSWORD` |
| `ollama_generate(prompt)` | str | str | Subprocess to `ollama run <MODEL>`; UTF-8 forced; `errors="ignore"` |
| `classify_email(subject, body)` | str, str | category str | Lowercases, runs `any(k in text for k in [...])` per category; defaults to Work |
| `fetch_emails_for_day(date)` | datetime | list of `email.message.Message` | IMAP4_SSL connect, login, select INBOX, search `ON "<dd-Mon-YYYY>"`, fetch RFC822 per UID |
| `parse_email(msg)` | message | (subject, sender, body) | Decodes subject with `decode_header`; walks multipart for `text/plain` |
| `summarize_email(body)` | str | str | Fixed prompt: "No assumptions, no added information" |
| `reply_required(category)` | str | bool | True for Work and Networking |
| `is_elder_professional(sender)` | str | bool | Substring match on sender header |
| `generate_reply(body, sender, category)` | str, str, str | str | Returns "Not required" for non-eligible categories; wraps model output with greeting and sign-off |
| `format_output(category, summary, reply_needed, draft)` | tuple | none | Prints a fixed block to stdout |
| `run_email_agent(date)` | datetime | none | Orchestrates fetch, per-email pipeline, print |

## 3. Configuration

| Env var | Default | Purpose |
|---|---|---|
| `IMAP_SERVER` | `imap.gmail.com` | IMAP host |
| `IMAP_PORT` | `993` | IMAPS port |
| `EMAIL_ADDRESS` | required | Login |
| `APP_PASSWORD` | required | Gmail app password |
| `OLLAMA_MODEL` | `llama3.1:8b` | Model passed to `ollama run` |

## 4. Classifier rules (first-match wins)

```
1. text contains any of {invoice, payment, bill, transaction}    -> Payments
2. text contains any of {internship, application, hr, selection} -> Internship
3. text contains any of {meeting, assignment, project, submission, school} -> Work
4. text contains any of {connect, linkedin, network, collaborate} -> Networking
5. text contains any of {sale, offer, discount, promo, unsubscribe} -> Marketing/Promotion
6. otherwise                                                      -> Work
```

The order encodes a priority: financial, then recruiting, then work, then networking, then marketing. Marketing sits last because its keywords ("offer", "sale") are noisy and would otherwise capture legitimate work mail (think "we can offer you a meeting on Tuesday").

## 5. Senior sender detection

`is_elder_professional(sender)` does a case-insensitive substring search of the sender string against `["principal", "teacher", "sir", "ma'am"]`. The sender string is the raw `From` header value, which for typical Gmail headers looks like `"Mr. Verma (Principal) <verma@example.com>"`.

When the match hits, the greeting becomes `Good Morning Sir/Ma'am,` and the sign-off becomes `Thank You\n\nRegards\nPrahaan Sanghvi`. Otherwise the greeting is `Hello,` and the sign-off is `Regards\nPrahaan Sanghvi`.

## 6. Prompts

### 6.1 Summary prompt

```
Summarize the following email in EXACTLY 2-3 bullet points.
Rules:
- No assumptions
- No added information

Email:
<body>
```

### 6.2 Reply prompt

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

The "do not include greetings or sign-offs" rule keeps the model focused on substance. The wrapper code adds greeting and sign-off, so the senior-vs-default tone stays under our control, not the model's.

## 7. Output format (fixed)

```
Email Category:
<category>

Summary:
<summary text or "Not required">

Reply Required:
<Yes or No>

Draft Reply:
<draft text or "Not required">
```

This is a stable contract for any downstream tool that wants to scrape the output (a Markdown formatter, an Obsidian importer, a daily digest).

## 8. Sequence: one run

1. `__main__` calls `_require_env()`. Exits with a clear message if env vars are missing.
2. `run_email_agent(datetime.today())` is called.
3. `fetch_emails_for_day(today)`:
   1. `imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)`.
   2. `login(EMAIL_ADDRESS, APP_PASSWORD)`.
   3. `select("inbox")`.
   4. `search(None, f'(ON "{dd-Mon-YYYY}")')`.
   5. For each UID in the result, `fetch(uid, "(RFC822)")` and parse with `email.message_from_bytes`.
   6. `logout()`.
4. For each message:
   1. `parse_email(msg)` -> subject, sender, body.
   2. `classify_email(subject, body)` -> category.
   3. If category != Marketing/Promotion: `summarize_email(body)` -> summary.
   4. `generate_reply(body, sender, category)` -> draft.
   5. `format_output(category, summary, reply_required(category), draft)`.

## 9. Failure modes

| Scenario | Behavior |
|---|---|
| Missing env vars | `_require_env` writes the missing keys to stderr and calls `sys.exit` with a non-zero exit code |
| IMAP auth fails | `imaplib` raises `IMAP4.error`; currently propagates as an uncaught exception. Acceptable for v1 since the remedy is "set the app password correctly" |
| Ollama CLI not installed | Subprocess raises `FileNotFoundError: 'ollama'`; the caller sees a clear stack trace |
| Ollama subprocess returns non-zero | `ollama_generate` raises `RuntimeError(process.stderr)`. The current loop does not catch this, so one bad message stops the run. Known limitation |
| Email body has odd encoding | `errors="ignore"` on the UTF-8 decode strips bad bytes rather than crashing |
| No emails on the given date | `fetch_emails_for_day` returns an empty list; `run_email_agent` produces no output |
| Sender header is `None` | `msg.get("From").strip()` would raise; trusted to be present for delivered mail; not defended against |

## 10. Security and privacy

- App password lives in `.env`. `.env.example` is committed; `.env` is gitignored.
- The agent never writes mail content to disk. Everything stays in stdout and in process memory.
- The Ollama subprocess receives the email body via stdin, not via command-line arguments, so the body does not appear in process listings.
- No outbound HTTP. Mail fetch goes over IMAP/TLS to Gmail; generation goes to a local subprocess.

## 11. Known limitations and extension hooks

1. **Date scope is one day.** Add a `--since` CLI argument to widen.
2. **No deduplication.** A re-run on the same day reprocesses every message; a small UID cache file would fix this.
3. **Hard-coded sign-off.** Move to env: `SIGNOFF_NAME`, `SIGNOFF_TEMPLATE`.
4. **Stops on one model error.** Wrap each per-message pipeline in try/except, log to stderr, continue.
5. **Plain-text bodies only.** HTML bodies are ignored; an `html2text` step would broaden support at the cost of one new dependency.
6. **No metrics.** A final summary line ("processed N messages, M needed replies, took T seconds") would help users tune.
