# Email Agent: PRD

## The annoying problem

Email triage takes me about 40 minutes a day. Most of the work is repetitive: figure out what kind of email this is, decide if it needs a reply, draft one if yes. The third-party assistants that automate this (Superhuman, Shortwave, Gmail's smart replies) all require giving someone else full inbox access, which I don't want to do for personal mail.

So this is a small Python script that does the same thing locally. IMAP to fetch, keyword rules to classify, local Ollama to summarize and draft. Nothing leaves my machine except the IMAP connection to Gmail itself.

## What it does

For every email I receive on a given day (defaults to today), the agent:

1. Pulls the message over IMAP.
2. Classifies it into one of five buckets using a keyword match: Payments, Internship, Work, Networking, Marketing/Promotion. Anything that doesn't match falls through to Work (the most common case for me).
3. If it's not Marketing, summarizes it in 2-3 bullets via local Ollama.
4. If it's Work or Networking, drafts a reply (also local Ollama). The agent adds the greeting and sign-off; the model only writes the body. If the sender looks like a senior professional (`principal`, `teacher`, `sir`, `ma'am` in the From header), it uses a more formal greeting.
5. Prints a structured block per email. I copy whatever drafts are usable, paste into Gmail, edit, send.

The agent never sends mail. It only drafts.

## What it doesn't do

- Multi-account. One Gmail address per run.
- Threading. Each message is processed standalone.
- Attachments. Ignored.
- ML classification. The keyword rules are auditable and predictable, which I value more than the small accuracy gain a classifier would give me.
- HTML bodies. Plain text only. Most of the mail that matters has a plain-text part anyway.

## The classifier rules

First match wins. Order matters because the keyword sets overlap.

1. **Payments**: invoice, payment, bill, transaction. Never replied to.
2. **Internship**: internship, application, hr, selection. Never replied to (I respond manually because the stakes are higher per message).
3. **Work**: meeting, assignment, project, submission, school. Summarize and draft.
4. **Networking**: connect, linkedin, network, collaborate. Summarize and draft.
5. **Marketing/Promotion**: sale, offer, discount, promo, unsubscribe. Skipped entirely.
6. Default: treat as Work. About 5% of my mail in practice.

Marketing sits last on purpose. "Offer" and "sale" appear in legitimate work mail more often than you'd think ("we can offer you a meeting on Tuesday"). Putting Marketing earlier would steal them.

## Goals for v1

- Read all of today's inbox.
- Classify deterministically. Same input, same category, every time.
- Generate summaries and drafts locally, without an internet round-trip past Gmail.
- Print results to stdout in a stable format.
- Crash zero times across normal runs.

## Non-goals

- Sending replies.
- Persisting state. A re-run reprocesses the same messages; this is fine for now.
- A daemon. The agent runs once and exits.

## What success looks like

The numbers I care about:

- Classification matches what I'd label myself, 90%+ of the time. Measured on a 50-email sample.
- Drafts I can send without editing, 40%+ for Work and Networking. Most of the value is in the others where I edit a sentence; even a half-written reply saves me time.
- Whole-day run under 3 minutes on a 16 GB laptop.
- Zero crashes.

## Risks I'm aware of

The app password is the obvious one. It lives in `.env`, gitignored. `.env.example` ships in the repo so the wiring is obvious. If `.env` ever ends up committed, I rotate the app password.

Gmail's IMAP isn't friendly to high-volume polling. I haven't hit a rate limit at one-pull-per-day, but heavier use would.

If Ollama isn't running, the subprocess returns non-zero and the agent crashes mid-loop. I should wrap each message's pipeline in try/except so one bad call doesn't kill the run.

The sign-off is hardcoded "Prahaan Sanghvi". Should be an env var; that's the most obvious follow-up.

## Open

- Should I persist processed UIDs to skip re-work on a re-run? Probably yes. A small JSON file would do.
- Should the classifier widen to include Personal or Family? I haven't needed it.
- Date range, not just one day? Maybe. Not pressing.
