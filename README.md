# 🛡️ QA Shield

> **AI-powered autonomous QA lifecycle automation** — enriches tickets, verifies fixes, scans security/performance, and responds on your behalf when you're away.

Built to work with **Linear** + **GitHub** + **Slack** + **OpenClaw** (optional). Zero manual QA overhead.

---

## What It Does

```
Linear Ticket Created / Commit Pushed
              │
              ▼
  ┌─────────────────────────┐
  │   QA Shield Backend     │
  │   (Next.js / TypeScript)│
  └──────────┬──────────────┘
             │
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
POST /api/enrich   POST /api/verify
 (AI analysis)      (fix validation)
    │                 │
    ▼                 ▼
Linear comment    PASS → Done ✅
with root cause   FAIL → Todo ❌
+ test cases      + failure report
```

**Core capabilities:**
- 🤖 **Ticket Enrichment** — AI analyzes Linear tickets: root cause, reproduction steps, test cases, fix approach
- ✅ **Fix Verification** — reads GitHub diffs, runs real checks, auto-moves tickets to Done or back to Todo
- 🔍 **Guardian Scanner** — scheduled security + performance audits, auto-files Linear tickets
- 📊 **Pre-Merge Verification** — watches staging branch commits, verifies fixes before they merge
- 💬 **Away Responder** — when you're away and someone tags you, the bot responds and handles the task

---

## Quick Start

```bash
git clone https://github.com/zohaibauthornate/qa-shield.git
cd qa-shield/backend
cp .env.example .env.local
# Fill in your keys (see Environment Variables below)
npm install
PORT=3000 npm run dev
```

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```env
# ── Linear ──────────────────────────────────────────────
LINEAR_API_KEY=lin_api_xxx            # Your Linear API key
LINEAR_TEAM_ID=xxx                    # Your Linear team ID

# ── GitHub ──────────────────────────────────────────────
GITHUB_TOKEN=ghp_xxx                  # Personal Access Token (repo read)
GITHUB_REPOS=org/frontend,org/backend # Comma-separated repos to watch
GITHUB_BRANCH=staging                 # Branch to watch for commits
GITHUB_WEBHOOK_SECRET=your-secret     # For webhook signature verification

# ── Your App URLs ────────────────────────────────────────
STAGING_URL=https://dev.yourapp.com
STAGING_API_URL=https://api.dev.yourapp.com
COMPETITOR_URLS=https://competitor1.com,https://competitor2.com

# ── AI Providers (priority order) ───────────────────────
# Option 1: Codex CLI (free with ChatGPT Plus — see Codex Setup below)
# Option 2: OpenAI API key
OPENAI_API_KEY=sk-proj-xxx
# Option 3: Anthropic
ANTHROPIC_API_KEY=sk-ant-xxx

# ── Slack (for alerts + away responder) ─────────────────
SLACK_BOT_TOKEN=xoxb-xxx
REGRESSION_SLACK_CHANNEL=C0XXXXXXXX   # Channel ID for QA reports

# ── App ──────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## AI Engine Options

QA Shield supports multiple AI backends with automatic fallback:

| Engine | Model | Cost | Notes |
|--------|-------|------|-------|
| **Codex CLI** | gpt-5.4 | Free (ChatGPT Plus) | Reads codebase, deepest analysis |
| OpenAI API | gpt-4o | ~$0.01/ticket | Requires API billing |
| Anthropic | claude-sonnet | Requires API key | Fast fallback |
| Rule-based | — | Free | Always available |

**Priority:** Codex → OpenAI → Anthropic → Rule-based

### Codex CLI Setup (recommended — zero API cost)

```bash
npm install -g @openai/codex
codex login   # Opens browser, uses ChatGPT Plus auth
# Auth stored at ~/.codex/auth.json
```

---

## API Reference

### `POST /api/enrich`
Analyzes a Linear ticket and posts an AI comment with root cause, test cases, and fix approach.

```bash
curl -X POST http://localhost:3000/api/enrich \
  -H "Content-Type: application/json" \
  -d '{"identifier": "CRX-900", "postComment": true}'
```

Response is instant (~3s). AI comment appears in Linear in ~60-90s.

---

### `POST /api/verify`
Reads GitHub diff for a ticket's fix, runs real checks against your staging URL, moves ticket to Done or back to Todo.

```bash
curl -X POST http://localhost:3000/api/verify \
  -H "Content-Type: application/json" \
  -d '{"identifier": "CRX-900"}'
