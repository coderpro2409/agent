// Serverless email agent: fetch a day's Gmail over IMAP, classify, summarize,
// and draft replies. It can call an OpenAI-compatible open model endpoint
// and falls back to local no-key templates if the endpoint is not configured.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const IMAP_SERVER = process.env.IMAP_SERVER || "imap.gmail.com";
const IMAP_PORT = parseInt(process.env.IMAP_PORT || "993", 10);
const MAX_EMAILS = 15;
const CLIENT_LLM_BODY_LIMIT = 3500;
const OPEN_MODEL_PROVIDER = (process.env.OPEN_MODEL_PROVIDER || "local").toLowerCase();
const OPEN_MODEL_PRESETS = {
  local: { url: "", model: "local-rules", apiKey: "" },
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.1-8b-instant",
    apiKey: process.env.GROQ_API_KEY || "",
  },
  together: {
    url: "https://api.together.xyz/v1/chat/completions",
    model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    apiKey: process.env.TOGETHER_API_KEY || "",
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "meta-llama/llama-3.1-8b-instruct",
    apiKey: process.env.OPENROUTER_API_KEY || "",
  },
  custom: { url: "", model: "llama3.1:8b", apiKey: "" },
};
const OPEN_MODEL_PRESET = OPEN_MODEL_PRESETS[OPEN_MODEL_PROVIDER] || OPEN_MODEL_PRESETS.local;
const OPEN_MODEL_URL = process.env.OPEN_MODEL_URL || OPEN_MODEL_PRESET.url;
const OPEN_MODEL_NAME = process.env.OPEN_MODEL_NAME || OPEN_MODEL_PRESET.model;
const OPEN_MODEL_API_KEY = process.env.OPEN_MODEL_API_KEY || OPEN_MODEL_PRESET.apiKey || "";
const OPEN_MODEL_ALLOW_NO_AUTH = process.env.OPEN_MODEL_ALLOW_NO_AUTH === "true";
const OPEN_MODEL_ENABLED = Boolean(OPEN_MODEL_URL && (OPEN_MODEL_API_KEY || OPEN_MODEL_ALLOW_NO_AUTH));
const OPEN_MODEL_TIMEOUT_MS = parseInt(process.env.OPEN_MODEL_TIMEOUT_MS || "20000", 10);

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
  return sentences.map((s) => "• " + (s.length > 160 ? s.slice(0, 157) + "..." : s)).join("\n");
}

function formatDraft(draftBody, sender) {
  const greeting = isElder(sender) ? "Good Morning Sir/Ma'am," : "Hello,";
  const closing = isElder(sender) ? "\nThank You\n\nRegards\nPrahaan Sanghvi" : "\n\nRegards\nPrahaan Sanghvi";
  let clean = String(draftBody || "").trim();
  clean = clean.replace(/^hello,?\s*/i, "");
  clean = clean.replace(/^good (morning|afternoon|evening)[^\n]*\n+/i, "");
  clean = clean.replace(/\n+(thank you\s*)?regards[\s\S]*$/i, "");
  return `${greeting}\n\n${clean.trim()}${closing}`;
}

function localDraftReply(body, sender, category) {
  const text = `${category} ${body || ""}`.toLowerCase();

  let core;
  if (/(meeting|meet|call|zoom|calendar|schedule|reschedule|session)/.test(text)) {
    core = "Thank you for sharing the details. I have noted the schedule and will be available accordingly. Please let me know if there is anything specific I should prepare beforehand.";
  } else if (/(assignment|project|submission|deadline|task|work)/.test(text)) {
    core = "Thank you for sharing the details. I have noted the requirements and timeline, and I will work on this accordingly. I will reach out if I need any clarification.";
  } else if (/(connect|linkedin|network|collaborate|collaboration)/.test(text)) {
    core = "Thank you for reaching out. I would be happy to connect and discuss this further. Please share a suitable time or the next steps.";
  } else if (/(interview|internship|application|selected|shortlisted|hr)/.test(text)) {
    core = "Thank you for the update. I appreciate the opportunity and have noted the details. Please let me know the next steps or any information needed from my side.";
  } else {
    core = "Thank you for your email. I have gone through the message and will take the required next steps. Please let me know if anything else is needed from my side.";
  }

  return formatDraft(core, sender);
}

