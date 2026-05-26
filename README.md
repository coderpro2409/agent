# Email Agent

A small Python agent that reads a day's worth of Gmail messages over IMAP,
classifies each one, and uses a **locally running Ollama model** to write a
short summary and (where appropriate) a draft reply. Everything runs on your
machine — no third-party APIs, no HTTP calls to remote LLMs.

---

## What it does

For every email received on a given day, the agent:

1. **Fetches** the message via IMAP (`imaplib`, no extra deps).
2. **Classifies** it into one of:
   - `Payments` — invoices, bills, transactions
   - `Internship` — applications, HR, selections
   - `Work` — meetings, projects, assignments, school
   - `Networking` — LinkedIn, connection requests, collaboration
   - `Marketing/Promotion` — sales, offers, unsubscribe links
3. **Summarizes** the body in 2–3 bullets via a local Ollama model
   (skipped for `Marketing/Promotion`).
4. **Drafts a reply** if the category warrants one (`Work` or `Networking`),
   adjusting the greeting/sign-off when the sender looks like a senior
   professional (`principal`, `teacher`, `sir`, `ma'am`).
5. **Prints** a clean, structured block per email.

Classification is rule-based (keyword match) — fast, deterministic, and easy
to audit. Summaries and drafts are model-generated.

---

## Requirements

- **Python 3.9+** (only the standard library is used — no `pip install` needed).
- **[Ollama](https://ollama.com/)** installed and on your `PATH`.
- An Ollama model pulled locally. Default is `llama3.1:8b`:
  ```bash
  ollama pull llama3.1:8b
  ```
- A **Gmail account with 2-Step Verification** + an
  [App Password](https://myaccount.google.com/apppasswords).
  (Regular Gmail passwords will not work over IMAP.)

---

## Setup

```bash
# 1. Clone
git clone https://github.com/coderpro2409/agent.git
cd agent

# 2. Configure credentials
cp .env.example .env
# then edit .env with your real EMAIL_ADDRESS and APP_PASSWORD

# 3. (One-time) make sure Ollama has the model
ollama pull llama3.1:8b
```

### Loading the `.env` file

The script reads from real environment variables, not the `.env` file
directly. Two easy ways to load them:

```bash
# Option A — export inline for one run
set -a; source .env; set +a
python agent.py

# Option B — use a helper like `direnv` or `python-dotenv`
```

---

## Usage

Run the agent for **today**:

```bash
python agent.py
```

To run it for a specific day, import and call the function:

```python
from datetime import datetime
from agent import run_email_agent

run_email_agent(datetime(2026, 5, 20))
```

---

## Example output

```
Email Category:
Work

Summary:
- Team standup moved to 10:30 AM Friday.
- Please bring updates on the data-pipeline migration.
- Reply with attendance by EOD Thursday.

Reply Required:
Yes

Draft Reply:
Hello,

Thanks for the heads up — I'll be there at 10:30 AM on Friday and will come
prepared with the pipeline-migration update.

Regards
Prahaan Sanghvi
```

---

## How it's organized

```
agent/
├── agent.py          # Single-file agent: IMAP fetch → classify → summarize → reply
├── .env.example      # Template for required env vars
├── .gitignore        # Ignores .env, __pycache__, etc.
├── LICENSE           # MIT
└── README.md
```

Functionally, `agent.py` is split into small, named sections:

| Function | Purpose |
| --- | --- |
| `ollama_generate(prompt)` | Calls Ollama via its CLI (UTF-8 safe). |
| `classify_email(subject, body)` | Keyword-based category lookup. |
| `fetch_emails_for_day(date)` | IMAP search for a single calendar day. |
| `parse_email(msg)` | Extracts subject / sender / plain-text body. |
| `summarize_email(body)` | 2–3 bullet summary via Ollama. |
| `generate_reply(body, sender, category)` | Drafts a reply, picks tone by sender. |
| `format_output(...)` | Prints the structured block above. |
| `run_email_agent(date)` | Orchestrates the loop. |

---

## Security notes

- Never commit your real `.env`. It is git-ignored.
- App Passwords are scoped and revocable from your Google account — prefer
  them over your main password, and revoke any password that ever lands in
  a commit, screenshot, or chat log.
- The agent makes **no outbound HTTP requests**. The only network I/O is the
  IMAP TLS connection to Gmail. The LLM runs locally via the Ollama CLI.

---

## License

[MIT](./LICENSE)
