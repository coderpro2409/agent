"""Python implementation of the inbox agent's deterministic processing.

The browser is intentionally kept as a thin presentation/WebLLM layer.  Gmail
retrieval, MIME parsing, date selection, classification, summaries, and server
model integration live here so they can be tested independently.
"""

from __future__ import annotations

import imaplib
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email import policy
from email.header import decode_header, make_header
from email.message import Message
from email.parser import BytesParser
from html.parser import HTMLParser
from typing import Any, Callable, Iterable


CLIENT_LLM_BODY_LIMIT = 3_500
DATE_PATTERN = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


@dataclass(frozen=True)
class DayRange:
    selected_date: str
    start: datetime
    end: datetime


def get_utc_day_range(value: str | None, now: datetime | None = None) -> DayRange | None:
    """Return an exact, validated UTC calendar-day interval."""

    current = now or datetime.now(timezone.utc)
    selected = (value or "").strip() or current.date().isoformat()
    match = DATE_PATTERN.fullmatch(selected)
    if not match:
        return None
    try:
        day = date(*(int(part) for part in match.groups()))
    except ValueError:
        return None
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return DayRange(selected, start, start + timedelta(days=1))


def classify(subject: str, body: str) -> str:
    text = f"{subject} {body}".lower()
    categories = (
        ("Payments", ("invoice", "payment", "bill", "transaction")),
        ("Internship", ("internship", "application", "hr", "selection")),
        ("Work", ("meeting", "assignment", "project", "submission", "school")),
        ("Networking", ("connect", "linkedin", "network", "collaborate")),
        ("Marketing/Promotion", ("sale", "offer", "discount", "promo", "unsubscribe")),
    )
    # Score every category by keyword-hit count rather than stopping at the
    # first match: a networking email that also mentions "project" should
    # still classify as Networking, not fall into Work by list order alone.
    best_category, best_score = "Work", 0
    for category, keywords in categories:
        score = sum(1 for keyword in keywords if keyword in text)
        if score > best_score:
            best_category, best_score = category, score
    return best_category


def reply_required(category: str) -> bool:
    return category in {"Work", "Networking"}


def is_elder(sender: str) -> bool:
    lowered = (sender or "").lower()
    return any(label in lowered for label in ("principal", "teacher", "sir", "ma'am"))


def fallback_summary(body: str) -> str:
    clean = re.sub(r"\s+", " ", body or "").strip()
    sentences = [part for part in re.split(r"(?<=[.!?])\s+", clean) if part][:3]
    if not sentences:
        return "• (no readable text)"
    return "\n".join(
        f"• {sentence if len(sentence) <= 160 else sentence[:157] + '...'}"
        for sentence in sentences
    )


def format_draft(draft_body: str, sender: str) -> str:
    greeting = "Good Morning Sir/Ma'am," if is_elder(sender) else "Hello,"
    closing = (
        "\nThank You\n\nRegards\nPrahaan Sanghvi"
        if is_elder(sender)
        else "\n\nRegards\nPrahaan Sanghvi"
    )
    clean = str(draft_body or "").strip()
    clean = re.sub(r"^hello,?\s*", "", clean, flags=re.IGNORECASE)
    clean = re.sub(
        r"^good (morning|afternoon|evening)[^\n]*\n+", "", clean, flags=re.IGNORECASE
    )
    clean = re.sub(
        r"\n+(thank you\s*)?regards[\s\S]*$", "", clean, flags=re.IGNORECASE
    )
    return f"{greeting}\n\n{clean.strip()}{closing}"


def local_draft_reply(body: str, sender: str, category: str) -> str:
    text = f"{category} {body or ''}".lower()
    if re.search(r"meeting|meet|call|zoom|calendar|schedule|reschedule|session", text):
        core = (
            "Thank you for sharing the details. I have noted the schedule and will be "
            "available accordingly. Please let me know if there is anything specific I "
            "should prepare beforehand."
        )
    elif re.search(r"assignment|project|submission|deadline|task|work", text):
        core = (
            "Thank you for sharing the details. I have noted the requirements and timeline, "
            "and I will work on this accordingly. I will reach out if I need any clarification."
        )
    elif re.search(r"connect|linkedin|network|collaborate|collaboration", text):
        core = (
            "Thank you for reaching out. I would be happy to connect and discuss this further. "
            "Please share a suitable time or the next steps."
        )
    elif re.search(r"interview|internship|application|selected|shortlisted|hr", text):
        core = (
            "Thank you for the update. I appreciate the opportunity and have noted the details. "
            "Please let me know the next steps or any information needed from my side."
        )
    else:
        core = (
            "Thank you for your email. I have gone through the message and will take the required "
            "next steps. Please let me know if anything else is needed from my side."
        )
    return format_draft(core, sender)


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.parts)).strip()


