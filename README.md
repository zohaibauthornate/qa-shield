# 🛡️ QA Shield

**AI-powered QA lifecycle automation for Creator.fun — Solana meme coin trading platform**

QA Shield automates the entire QA workflow using **Codex AI** (powered by ChatGPT Plus — no extra API credits needed): from ticket enrichment to fix verification, security scanning, and performance benchmarking.

---

## AI Workflow Overview

```
Linear Ticket Created
        │
        ▼
POST /api/enrich  ──► Returns instantly (~3s)
        │               Codex runs in background (~60-90s)
        │
        ▼
Codex reads codebase + analyzes ticket
        │
        ▼
Deep analysis comment posted to Linear automatically
        │
        ▼
Dev receives: root cause, file locations, test cases, fix approach
        │
        ▼
Dev pushes fix → staging branch
        │
        ▼
POST /api/verify  ──► Codex verifies the fix in background
        │
        ▼
PASS → ticket moved to Done ✅
FAIL → ticket moved back to Todo with failure details ❌
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      QA Shield Backend                   │
│                  (Next.js / TypeScript)                  │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ /api/enrich  │  │ /api/verify  │  │ /api/guardian│  │
│  │  (instant)   │  │  (instant)   │  │  (scheduled) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │          │
│         ▼                 ▼                  ▼          │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Codex Background Runner             │   │
│  │   codex-background.ts + codex-runner-process.mjs│   │
│  │   • Spawns detached Node.js process              │   │
│  │   • Codex CLI runs gpt-5.4 reasoning model       │   │
│  │   • Reads actual codebase for deep analysis      │   │
│  │   • Posts results to Linear when done            │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  Fallback chain (if Codex unavailable):                 │
│  OpenAI API key → Chief QA proxy → Anthropic → Rules   │
└─────────────────────────────────────────────────────────┘
```

---

## Key Features

### 🤖 Codex AI Engine (Zero Extra Cost)
- Powered by **Codex CLI** using ChatGPT Plus subscription
- Uses **gpt-5.4** reasoning model — reads and understands actual codebase files
- **Async by design** — API responds in ~3s, analysis posts to Linear in ~60-90s
- No OpenAI API billing required — runs on your existing ChatGPT Plus plan
- Fallback chain: OpenAI API → Chief QA proxy → Anthropic → Rule-based

### 📋 Ticket Enrichment (`POST /api/enrich`)
Analyzes a Linear ticket and posts a structured AI comment:
- **Classification** — bug / improvement / feature / hotfix
- **Root cause analysis** — what broke, which component, technical why
- **Impact assessment** — severity, affected users, pages, endpoints
- **Steps to reproduce** — exact steps on dev.creator.fun
- **Test cases** — must/should/nice priority with clear pass/fail criteria
- **Edge cases** — tricky scenarios devs might miss
- **Recommended fix** — approach, files likely involved, effort estimate
- **Post-fix verification checklist** — what to check after the fix

**Response:** Instant (~3s). Comment appears in Linear in ~60-90s.

```bash
curl -X POST http://localhost:3000/api/enrich \
  -H "Content-Type: application/json" \
  -d '{"identifier": "CRX-900", "postComment": true}'
```

### ✅ Fix Verification (`POST /api/verify`)
After a dev pushes a fix, QA Shield verifies it actually works:
- Reads GitHub diff to understand what changed
- Generates targeted API and DOM checks
- Executes real checks against `dev.creator.fun`
- **PASS** → moves ticket to Done + posts verification comment
- **FAIL** → moves ticket back to Todo + posts failure details with evidence

```bash
curl -X POST http://localhost:3000/api/verify \
  -H "Content-Type: application/json" \
  -d '{"identifier": "CRX-900"}'
```

### 🔍 Job Status (`GET /api/enrich/status`)
Track background Codex analysis jobs:

```bash
# By ticket identifier
curl "http://localhost:3000/api/enrich/status?identifier=CRX-900"

# By job ID (returned in enrich response)
curl "http://localhost:3000/api/enrich/status?jobId=abc123"
```

### 🛡️ Guardian Scanner (`POST /api/background/scan`)
Runs proactive security and performance audits on a schedule:
- **Security**: CORS, missing auth headers, exposed endpoints, API key leaks
- **Performance**: Response time benchmarks vs axiom.trade and pump.fun
- **Auto-filing**: Creates Linear tickets for critical findings
- **Deduplication**: Checks for existing similar issues before creating
- **AI Fix Prompts**: Every ticket includes a ready-to-paste Cursor/Claude Code prompt

