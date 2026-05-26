"""
Email Agent — IMAP + Ollama CLI

Fetches Gmail messages for a given day over IMAP, classifies each one with
simple keyword rules, and uses a local Ollama model (via its CLI, no HTTP)
to produce a 2–3 bullet summary and a draft reply when one is warranted.

Credentials are read from environment variables (see .env.example).
"""

import imaplib
import email
import os
import sys
from email.header import decode_header
from datetime import datetime
import subprocess

# ------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------

IMAP_SERVER = os.getenv("IMAP_SERVER", "imap.gmail.com")
IMAP_PORT = int(os.getenv("IMAP_PORT", "993"))
EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS")
APP_PASSWORD = os.getenv("APP_PASSWORD")

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")


def _require_env():
    missing = [k for k in ("EMAIL_ADDRESS", "APP_PASSWORD") if not os.getenv(k)]
    if missing:
        sys.exit(
            "Missing required environment variables: "
            + ", ".join(missing)
            + ". See .env.example."
        )

# ============================================================
# OLLAMA CALL (CLI ONLY — NO URL)
# ============================================================

def ollama_generate(prompt):
    """
    Calls Ollama via CLI using UTF-8 encoding (Windows-safe).
    """
    process = subprocess.run(
        ["ollama", "run", OLLAMA_MODEL],
        input=prompt,
        text=True,
        encoding="utf-8",          # ✅ FORCE UTF-8
        errors="ignore",           # ✅ Prevent crashes on bad chars
        capture_output=True
    )

    if process.returncode != 0:
        raise RuntimeError(process.stderr)

    return process.stdout.strip()


# ============================================================
# EMAIL CLASSIFICATION (RULE-BASED)
# ============================================================

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

# ============================================================
# IMAP FETCH (SPECIFIC DAY)
# ============================================================

def fetch_emails_for_day(date):
    mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
    mail.login(EMAIL_ADDRESS, APP_PASSWORD)
    mail.select("inbox")

    date_str = date.strftime("%d-%b-%Y")
    status, data = mail.search(None, f'(ON "{date_str}")')

    messages = []
    for num in data[0].split():
        _, msg_data = mail.fetch(num, "(RFC822)")
        msg = email.message_from_bytes(msg_data[0][1])
        messages.append(msg)

    mail.logout()
    return messages

# ============================================================
# EMAIL PARSER
# ============================================================

def parse_email(msg):
    subject, encoding = decode_header(msg.get("Subject"))[0]
    subject = (
        subject.decode(encoding or "utf-8", errors="ignore")
        if isinstance(subject, bytes)
        else subject
    )

    sender = msg.get("From")

    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(part.get("Content-Disposition")):
                body = part.get_payload(decode=True).decode("utf-8", errors="ignore")
                break
    else:
        body = msg.get_payload(decode=True).decode("utf-8", errors="ignore")

    return subject.strip(), sender.strip(), body.strip()

# ============================================================
# SUMMARIZATION (2–3 LINES ONLY)
# ============================================================

def summarize_email(body):
    prompt = f"""
Summarize the following email in EXACTLY 2–3 bullet points.
Rules:
- No assumptions
- No added information

Email:
{body}
"""
    return ollama_generate(prompt)

# ============================================================
# REPLY LOGIC
# ============================================================

def reply_required(category):
    return category in ["Work", "Networking"]

def is_elder_professional(sender):
    keywords = ["principal", "teacher", "sir", "ma'am"]
    return any(k in sender.lower() for k in keywords)

def generate_reply(body, sender, category):
    if category not in ["Work", "Networking"]:
        return "Not required"

    if is_elder_professional(sender):
        greeting = "Good Morning Sir/Ma'am,"
        closing = "\nThank You\n\nRegards\nPrahaan Sanghvi"
    else:
        greeting = "Hello,"
        closing = "\n\nRegards\nPrahaan Sanghvi"

    prompt = f"""
Write a professional and concise reply to the email below.
Rules:
- Polite
- Clear
- No emojis
- Do NOT include greetings or sign-offs

Email:
{body}
"""

    reply_body = ollama_generate(prompt)
    return f"{greeting}\n\n{reply_body}{closing}"

# ============================================================
# OUTPUT FORMATTER (EXACT — DO NOT TOUCH)
# ============================================================

def format_output(category, summary, reply_needed, draft):
    print(f"""
Email Category:
{category}

Summary:
{summary if summary else "Not required"}

Reply Required:
{"Yes" if reply_needed else "No"}

Draft Reply:
{draft}
""")

# ============================================================
# MAIN AGENT
# ============================================================

def run_email_agent(date):
    emails = fetch_emails_for_day(date)

    for msg in emails:
        subject, sender, body = parse_email(msg)
        category = classify_email(subject, body)

        summary = None
        if category != "Marketing/Promotion":
            summary = summarize_email(body)

        draft = generate_reply(body, sender, category)
        format_output(category, summary, reply_required(category), draft)

# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":
    _require_env()
    run_email_agent(datetime.today())
