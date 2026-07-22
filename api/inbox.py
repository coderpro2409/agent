"""Vercel Python function for the inbox-agent API."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler

from lib.email_agent import fetch_inbox, get_utc_day_range


class handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._json(405, {"error": "Use POST to fetch inbox data."})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "Invalid JSON request body."})
            return
        email_address = str(payload.get("email") or "").strip()
        app_password = "".join(str(payload.get("appPassword") or "").split())
        if not email_address or not app_password:
            self._json(400, {"error": "Enter a Gmail address and app password."})
            return
        day_range = get_utc_day_range(str(payload.get("date") or "").strip())
        if not day_range:
            self._json(400, {"error": "Choose a valid date."})
            return
        try:
            result = fetch_inbox(
                email_address,
                app_password,
                day_range,
                client_llm=payload.get("clientLLM") is True,
            )
        except Exception as error:  # Function boundary: return a useful API error.
            self._json(500, {"error": f"IMAP/processing error: {error}"})
            return
        self._json(200, result)
