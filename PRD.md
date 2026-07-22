# Product Requirements Document — Inbox Agent

## 1. Problem statement

Going through a day's Gmail inbox by hand means opening each message to figure out what it's about, whether it needs a reply, and what that reply should say. Inbox Agent automates the triage step: point it at a Gmail address and a day, and it returns every message from that day already summarized, categorized, and — where a reply is expected — pre-drafted.

## 2. Target user

- Anyone who wants a daily digest of one Gmail inbox instead of reading every message
- Comfortable generating a Gmail **app password** (not their real password) for a one-off, non-stored fetch
- Fine with a first-run model download in the browser (or, later, plugging in a hosted open model) instead of sending email content to a commercial AI API

## 3. Success metrics

| Metric | Target |
|---|---|
| Messages processed per fetch that get a category + summary | 100% (never silently dropped) |
| Messages needing a reply that get a usable draft | 100% (local rule-based draft is the floor, not best-effort) |
| Gmail credentials retained after the request completes | 0 — never stored server-side |
| AI provider keys required for default operation | 0 |

## 4. Core features (in scope)

### 4.1 Inbox fetch
- User enters Gmail address, Gmail app password, and a calendar date (defaults to today, UTC)
- Fetches every message received that UTC day from `INBOX` over IMAP, newest first
- Credentials are used for a single IMAP session and never persisted

### 4.2 Per-message analysis
- **Category**: Payments, Internship, Work, Networking, or Marketing/Promotion — scored by keyword strength, not first-match, so an email with signals for multiple categories lands in the strongest one
- **Reply required**: `true` for Work and Networking, `false` otherwise
- **Summary**: 2–3 bullet points
- **Draft reply**: generated only when a reply is required; greeting/closing adapt when the sender looks like a teacher/elder ("Principal", "Teacher", "Sir/Ma'am")

### 4.3 Three-tier drafting/summarizing
1. **Browser LLM (default)** — SmolLM2-360M-Instruct runs client-side via WebLLM/WebGPU. No email content leaves the browser to a third-party AI provider.
2. **Optional server LLM** — if `OPEN_MODEL_PROVIDER` is set to a real open-model backend (Groq, Together, OpenRouter, or a self-hosted OpenAI-compatible endpoint), the server calls it instead. No Anthropic/Claude integration exists or is planned.
3. **Local rule-based fallback** — deterministic sentence-splitting summary and intent-keyword draft template. Used whenever tiers 1–2 are unavailable or fail, so every message still gets a usable result.

### 4.4 Transparency
- Response reports which tier actually produced each result (`local no-key`, `browser LLM pending`, or `<provider>: <model>[+ local fallback]`) — never presents rule-based output as if it were model-generated.

## 5. Out of scope (v1)

- Sending replies (drafts are for the user to review and send themselves)
- Multi-account / multi-day batch fetching in one request
- Persisting fetched emails or drafts anywhere server-side
- Attachments (parsing skips them; only text/plain and text/html bodies are read)
- Any Anthropic/Claude-branded integration

## 6. Constraints

- Gmail-only IMAP (`imap.gmail.com:993` by default, overridable via env vars for compatibility, not multi-provider support)
- Requires an **app password**, not the account's real password (Google no longer accepts real passwords over IMAP for most accounts)
- Browser LLM tier requires WebGPU (current Chrome/Edge); first run downloads ~580 MB of model weights
- Serverless function timeout (`maxDuration: 60`) bounds how many messages one fetch can realistically process

## 7. Future roadmap (post-v1)

| Priority | Item |
|---|---|
| P1 | Send-from-draft (currently view/copy only) |
| P1 | Per-category custom draft templates |
| P2 | Multi-day range fetch |
| P2 | Non-Gmail IMAP providers as first-class (currently override-only) |
| P3 | Persist user-approved drafts for tone learning |

## 8. Non-goals (deliberate)

- We will **not** auto-send anything. A human reviews every draft before it goes out.
- We will **not** require an AI API key for the product to work at all — the browser/local tiers must always be sufficient on their own.
- We will **not** store Gmail credentials or fetched email content server-side.
