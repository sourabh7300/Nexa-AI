# ✦ Nexa AI

[![CI](https://github.com/sourabh7300/Nexa-AI/actions/workflows/ci.yml/badge.svg)](https://github.com/sourabh7300/Nexa-AI/actions/workflows/ci.yml)

Your all-in-one AI workspace — a Google-signed-in chat app with streaming replies, file & image understanding, web search with citations, and automatic AI-provider failover.

Built by **Sourabh Singh** · [sourabh7300.github.io](https://sourabh7300.github.io)

## What it does

- **Optional Google sign-in** — set `GOOGLE_CLIENT_ID` to require verified Google logins (signed HttpOnly cookies; `sourabh73003@gmail.com` gets the owner role). Without it, the app runs as a **public chat** — anyone can use it, rate-limited per IP.
- **Two AI engines, zero downtime** — Groq (`openai/gpt-oss-20b`) is primary, Gemini (`gemini-3.6-flash`) is backup. If a provider is busy or a key dies, Nexa silently retries the other one. The failover was battle-tested: with a dead Groq key the app kept answering via Gemini.
- **Streaming answers** — replies stream token-by-token over Server-Sent Events, with Markdown, headings, lists and code blocks rendered.
- **Attachments** — text/Markdown/CSV/JSON up to 10k chars, plus PDF and PNG/JPG/WEBP images up to 3 MB (vision via Gemini).
- **Web search** — Groq browser search or Gemini Google Search grounding, with source links extracted from both tool results and the answer body.
- **Modes & workspaces** — Quick answer vs Deep thinking; AI Chat / Coding / Study / Writing / Business / Voice sections send tuned system instructions.
- **Per-account rate limits** — 20 chats/minute, 200/day (per process).
- **Hardened static serving** — only `index.html` is ever served; `.env`, OAuth client secrets and source files are not reachable over HTTP.

## Quick start (local)

1. Copy `.env.example` to `.env` and add a free [Groq](https://console.groq.com) key (`GROQ_API_KEY`). A [Gemini](https://aistudio.google.com) key is the optional backup.
2. Double-click **`Start-Nexa.cmd`** — it starts the server and opens http://localhost:3000.
3. To save a Groq key without pasting it into a visible terminal, run **`Save-Groq-Key.cmd`** (hidden input).
4. To turn on Google login, put your Web OAuth client ID in `.env` as `GOOGLE_CLIENT_ID` and add `http://localhost:3000` to its Authorized JavaScript origins. Full steps: `SETUP.txt`.

Without `GOOGLE_CLIENT_ID` the app is a public, rate-limited chat. With it, chat requires a verified Google account.

## Deploy (Render) — go live in one click

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sourabh7300/Nexa-AI)

`render.yaml` is a ready Blueprint: free Node web service, `GROQ_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_CLIENT_ID` as dashboard secrets, auto-generated `SESSION_SECRET`, health check at `/healthz`. After deploying, add your `*.onrender.com` origin to the OAuth client's Authorized JavaScript origins.

## Tests & CI

Every push runs a 14-test integration suite on GitHub Actions (Node 20). The suite spawns real server processes and verifies over HTTP:

- health check, index page, HEAD requests
- security: `.env`, source files, and arbitrary paths are never served
- auth: API is gated (401) in production mode, sign-in endpoint validates input
- chat validation: empty/oversized/invalid bodies, unsupported attachments
- graceful degradation: 503 with no provider keys, never a crash
- rate limiting: 429 + `Retry-After` at 20 chats/minute
- regression: invalid `PORT` falls back to 3000

Run locally with `npm test` (zero dependencies — Node's built-in test runner).

Note: Render Free services sleep after ~15 min idle and cold-start in about a minute.

## Stack

Node.js (built-in `http`, zero web frameworks), `google-auth-library` for token verification, vanilla-JS single-page frontend. Everything else is hand-rolled: SSE streaming, HMAC sessions, rate limiting, provider failover.

## Repo layout

| File | Purpose |
|---|---|
| `server.js` | The whole backend: auth, sessions, chat proxy, failover, rate limits, static serving |
| `index.html` | The whole frontend: workspace UI, streaming chat, attachments, voice |
| `render.yaml` | Render Blueprint for one-click deployment |
| `Start-Nexa.cmd` / `.ps1` | One-click local launcher with health check |
| `Save-Groq-Key.cmd` / `.ps1` | Hidden-input helper to store your Groq key in `.env` |
| `SETUP.txt` | Detailed local + Google OAuth + Render walkthrough |