### 📊 Pre-Merge Verification
Watches staging branch commits for CRX-XXX references:
- Detects when a fix is pushed to staging
- Auto-triggers verification for the associated ticket
- Nothing reaches Done without passing verify-fix

---

## Setup

### Prerequisites
- Node.js 18+
- Linear API key
- GitHub PAT (for repo access)
- **Codex CLI** with ChatGPT Plus OAuth (primary AI engine)

### Codex CLI Setup (One-time)

```bash
# Install Codex CLI
npm install -g @openai/codex

# Authenticate with ChatGPT Plus (opens browser)
codex login

# Auth stored at ~/.codex/auth.json
```

### Environment Variables

```env
# Linear
LINEAR_API_KEY=lin_api_xxx

# GitHub (for commit context)
GITHUB_TOKEN=ghp_xxx

# Staging URL
STAGING_URL=https://dev.creator.fun

# Optional fallbacks (Codex is primary — no API key needed)
OPENAI_API_KEY=sk-proj-xxx     # fallback if Codex unavailable
ANTHROPIC_API_KEY=sk-ant-xxx   # last resort fallback
```

### Run

```bash
cd backend
npm install
PORT=3000 npm run dev
```

### LaunchAgent (always-on, auto-restart)
A macOS LaunchAgent (`com.qashield.backend`) keeps the backend running on port 3000, auto-restarting on crash or reboot.

---

## AI Engine Details

| Engine | Model | Speed | Cost | Notes |
|--------|-------|-------|------|-------|
| **Codex CLI** | gpt-5.4 | ~60-90s (async) | Free (ChatGPT Plus) | Reads codebase, deepest analysis |
| OpenAI API | gpt-4o | ~10-15s | ~$0.01/ticket | Requires API billing |
| Chief QA Proxy | claude-sonnet | ~15-20s | Free (OpenClaw) | Via queue system |
| Anthropic API | claude-sonnet | ~15s | Requires API key | Last resort |
| Rule-based | — | <1s | Free | Fallback, no AI |

**Priority order:** Codex → OpenAI API → Chief QA Proxy → Anthropic → Rule-based

---

## Project Structure

```
qa-shield/
├── backend/
│   ├── src/
│   │   ├── app/api/
│   │   │   ├── enrich/
│   │   │   │   ├── route.ts          # POST /api/enrich (instant response)
│   │   │   │   └── status/
│   │   │   │       └── route.ts      # GET /api/enrich/status
│   │   │   ├── verify/
│   │   │   │   ├── route.ts          # POST /api/verify
│   │   │   │   └── bulk/route.ts     # POST /api/verify/bulk
│   │   │   ├── background/
│   │   │   │   └── route.ts          # POST /api/background/scan (guardian)
│   │   │   ├── ai/
│   │   │   │   └── queue/route.ts    # AI task queue (Chief QA proxy)
│   │   │   └── github/route.ts       # GitHub webhook handler
│   │   └── lib/
│   │       ├── ai.ts                 # Prompt builders + formatters
│   │       ├── codex-ai.ts           # Codex CLI subprocess wrapper
│   │       ├── codex-background.ts   # Async job spawner + tracker
│   │       ├── codex-runner-process.mjs  # Detached background runner
│   │       ├── which-util.ts         # Cross-platform which()
│   │       ├── linear.ts             # Linear GraphQL client
│   │       ├── github.ts             # GitHub commit context fetcher
│   │       ├── scanner.ts            # Security + performance scanner
│   │       ├── guardian.ts           # Scheduled audit engine
│   │       ├── verifier.ts           # DOM + API verifier
│   │       ├── verify-runner.ts      # Verification orchestrator
│   │       └── commit-runner.ts      # Pre-merge commit watcher
└── extension/                        # Chrome extension (QA toolbar)
```

---

## Linear Workflow States

| State | ID |
|-------|----|
| Done | `1d39a7b1-213c-4323-9eed-788c27bc588a` |
| In Review | `8aa91362-4b1c-407f-9314-9e7d80b1d651` |
| Todo | *(default)* |

**QA-ReCheck label:** `c7199040-3fb2-441a-bda1-07012e5d67a4`

---

## Escalation Rules

| Condition | Action |
|-----------|--------|
| Critical bug found | Post to Slack #dev immediately |
| Ticket stale 3+ days | Flag in bugs channel, tag assigned dev |
| Ticket stale 5+ days | Escalate to Haider |
| Ticket stale 7+ days | Escalate to George |

---

## Built by Chief QA 🛡️
Automated QA infrastructure for Creator.fun — keeping the platform stable so devs can ship fast.