async function openModelChat(messages, maxTokens) {
  if (!OPEN_MODEL_ENABLED) return "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPEN_MODEL_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json" };
  if (OPEN_MODEL_API_KEY) headers.Authorization = `Bearer ${OPEN_MODEL_API_KEY}`;

  try {
    const response = await fetch(OPEN_MODEL_URL, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: OPEN_MODEL_NAME,
        messages,
        temperature: 0.2,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      throw new Error(`Open model endpoint returned HTTP ${response.status}`);
    }

    const data = await response.json();
    return String(
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      data?.message?.content ||
      data?.response ||
      "",
    ).trim();
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonObject(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeSummary(value, body) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/\n+/)
        .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
        .filter(Boolean);

  const bullets = source
    .map((line) => String(line || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 3);

  if (!bullets.length) return fallbackSummary(body);
  return bullets.map((line) => "• " + (line.length > 180 ? line.slice(0, 177) + "..." : line)).join("\n");
}

async function openModelAnalyzeEmail(body, sender, category, needsReply) {
  const text = String(body || "").slice(0, 6000);
  const modelText = await openModelChat([
    {
      role: "system",
      content: "You summarize emails and draft concise professional replies. Return only valid JSON. Do not include markdown.",
    },
    {
      role: "user",
      content: `Return JSON with keys "summary" and "draft_body".
"summary" must be an array of 2-3 short bullet strings.
"draft_body" must be only the body of a reply, with no greeting and no sign-off. If no reply is required, use an empty string.

Sender: ${sender || "(unknown)"}
Category: ${category}
Reply required: ${needsReply ? "yes" : "no"}

Email:
${text}`,
    },
  ], needsReply ? 650 : 350);

  const parsed = parseJsonObject(modelText);
  if (!parsed) throw new Error("Open model did not return JSON");

  const summary = normalizeSummary(parsed.summary, body);
  const draftBody = String(parsed.draft_body || parsed.draft || parsed.reply || "").trim();
  const draft = needsReply && draftBody ? formatDraft(draftBody, sender) : "Not required";
  return { summary, draft };
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
  const clientLlm = body.clientLLM === true;
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

  const imap = new ImapFlow({
    host: IMAP_SERVER, port: IMAP_PORT, secure: true,
    auth: { user: emailAddress, pass: appPassword }, logger: false,
  });

  const results = [];
  const useServerModel = OPEN_MODEL_ENABLED && !clientLlm;
  let usedOpenModel = false;
  let usedLocalFallback = false;
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

        let summary;
        let draft;
        if (useServerModel) {
          try {
            const modeled = await openModelAnalyzeEmail(body, sender, category, needsReply);
            summary = modeled.summary;
            draft = needsReply && modeled.draft !== "Not required"
              ? modeled.draft
              : (needsReply ? localDraftReply(body, sender, category) : "Not required");
            usedOpenModel = true;
          } catch {
            summary = fallbackSummary(body);
            draft = needsReply ? localDraftReply(body, sender, category) : "Not required";
            usedLocalFallback = true;
          }
        } else {
          summary = fallbackSummary(body);
          draft = needsReply ? localDraftReply(body, sender, category) : "Not required";
          usedLocalFallback = true;
        }
        results.push({
          subject,
          sender,
          category,
          needsReply,
          summary,
          draft,
          ...(clientLlm ? { content: body.slice(0, CLIENT_LLM_BODY_LIMIT) } : {}),
        });
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
    llm: usedOpenModel
      ? `${OPEN_MODEL_PROVIDER}: ${OPEN_MODEL_NAME}${usedLocalFallback ? " + local fallback" : ""}`
      : (clientLlm ? "browser LLM pending" : "local no-key"),
    emails: results,
  });
}
