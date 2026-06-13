# Email Agent: Product Requirements Document

> Version 1.0 - matches the v1 implementation in `agent.py`.

## 1. Problem

Personal email accumulates faster than most people can triage. The two heaviest tasks per message are:

1. Deciding what the email is about (category).
2. Writing a short reply when one is warranted.

Existing assistants (Superhuman, Shortwave, Gmail's smart replies) work, but they all require granting a third party full inbox access. For a user who wants mail content to stay on their own machine, the only acceptable design is one where:

- Authentication happens directly with Gmail's IMAP server, using an app password the user controls.
- The LLM call goes to a local Ollama model, not a hosted API.
- Nothing is sent or written outside the user's machine.

That is the scope of this agent.

## 2. Target user

A single individual on their own machine. The current implementation hard-codes the sign-off as "Prahaan Sanghvi"; replacing this is a known follow-up.

## 3. Goals

1. Pull all of a single day's inbox messages.
2. Classify each into one of five categories deterministically (rule-based, auditable).
3. For non-marketing messages, produce a 2 to 3 bullet summary.
4. For Work and Networking messages, produce a draft reply.
5. Adjust greeting and sign-off when the sender appears to be a senior professional.
6. Never call a remote LLM. Never send a reply (drafts only).

## 4. Non-goals

1. Multi-account or multi-folder support.
2. Outbound send. The agent drafts; the user copies, edits, and sends.
3. Conversation threading (each message is processed standalone).
4. Attachment handling.
5. Machine-learned classification.
6. Long-running daemon. The agent runs once per invocation.

## 5. Categories and behavior

| Category | Keyword triggers (in subject or body, case-insensitive) | Summarize? | Draft a reply? |
|---|---|---|---|
| Payments | invoice, payment, bill, transaction | yes | no |
| Internship | internship, application, hr, selection | yes | no |
| Work | meeting, assignment, project, submission, school | yes | yes |
| Networking | connect, linkedin, network, collaborate | yes | yes |
| Marketing/Promotion | sale, offer, discount, promo, unsubscribe | no | no |
| (default fallback) | none of the above | yes | yes (treated as Work) |

## 6. User journey

1. User pulls the model: `ollama pull llama3.1:8b`.
2. User generates a Gmail app password and stores it in `.env`.
3. User runs `python agent.py`.
4. For each email received today, the agent prints a block: category, summary, "Reply Required: yes/no", draft reply.
5. User copies any draft they want to use, pastes into Gmail, edits, sends.

## 7. Functional requirements

- **F1.** Read credentials from env vars: `EMAIL_ADDRESS`, `APP_PASSWORD`, optional `IMAP_SERVER` (default `imap.gmail.com`), `IMAP_PORT` (default 993), `OLLAMA_MODEL` (default `llama3.1:8b`).
- **F2.** On startup, exit with a clear message if `EMAIL_ADDRESS` or `APP_PASSWORD` is missing.
- **F3.** Connect to IMAP over SSL, login, select INBOX.
- **F4.** Search for messages received on today's date (server timezone).
- **F5.** For each message, fetch RFC822, parse subject, sender, and plain-text body.
- **F6.** Classify by first-match keyword rule; fall back to Work if no rule matches.
- **F7.** For categories other than Marketing/Promotion, call Ollama via CLI to produce a 2-3 bullet summary.
- **F8.** For Work and Networking, call Ollama via CLI to produce a polite, concise reply body. Forbid the model from emitting greetings and sign-offs; the wrapper code adds them.
- **F9.** Detect senior senders by substring match in the `From` header against `principal`, `teacher`, `sir`, `ma'am`. Use a more formal greeting and sign-off when matched.
- **F10.** Print each email's result in a fixed-format block to stdout.

## 8. Non-functional requirements

- **N1. Stdlib-only for mail handling.** No `pip install` for IMAP, parsing, or HTTP.
- **N2. Local LLM only.** The Ollama subprocess is the only external dependency at runtime.
- **N3. Windows-safe.** UTF-8 encoding is forced on the Ollama subprocess so non-ASCII content does not crash the CLI.
- **N4. Deterministic classification.** The same email body produces the same category every run.

## 9. Success metrics

| Metric | Target |
|---|---|
| Classification matches user-supplied label | over 90% on a 50-email sample |
| Draft reply usable without edits | over 40% on Work and Networking samples |
| Agent runtime for a 30-email day | under 3 minutes on a 16 GB laptop |
| Crashes per 100 runs (any cause) | 0 |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Gmail rate-limits IMAP for high-volume accounts | Default scope is one day; users with very large inboxes should narrow further |
| App password leaks via shell history or `.env` in version control | `.env.example` and `.gitignore` cover this; document not to commit `.env` |
| Local Ollama is not running | The CLI returns non-zero; the agent raises and exits. README requires Ollama up first |
| Classifier misroutes (e.g., "school project" classified as Work when the sender is HR) | First-match order encodes a priority; Marketing sits last because its keywords are noisy; the default fallback is Work |
| Hard-coded sign-off "Prahaan Sanghvi" | Documented limitation; future work to read from env |

## 11. Open questions

1. Should the agent persist a log of processed UIDs to avoid duplicate work on a re-run?
2. Should classification widen to include "Personal" or "Family"?
3. Should IMAP search support a date range rather than just one day?
