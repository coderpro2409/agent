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

async function readJsonBody(req) {
  if (req.body) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST to fetch inbox data." });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return res.status(400).json({ error: "Invalid JSON request body." });
  }

  const emailAddress = String(body.email || "").trim();
  const appPassword = String(body.appPassword || "").replace(/\s/g, "");
  if (!emailAddress || !appPassword) {
    return res.status(400).json({ error: "Enter a Gmail address and app password." });
  }

  // date: YYYY-MM-DD, default today
  const dateParam = String(body.date || "").trim();
  const day = dateParam ? new Date(dateParam + "T00:00:00") : new Date();
  if (Number.isNaN(day.getTime())) {
    return res.status(400).json({ error: "Choose a valid date." });
  }
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());

  const anthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

  const imap = new ImapFlow({
    host: IMAP_SERVER, port: IMAP_PORT, secure: true,
    auth: { user: emailAddress, pass: appPassword }, logger: false,
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
