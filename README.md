# Inbox Agent

Vercel app that asks each visitor for their Gmail address and Gmail app password, reads that day's inbox over IMAP, summarizes messages, classifies them, and drafts replies.

## No-key setup

No AI API key or AI environment variable is required. By default, the app uses local rules for classification and summarization plus local reply templates. This mode is not a generative LLM, but it keeps the app working without depending on an external model service.

On Vercel, either leave `OPEN_MODEL_PROVIDER` unset or set:

```text
OPEN_MODEL_PROVIDER=local
```

Do not add `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, or any other AI key.

## Optional open-source LLM

An actual Llama, Mistral, Qwen, or Gemma model needs to run somewhere outside the Vercel serverless function. If an API key or a self-hosted endpoint becomes available later, the app can use it and will still fall back to local mode if that service fails.

Example Groq configuration:

```text
OPEN_MODEL_PROVIDER=groq
OPEN_MODEL_NAME=llama-3.1-8b-instant
GROQ_API_KEY=your_groq_key
```

Other open-model options:

- Self-hosted vLLM or Ollama exposed at `/v1/chat/completions`
- Together/OpenRouter with a Llama, Mistral, Qwen, or Gemma model
- Any other OpenAI-compatible server running an open model

For a custom/self-hosted endpoint:

```text
OPEN_MODEL_PROVIDER=custom
OPEN_MODEL_URL=https://your-model-host.example.com/v1/chat/completions
OPEN_MODEL_NAME=your-model-name
OPEN_MODEL_API_KEY=your-host-token-if-needed
OPEN_MODEL_ALLOW_NO_AUTH=false
```

Set `OPEN_MODEL_ALLOW_NO_AUTH=true` only for a private self-hosted endpoint that intentionally does not require a bearer token.

## Vercel env vars

Required: none for AI.

Optional:

```text
OPEN_MODEL_PROVIDER
OPEN_MODEL_URL
OPEN_MODEL_NAME
OPEN_MODEL_API_KEY
GROQ_API_KEY
TOGETHER_API_KEY
OPENROUTER_API_KEY
OPEN_MODEL_ALLOW_NO_AUTH
OPEN_MODEL_TIMEOUT_MS
IMAP_SERVER
IMAP_PORT
```

Do not set Gmail email or Gmail app password in Vercel. Users enter those on the page for their own session/request.