```

---

### `GET /api/enrich/status`
Check status of a background analysis job.

```bash
curl "http://localhost:3000/api/enrich/status?identifier=CRX-900"
```

---

### `POST /api/background/scan`
Run the Guardian scanner manually (also runs on a schedule via cron).

```bash
curl -X POST http://localhost:3000/api/background/scan
```

---

## Always-On Setup (macOS LaunchAgent)

To keep QA Shield running permanently (auto-restart on crash/reboot):

```bash
# Create LaunchAgent plist
cat > ~/Library/LaunchAgents/com.qashield.backend.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.qashield.backend</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/qa-shield/backend/node_modules/.bin/next</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/qa-shield/backend</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>3000</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/qa-shield.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/qa-shield-error.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.qashield.backend.plist
```

---

## OpenClaw Integration (Away Responder)

QA Shield pairs with **[OpenClaw](https://openclaw.ai)** to create a fully autonomous QA agent:

- When you're **away on Slack** and someone tags you → Chief QA responds on your behalf
- Incoming QA tasks (verify tickets, investigate bugs) are handled autonomously
- Guardian scan results and alerts post directly to your Slack channels
- Pre-merge verification runs automatically on every staging commit

### How it works

1. OpenClaw runs as your persistent AI agent (Chief QA persona)
2. QA Shield backend handles the heavy lifting (Linear mutations, GitHub diffs, real browser checks)
3. Chief QA calls QA Shield APIs and reports results back to Slack

```
Slack @mention (you're away)
        │
        ▼
OpenClaw (Chief QA) detects message
        │
        ├── QA task? → POST /api/verify or /api/enrich
        ├── Bug report? → POST /api/background/scan
        └── General question? → Responds with context
```

See [OpenClaw docs](https://docs.openclaw.ai) for agent setup.

---

## Scheduled Jobs (Cron)

Set up two cron jobs via OpenClaw or system cron:

```bash
# Guardian scan — 2x per day (9 AM and 5 PM)
0 9,17 * * * curl -X POST http://localhost:3000/api/background/scan

# Daily QA summary report — 9 AM
0 9 * * * curl -X POST http://localhost:3000/api/regression
```

---

## Project Structure

```
qa-shield/
├── backend/
│   ├── src/
│   │   ├── app/api/
│   │   │   ├── enrich/          # Ticket AI analysis
│   │   │   ├── verify/          # Fix verification
│   │   │   ├── background/      # Guardian scanner
│   │   │   ├── regression/      # Daily regression report
│   │   │   ├── security/        # Security audit
│   │   │   ├── monitor/         # Health monitoring
│   │   │   ├── ai/queue/        # AI task queue (proxy)
│   │   │   └── github/          # Webhook handler
│   │   └── lib/
│   │       ├── ai.ts            # Prompt builders
│   │       ├── codex-ai.ts      # Codex CLI wrapper
│   │       ├── codex-background.ts  # Async job spawner
│   │       ├── linear.ts        # Linear GraphQL client
│   │       ├── github.ts        # GitHub commit fetcher
│   │       ├── scanner.ts       # Security + perf scanner
│   │       ├── guardian.ts      # Scheduled audit engine
│   │       ├── verifier.ts      # DOM + API verifier
│   │       └── verify-runner.ts # Verification orchestrator
│   └── .env.example
├── browser-worker/              # Playwright browser automation
├── extension/                   # Chrome extension (QA toolbar)
└── reports/                     # Generated QA reports
```

---

## Linear Workflow

QA Shield manages your entire Linear ticket lifecycle:

```
Todo → In Progress → In Review (QA-ReCheck) → Done
                           ↑
                    QA Shield picks up here:
                    reads code diff → runs checks
                    PASS → Done | FAIL → back to Todo
```

---

## Requirements

- Node.js 18+
- Linear account + API key
- GitHub account + PAT (repo read access)
- Slack bot token (for alerts)
- One of: ChatGPT Plus (Codex), OpenAI API key, or Anthropic API key

---

## License

MIT — use it, fork it, build on it.

---

*Built with 🛡️ by [Chief QA](https://openclaw.ai) — autonomous QA watchdog for Web3 platforms*