def _decode_header(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value))).strip()
    except (LookupError, UnicodeError):
        return value.strip()


def _decode_payload(part: Message) -> str:
    payload = part.get_payload(decode=True)
    if payload is None:
        raw = part.get_payload()
        return raw if isinstance(raw, str) else ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def extract_message_body(message: Message) -> str:
    """Prefer readable text/plain, with HTML as a safe fallback."""

    plain_parts: list[str] = []
    html_parts: list[str] = []
    parts: Iterable[Message] = message.walk() if message.is_multipart() else (message,)
    for part in parts:
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        content_type = part.get_content_type()
        if content_type == "text/plain":
            plain_parts.append(_decode_payload(part))
        elif content_type == "text/html":
            html_parts.append(_decode_payload(part))
    text = "\n".join(plain_parts).strip()
    if text:
        return text
    parser = _TextExtractor()
    parser.feed("\n".join(html_parts))
    return parser.text()


def parse_message(source: bytes) -> dict[str, str]:
    message = BytesParser(policy=policy.default).parsebytes(source)
    return {
        "subject": _decode_header(message.get("subject")) or "(no subject)",
        "sender": _decode_header(message.get("from")),
        "body": extract_message_body(message).strip(),
    }


def parse_json_object(text: str) -> dict[str, Any] | None:
    cleaned = re.sub(r"^```(?:json)?\s*", "", str(text or "").strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"```$", "", cleaned).strip()
    candidates = [cleaned]
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        candidates.append(cleaned[start : end + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def normalize_summary(value: Any, body: str) -> str:
    if isinstance(value, list):
        source = value
    else:
        source = re.split(r"\n+", str(value or ""))
    bullets = []
    for line in source:
        clean = re.sub(r"^[-*•\d.)\s]+", "", str(line or "")).strip()
        clean = re.sub(r"\s+", " ", clean)
        if clean:
            bullets.append(clean[:177] + "..." if len(clean) > 180 else clean)
        if len(bullets) == 3:
            break
    return "\n".join(f"• {line}" for line in bullets) if bullets else fallback_summary(body)


def _provider_settings() -> tuple[str, str, str, str, bool, float]:
    provider = os.getenv("OPEN_MODEL_PROVIDER", "local").lower()
    presets = {
        "local": ("", "local-rules", ""),
        "groq": (
            "https://api.groq.com/openai/v1/chat/completions",
            "llama-3.1-8b-instant",
            os.getenv("GROQ_API_KEY", ""),
        ),
        "together": (
            "https://api.together.xyz/v1/chat/completions",
            "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
            os.getenv("TOGETHER_API_KEY", ""),
        ),
        "openrouter": (
            "https://openrouter.ai/api/v1/chat/completions",
            "meta-llama/llama-3.1-8b-instruct",
            os.getenv("OPENROUTER_API_KEY", ""),
        ),
        "custom": ("", "llama3.1:8b", ""),
    }
    preset_url, preset_model, preset_key = presets.get(provider, presets["local"])
    url = os.getenv("OPEN_MODEL_URL", preset_url)
    model = os.getenv("OPEN_MODEL_NAME", preset_model)
    api_key = os.getenv("OPEN_MODEL_API_KEY", preset_key)
    enabled = bool(url and (api_key or os.getenv("OPEN_MODEL_ALLOW_NO_AUTH") == "true"))
    timeout = max(1.0, int(os.getenv("OPEN_MODEL_TIMEOUT_MS", "20000")) / 1000)
    return provider, url, model, api_key, enabled, timeout


def open_model_chat(messages: list[dict[str, str]], max_tokens: int) -> str:
    _, url, model, api_key, enabled, timeout = _provider_settings()
    if not enabled:
        return ""
    payload = json.dumps(
        {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens}
    ).encode()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    choices = data.get("choices") or []
    first = choices[0] if choices else {}
    return str(
        (first.get("message") or {}).get("content")
        or first.get("text")
        or (data.get("message") or {}).get("content")
        or data.get("response")
        or ""
    ).strip()


def open_model_analyze_email(body: str, sender: str, category: str, needs_reply: bool) -> dict[str, str]:
    model_text = open_model_chat(
        [
            {
                "role": "system",
                "content": (
                    "You summarize emails and draft concise professional replies. Return only valid JSON. "
                    "Do not include markdown."
                ),
            },
            {
                "role": "user",
                "content": f'''Return JSON with keys "summary" and "draft_body".
"summary" must be an array of 2-3 short bullet strings.
"draft_body" must be only the body of a reply, with no greeting and no sign-off. If no reply is required, use an empty string.

Sender: {sender or "(unknown)"}
Category: {category}
Reply required: {"yes" if needs_reply else "no"}

Email:
{str(body or "")[:6000]}''',
            },
        ],
        650 if needs_reply else 350,
    )
    parsed = parse_json_object(model_text)
    if not parsed:
        raise ValueError("Open model did not return JSON")
    draft_body = str(parsed.get("draft_body") or parsed.get("draft") or parsed.get("reply") or "").strip()
    return {
        "summary": normalize_summary(parsed.get("summary"), body),
        "draft": format_draft(draft_body, sender) if needs_reply and draft_body else "Not required",
    }


def _imap_date(value: datetime) -> str:
    return value.strftime("%d-%b-%Y")


def _source_from_fetch(data: list[Any]) -> bytes | None:
    for item in data or []:
        if isinstance(item, tuple) and len(item) > 1 and isinstance(item[1], bytes):
            return item[1]
    return None


def fetch_inbox(
    email_address: str,
    app_password: str,
    day_range: DayRange,
    client_llm: bool = False,
    imap_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Fetch every INBOX message for the selected day, newest first."""

    host = os.getenv("IMAP_SERVER", "imap.gmail.com")
    port = int(os.getenv("IMAP_PORT", "993"))
    provider, _, model, _, server_model_enabled, _ = _provider_settings()
    use_server_model = server_model_enabled and not client_llm
    used_open_model = False
    used_local_fallback = False
    results: list[dict[str, Any]] = []
    imap = (imap_factory or imaplib.IMAP4_SSL)(host, port, timeout=30)
    try:
        imap.login(email_address, app_password)
        status, _ = imap.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("Unable to open INBOX")
        status, payload = imap.uid(
            "search",
            None,
            "SINCE",
            _imap_date(day_range.start),
            "BEFORE",
            _imap_date(day_range.end),
        )
        if status != "OK":
            raise RuntimeError("Unable to search INBOX")
        raw_uids = payload[0].split() if payload and payload[0] else []
        uids = sorted(raw_uids, key=lambda uid: int(uid), reverse=True)
        for uid in uids:
            status, fetched = imap.uid("fetch", uid, "(BODY.PEEK[])")
            if status != "OK":
                continue
            source = _source_from_fetch(fetched)
            if not source:
                continue
            parsed = parse_message(source)
            category = classify(parsed["subject"], parsed["body"])
            needs_reply = reply_required(category)
            if use_server_model:
                try:
                    modeled = open_model_analyze_email(
                        parsed["body"], parsed["sender"], category, needs_reply
                    )
                    summary = modeled["summary"]
                    draft = modeled["draft"]
                    if needs_reply and draft == "Not required":
                        draft = local_draft_reply(parsed["body"], parsed["sender"], category)
                    used_open_model = True
                except (ValueError, OSError, TimeoutError, urllib.error.URLError):
                    summary = fallback_summary(parsed["body"])
                    draft = (
                        local_draft_reply(parsed["body"], parsed["sender"], category)
                        if needs_reply
                        else "Not required"
                    )
                    used_local_fallback = True
            else:
                summary = fallback_summary(parsed["body"])
                draft = (
                    local_draft_reply(parsed["body"], parsed["sender"], category)
                    if needs_reply
                    else "Not required"
                )
                used_local_fallback = True
            item: dict[str, Any] = {
                "subject": parsed["subject"],
                "sender": parsed["sender"],
                "category": category,
                "needsReply": needs_reply,
                "summary": summary,
                "draft": draft,
            }
            if client_llm:
                item["content"] = parsed["body"][:CLIENT_LLM_BODY_LIMIT]
            results.append(item)
    finally:
        try:
            imap.logout()
        except (imaplib.IMAP4.error, OSError):
            pass
    if used_open_model:
        llm = f"{provider}: {model}" + (" + local fallback" if used_local_fallback else "")
    else:
        llm = "browser LLM pending" if client_llm else "local no-key"
    return {
        "date": day_range.selected_date,
        "count": len(results),
        "llm": llm,
        "emails": results,
    }
