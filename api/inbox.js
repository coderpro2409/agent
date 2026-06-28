// Serverless email agent: fetch a day's Gmail over IMAP, classify, summarize,
// and draft replies. Ported from the original agent.py. LLM (Anthropic) is
// optional — without a key it falls back to a simple extractive summary.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import Anthropic from "@anthropic-ai/sdk";

const IMAP_SERVER = process.env.IMAP_SERVER || "imap.gmail.com";
const IMAP_PORT = parseInt(process.env.IMAP_PORT || "993", 10);
const MAX_EMAILS = 15;

function classify(subject, body) {
  const t = `${subject} ${body}`.toLowerCase();
  const has = (arr) => arr.some((k) => t.includes(k));
  if (has(["invoice", "payment", "bill", "transaction"])) return "Payments";
  if (has(["internship", "application", "hr", "selection"])) return "Internship";
  if (has(["meeting", "assignment", "project", "submission", "school"])) return "Work";
  if (has(["connect", "linkedin", "network", "collaborate"])) return "Networking";
  if (has(["sale", "offer", "discount", "promo", "unsubscribe"])) return "Marketing/Promotion";
  return "Work";
}

const replyRequired = (cat) => cat === "Work" || cat === "Networking";
const isElder = (sender) =>
  ["principal", "teacher", "sir", "ma'am"].some((k) => (sender || "").toLowerCase().includes(k));

function fallbackSummary(body) {
  const clean = (body || "").replace(/\s+/g, " ").trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3);
  if (!sentences.length) return "• (no readable text)";
  return sentences.map((s) => "• " + (s.length > 160 ? s.slice(0, 157) + "…" : s)).join("\n");
}

async function llmSummary(client, body) {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `Summarize the following email in EXACTLY 2-3 bullet points. No assumptions, no added information.\n\nEmail:\n${body.slice(0, 6000)}`,
    }],
  });
  return (msg.content[0]?.text || "").trim();
}

async function llmReply(client, body, sender, category) {
  const greeting = isElder(sender) ? "Good Morning Sir/Ma'am," : "Hello,";
  const closing = isElder(sender) ? "\nThank You\n\nRegards\nPrahaan Sanghvi" : "\n\nRegards\nPrahaan Sanghvi";
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Write a professional and concise reply to the email below. Polite, clear, no emojis. Do NOT include greetings or sign-offs.\n\nEmail:\n${body.slice(0, 6000)}`,
    }],
  });
  return `${greeting}\n\n${(msg.content[0]?.text || "").trim()}${closing}`;
}

export default async function handler(req, res) {
  // --- access gate (refuse if no password configured: never expose email openly) ---
  const required = process.env.ACCESS_PASSWORD;
  if (!required) {
    return res.status(503).json({ error: "Server not configured: set ACCESS_PASSWORD (and EMAIL_ADDRESS / APP_PASSWORD) env vars." });
  }
  const provided = req.headers["x-access-key"] || "";
  if (provided !== required) return res.status(401).json({ error: "Invalid access key." });

  const EMAIL_ADDRESS = process.env.EMAIL_ADDRESS;
  const APP_PASSWORD = (process.env.APP_PASSWORD || "").replace(/\s/g, "");
  if (!EMAIL_ADDRESS || !APP_PASSWORD) {
    return res.status(503).json({ error: "Missing EMAIL_ADDRESS / APP_PASSWORD env vars." });
  }

  // date: ?date=YYYY-MM-DD, default today
  const dateParam = (req.query?.date || "").trim();
  const day = dateParam ? new Date(dateParam + "T00:00:00") : new Date();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());

  const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

  const imap = new ImapFlow({
    host: IMAP_SERVER, port: IMAP_PORT, secure: true,
    auth: { user: EMAIL_ADDRESS, pass: APP_PASSWORD }, logger: false,
  });

  const results = [];
  try {
    await imap.connect();
    const lock = await imap.getMailboxLock("INBOX");
    try {
      let uids = await imap.search({ since: start });
      if (!Array.isArray(uids)) uids = [];
      uids = uids.slice(-MAX_EMAILS).reverse();
      for (const uid of uids) {
        const m = await imap.fetchOne(uid, { source: true });
        if (!m || !m.source) continue;
        const parsed = await simpleParser(m.source);
        const subject = (parsed.subject || "(no subject)").trim();
        const sender = (parsed.from?.text || "").trim();
        const body = (parsed.text || parsed.html?.replace(/<[^>]+>/g, " ") || "").trim();
        const category = classify(subject, body);
        const needsReply = replyRequired(category);

        let summary, draft;
        if (anthropic) {
          summary = await llmSummary(anthropic, body);
          draft = needsReply ? await llmReply(anthropic, body, sender, category) : "Not required";
        } else {
          summary = fallbackSummary(body);
          draft = needsReply
            ? `${isElder(sender) ? "Good Morning Sir/Ma'am," : "Hello,"}\n\n[Add an LLM key (ANTHROPIC_API_KEY) for auto-drafted replies.]\n\nRegards\nPrahaan Sanghvi`
            : "Not required";
        }
        results.push({ subject, sender, category, needsReply, summary, draft });
      }
    } finally {
      lock.release();
    }
    await imap.logout();
  } catch (err) {
    try { await imap.logout(); } catch {}
    return res.status(500).json({ error: "IMAP/processing error: " + (err?.message || String(err)) });
  }

  return res.status(200).json({
    date: start.toISOString().slice(0, 10),
    count: results.length,
    llm: anthropic ? "claude-haiku-4-5" : "fallback (no key)",
    emails: results,
  });
}
