# Deploying the Email Agent

Fully self-hosted, open-source: the LLM is **Ollama**. This is a **scheduled
job**, so it runs on **GitHub Actions cron** (free), with Ollama installed and
run **inside the runner** for each run. No external AI service, no VM, no API key.

See `.github/workflows/agent.yml`.

> Note: Vercel cannot host this (no web server). GitHub Actions runners have
> enough RAM (~16GB) to run a small Ollama model on CPU.

## Steps (GitHub Actions)
1. Push this repo to GitHub.
2. In the repo: **Settings -> Secrets and variables -> Actions -> New repository
   secret**. Add two secrets:
   - `EMAIL_ADDRESS` = the Gmail address to read
   - `APP_PASSWORD` = a Gmail **App Password** (https://myaccount.google.com/apppasswords,
     requires 2-Step Verification)
3. The workflow runs daily at 02:30 UTC. To run it now: **Actions -> Email Agent
   -> Run workflow**. Output appears in the run logs.
4. Each run installs Ollama and pulls `llama3.2:3b` (a small CPU-friendly model).
   Change `LLM_MODEL` in the workflow to use a different model.

## Run locally
```bash
ollama serve &
ollama pull llama3.2:3b
pip install -r requirements.txt
cp .env.example .env   # fill in EMAIL_ADDRESS / APP_PASSWORD
python agent.py
```
