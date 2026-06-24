# Deploying the Email Agent

This is a **scheduled job**, not a web app, so it runs on **GitHub Actions cron**
(free). See `.github/workflows/agent.yml`.

> Note: Vercel cannot host this. There's no web server, and it used a local
> Ollama model. It now calls an open-weight model via the **Hugging Face
> Inference API** (open-source, no proprietary service).

## Steps (GitHub Actions)
1. Push this repo to GitHub.
2. In the repo: **Settings → Secrets and variables → Actions → New repository secret**.
   Add three secrets:
   - `EMAIL_ADDRESS` = the Gmail address to read
   - `APP_PASSWORD` = a Gmail **App Password** (https://myaccount.google.com/apppasswords,
     requires 2-Step Verification)
   - `HF_TOKEN` = token from https://huggingface.co/settings/tokens
3. The workflow runs daily at 02:30 UTC. To run it now: **Actions → Email Agent
   → Run workflow**. Output appears in the run logs.
4. Change the schedule by editing the `cron:` line in the workflow file.

## Run locally
```bash
pip install -r requirements.txt
cp .env.example .env   # fill in the values
python agent.py
```
