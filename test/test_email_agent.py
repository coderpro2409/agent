from datetime import datetime, timezone
from email.message import EmailMessage
import unittest

from lib.email_agent import (
    classify,
    fallback_summary,
    fetch_inbox,
    format_draft,
    get_utc_day_range,
    normalize_summary,
    parse_message,
)


class EmailAgentTests(unittest.TestCase):
    def test_valid_day_range_is_exactly_one_day(self):
        result = get_utc_day_range("2026-07-18")
        self.assertIsNotNone(result)
        self.assertEqual(result.selected_date, "2026-07-18")
        self.assertEqual((result.end - result.start).total_seconds(), 86_400)

    def test_default_day_uses_utc(self):
        now = datetime(2026, 7, 18, 23, 30, tzinfo=timezone.utc)
        self.assertEqual(get_utc_day_range("", now).selected_date, "2026-07-18")

    def test_rejects_invalid_calendar_dates(self):
        self.assertIsNone(get_utc_day_range("2026-02-30"))
        self.assertIsNone(get_utc_day_range("18-07-2026"))

    def test_classification_and_summary_match_existing_contract(self):
        self.assertEqual(classify("Invoice", "Your bill is ready"), "Payments")
        self.assertEqual(classify("Hello", "Let's connect on LinkedIn"), "Networking")
        self.assertEqual(fallback_summary("One. Two! Three? Four."), "• One.\n• Two!\n• Three?")

    def test_parses_plain_text_message(self):
        message = EmailMessage()
        message["Subject"] = "Project update"
        message["From"] = "Teacher <teacher@example.com>"
        message.set_content("The meeting is tomorrow.")
        parsed = parse_message(message.as_bytes())
        self.assertEqual(parsed["subject"], "Project update")
        self.assertIn("meeting is tomorrow", parsed["body"])

    def test_draft_and_model_summary_are_normalized(self):
        draft = format_draft("Hello,\nPlease send it.\n\nRegards\nSomeone", "Teacher")
        self.assertTrue(draft.startswith("Good Morning Sir/Ma'am,"))
        self.assertTrue(draft.endswith("Regards\nPrahaan Sanghvi"))
        self.assertEqual(normalize_summary(["First", "Second"], ""), "• First\n• Second")

    def test_fetches_every_uid_newest_first(self):
        def source(subject):
            message = EmailMessage()
            message["Subject"] = subject
            message["From"] = "sender@example.com"
            message.set_content("A project meeting update.")
            return message.as_bytes()

        messages = {b"7": source("Oldest"), b"8": source("Middle"), b"9": source("Newest")}

        class FakeImap:
            def __init__(self, *args, **kwargs):
                pass

            def login(self, *args):
                return "OK", []

            def select(self, *args, **kwargs):
                return "OK", []

            def uid(self, command, uid=None, *args):
                if command == "search":
                    return "OK", [b"7 9 8"]
                return "OK", [(b"RFC822", messages[uid])]

            def logout(self):
                return "BYE", []

        result = fetch_inbox(
            "person@example.com",
            "app-password",
            get_utc_day_range("2026-07-18"),
            imap_factory=FakeImap,
        )
        self.assertEqual(result["count"], 3)
        self.assertEqual([item["subject"] for item in result["emails"]], ["Newest", "Middle", "Oldest"])


if __name__ == "__main__":
    unittest.main()
