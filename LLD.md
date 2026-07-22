# Low-Level Design — Inbox Agent

## 1. System architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  index.html + inline <script type="module">              │    │
│  │  - Collects Gmail address / app password / date          │    │
│  │  - POSTs to /api/inbox with clientLLM:true                │    │
│  │  - Renders server result immediately ("… pending")       │    │
│  │  - Re-analyzes each email client-side with SmolLM2        │    │
│  │    via WebLLM/WebGPU (llm-worker.js, a Web Worker)        │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                            │ HTTPS POST /api/inbox
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Vercel Python Function — api/inbox.py                           │
│  BaseHTTPRequestHandler: validates body, calls lib.email_agent    │
└──────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  lib/email_agent.py                                               │
│  - get_utc_day_range   → validated UTC day window                 │
│  - IMAP4_SSL → login → SEARCH SINCE/BEFORE → per-UID FETCH         │
│  - parse_message       → MIME → {subject, sender, body}           │
│  - classify            → category (keyword-strength scoring)      │
│  - reply_required      → bool                                     │
│  - open_model_chat     → optional server LLM (Groq/Together/       │
│    OpenRouter/custom OpenAI-compatible; disabled by default)       │
│  - fallback_summary / local_draft_reply → deterministic floor      │
└──────────────────────────────────────────────────────────────────┘
                            │ IMAP over TLS (imap.gmail.com:993)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Gmail inbox (visitor's own account, app-password auth)           │
└──────────────────────────────────────────────────────────────────┘
```

No database. No credential storage. Each request is a single, stateless
IMAP session that ends when the response is sent.

## 2. Backend (`api/inbox.py` + `lib/email_agent.py`)

### 2.1 Request contract

`POST /api/inbox`
```json
{ "email": "you@gmail.com", "appPassword": "xxxx xxxx xxxx xxxx", "date": "2026-07-22", "clientLLM": true }
```

| Field | Required | Notes |
|---|---|---|
| `email` | yes | Not validated as a real Gmail address beyond non-empty; IMAP login fails loudly if wrong |
| `appPassword` | yes | Whitespace stripped (Google displays it in 4-char groups) |
| `date` | no | Defaults to today, UTC; must match `YYYY-MM-DD` and be a real calendar date |
| `clientLLM` | no | When `true`, forces server-side analysis to the local/open-model tier only (skips nothing — see §2.3) and includes each email's raw body (`content`, capped at 3,500 chars) in the response so the browser can re-analyze it |

### 2.2 IMAP fetch (`fetch_inbox`)

1. Resolve the UTC day window (`get_utc_day_range`).
2. `IMAP4_SSL(host, port, timeout=30).login(email, app_password)`.
3. `select("INBOX", readonly=True)` — never mutates the mailbox.
4. `uid("search", None, "SINCE", <day start>, "BEFORE", <day end>)`.
5. Sort UIDs descending (newest first) and `uid("fetch", uid, "(BODY.PEEK[])")` each one — `PEEK` so messages are never marked as read.
6. `parse_message` extracts `{subject, sender, body}` from the raw RFC822 bytes, preferring `text/plain` parts and falling back to a minimal HTML-tag stripper (`_TextExtractor`) when only `text/html` exists.
7. `imap.logout()` in a `finally` block regardless of outcome.

### 2.3 Per-message analysis tiers

Every message gets a result from exactly one of these, in this order:

| Tier | When used | Produces |
|---|---|---|
| 1. Server open-model | `OPEN_MODEL_PROVIDER` set to a real backend **and** `clientLLM` is not `true` | LLM summary + draft via `open_model_analyze_email` |
| 2. Local rule-based | Open-model tier disabled, not configured, or throws `ValueError/OSError/TimeoutError/URLError` | `fallback_summary` (first 3 sentences) + `local_draft_reply` (intent-keyword template) if a reply is needed |
| 3. Browser LLM (client-side, on top of 1/2) | Always attempted by the default UI (`clientLLM: true` is hardcoded in the page's fetch call) | SmolLM2-360M re-analyzes each email in the browser and **overwrites** the server result if it returns valid, complete JSON |

`classify()` scores every category by keyword-hit count and returns the
strongest match (ties default to "Work"), rather than stopping at the
first category whose keywords appear anywhere in the text — this avoids
a networking email that happens to mention "project" being miscategorized
as Work just because Work is checked earlier in a fixed list.

`open_model_chat`/`_provider_settings` (same shape as
`bfsi-policy-assistant/lib/open_model.py`, which was ported from here):
presets for `groq`, `together`, `openrouter`, `custom`; `local` (default)
is a no-op that returns `""` immediately, so tier 1 is skipped without
a network call unless someone deliberately configures a provider.

### 2.4 Response contract

```json
{
  "date": "2026-07-22",
  "count": 3,
  "llm": "local no-key",
  "emails": [
    {
      "subject": "...", "sender": "...", "category": "Work",
      "needsReply": true, "summary": "• ...\n• ...",
      "draft": "Hello,\n\n...\n\nRegards\nPrahaan Sanghvi",
      "content": "..."  // only present when clientLLM was true
    }
  ]
}
```

`llm` reports which tier actually ran (`"local no-key"`,
`"browser LLM pending"` when `clientLLM` is true, or
`"<provider>: <model>[+ local fallback]"`) — the UI never labels
rule-based output as model output.

## 3. Frontend — browser SmolLM2 tier (inline `<script>` in `index.html`)

1. On submit, POST `/api/inbox` with `clientLLM: true`; render the
   server's tier-1/2 result immediately labeled "… pending" so the user
   isn't staring at a blank page during model load.
2. Lazily load `SmolLM2-360M-Instruct-q4f32_1-MLC` via
   `CreateWebWorkerMLCEngine` into a dedicated Web Worker
   (`llm-worker.js`) — keeps model inference off the UI thread.
3. For each email, call the worker with a JSON-schema-constrained
   completion (`response_format: json_object` with an explicit schema)
   and a system prompt that **explicitly tells the model to treat the
   email body as untrusted quoted data and never follow instructions
   found inside it** — a prompt-injection guard, since email content is
   attacker-controlled input to an LLM.
4. Up to 3 attempts per email with shrinking content/token limits
   (1400/900/600 chars, 130/110/96 tokens) if a response is invalid or
   incomplete; `engine.resetChat()` between every attempt and every
   email so one message's context can't leak into the next.
5. If the browser model is unavailable (no WebGPU, download failure) or
   an email exhausts all 3 attempts, that email keeps its tier-1/2
   result instead of blocking the rest of the inbox.
6. The email's raw `content` field is cleared (`undefined`) client-side
   before the *next* render so it never lingers in a rendered DOM state
   longer than needed for the model call that used it.

## 4. Data flow — one fetch, end to end

```
User submits form
    │
    ▼ POST /api/inbox {email, appPassword, date, clientLLM:true}
api/inbox.py → fetch_inbox()
    │  IMAP login → SEARCH → FETCH each UID → parse_message → classify
    │  clientLLM=true ⇒ tier 1 skipped ⇒ tier 2 (local rule-based) runs for every email
    ▼
200 OK { emails: [...], llm: "browser LLM pending" }
    │
    ▼ render immediately (tier-2 results, labeled "pending")
For each email, sequentially:
    │  loadModel (first email only) → analyzeEmailWithRetry (≤3 attempts)
    │  success → overwrite category/summary/draft, re-render
    │  failure → keep tier-2 result, re-render, continue to next email
    ▼
Final status: "N email(s) processed: M with SmolLM2[; K used fallback analysis]"
```

## 5. Open issues / known limitations

| Issue | Impact | Mitigation |
|---|---|---|
| Sequential per-email browser inference | Slow for a high-volume inbox day (each email is a separate model call) | Could batch/parallelize once WebLLM supports concurrent sessions well |
| No non-Gmail IMAP provider is exercised by tests | Untested against Outlook/Yahoo/etc. despite `IMAP_SERVER`/`IMAP_PORT` being overridable | Add a config-driven test or explicitly scope to Gmail-only in docs |
| `classify()` keyword lists are hand-picked, not learned | Categories can still tie or miss novel phrasing | Acceptable for v1; revisit if false-categorization reports come in |
| `maxDuration: 60` on the Vercel function | A day with many messages or a slow open-model provider could time out | Add pagination/streaming if this becomes a real complaint |
| Server-side `open_model_chat` and browser-side SmolLM2 use separate JSON schemas/prompts | Slight duplication of "categories + summary + draft" contract | Acceptable — one is Python calling a hosted API, the other is in-browser WebLLM; a shared schema would need a JS↔Python sync mechanism that doesn't exist yet |

## 6. Local development setup

```text
npm install       # installs @mlc-ai/web-llm's peer tooling for local preview
python frontend_bundle.py dist   # materializes index.html + llm-worker.js into dist/
python -m http.server 8000 --directory dist
```

The `/api/inbox` function needs a Python-function-capable host to run
locally (Vercel CLI's `vercel dev`, or invoke `lib.email_agent.fetch_inbox`
directly from a Python shell for manual testing).

## 7. Testing

| Layer | Approach | Status |
|---|---|---|
| `lib/email_agent.py` | `python -m unittest discover -s test -p "test_*.py"` — day-range validation, classification (including the keyword-overlap regression), reply/elder rules, MIME parsing, fake-IMAP fetch ordering, draft formatting | Automated; passing |
| Browser SmolLM2 flow | Manual (requires WebGPU + real Gmail credentials) | Manual |
| `open_model_chat` provider presets | Not unit-tested against real Groq/Together/OpenRouter endpoints (would require live API keys) | Manual/opt-in only |

No CI yet.
