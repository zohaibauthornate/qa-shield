# 🛡️ QA Shield — Full Product Overview & Version History
**Author:** Chief QA | **Date:** 2026-03-15

---

## What Is QA Shield?

QA Shield is a **custom-built, AI-powered QA automation system** for [dev.Creator.fun](https://dev.creator.fun) — a Solana-based meme coin creation and trading platform. It was built from scratch because traditional QA tools don't understand Web3, Solana wallet flows, or real-time trading data.

It runs 24/7 in the background as a local backend service on the dev machine, acts as an automated senior QA engineer, and handles the full QA lifecycle — from the moment a bug is reported to the moment it's verified fixed and closed.

> **One goal:** Nothing broken reaches production. Devs ship fast. QA Shield catches what slips through.

---

## Core Components

```
QA Shield
├── 🖥️  Backend API          → Next.js/TypeScript server (port 3000)
├── 🧩  Chrome Extension     → QA toolbar injected on Linear + dev.creator.fun
├── 🤖  AI Engine            → Codex CLI (gpt-5.4) + Chief QA fallback
├── 🔍  Security Scanner     → CORS, headers, auth, data exposure checks
├── ⚡  Performance Engine   → API benchmarks vs pump.fun + axiom.trade
├── ✅  Verify Runner        → Auto-verifies fixes after dev commits
├── 👁️  Guardian Scanner     → Always-on background audit (runs 2x/day)
└── 📋  Linear Integration   → Reads/writes/moves tickets automatically
```

---

## Full Feature Set

### 1. 🤖 Ticket Enrichment (`POST /api/enrich`)
When a ticket is created in Linear, QA Shield enriches it automatically with deep AI analysis.

**What it does:**
- Reads the ticket title + description + any existing comments
- Reads the actual **codebase** (Codex digs into the real files) to find root cause
- Posts a structured analysis comment directly on the Linear ticket

**What the comment includes:**
- Issue type classification (Bug / Feature / Hotfix / Improvement)
- Root cause hypothesis with file locations
- Impact assessment — which pages/components/users are affected
- Step-by-step reproduction steps on dev.creator.fun
- Test cases (Must / Should / Nice priority tiers)
- Edge cases devs typically miss
- Recommended fix approach with estimated effort
- Post-fix verification checklist

**Speed:** API responds instantly (~3s), Codex analysis posts to Linear in ~60–90s in the background.

---

### 2. ✅ Fix Verification (`POST /api/verify`)
After a dev pushes a fix, QA Shield verifies it — no manual retesting needed.

**What it does:**
- Reads the GitHub diff to understand exactly what changed
- Reads developer comments on the ticket to narrow scope
- Generates **targeted checks** based on what the ticket says was broken (ONLY that — not generic health checks)
- Runs 3 types of checks:
  - **API Checks** — verifies the backend returns the correct data
  - **DOM Checks** — verifies the UI element exists and displays correctly
  - **Cross Checks** — fetches API value + reads DOM display value + compares them (catches UI/data mismatch bugs)
- **PASS** → Moves ticket to **Done** + posts verification comment with evidence
- **FAIL** → Moves ticket back to **Todo** + posts detailed failure report

---

### 3. 🔍 Security Scanner
Proactively scans API endpoints for security vulnerabilities.

**Checks per endpoint:**
| Check | What It Looks For |
|---|---|
| CORS | Arbitrary origin reflection, credentials leakage |
| Auth | Unauthenticated access returning user-sensitive data |
| Headers | Missing HSTS, X-Content-Type-Options, X-Frame-Options, CSP |
| Data Exposure | API keys, secrets, private keys, JWT tokens in responses |
| Rate Limiting | Rapid-fire requests — does the server throttle or allow abuse? |
| Web3 Patterns | Base58 private keys, seed phrases, wallet drainer patterns |

**Endpoints scanned:** `/api/token`, `/api/token/list`, `/api/token/search`, `/api/leaderboard`, `/api/leaderboard/stats`, `/api/rewards`, `/api/profile/stats/trading`

**Output:** Auto-files Linear tickets for every new finding. Deduplicates by endpoint+check fingerprint so you never get the same ticket twice.

---

### 4. ⚡ Performance Engine
Benchmarks Creator.fun API response times against competitors in real-time.

**Endpoints benchmarked:**
| Our Endpoint | vs Competitor |
|---|---|
| `/api/token/list?limit=20` | pump.fun token list |
| `/api/token/search?q=test` | pump.fun search |
| `/api/token?address=xxx` | pump.fun coin detail |
| `/api/leaderboard/stats` | (no competitor — tracked solo) |
| `/api/profile/stats/trading` | (no competitor — tracked solo) |

**How it works:** 3 samples per endpoint, 300ms apart, calculates avg + p95. Compares to fastest competitor. Severity tiers:
- **>500% slower or >200ms delta** → auto-files performance ticket
- **>4000% slower or 1000ms+** → Critical severity + Slack alert to #dev

**Output:** Structured benchmark table posted as Linear comment with per-endpoint breakdown and percentage delta.

---

### 5. 👁️ Guardian Scanner (Always-On)
Runs proactive security + performance audits on a schedule without any manual trigger.

**Schedule:**
- **Cron 1:** `qa-shield-guardian` — 2x per day, files tickets, alerts Slack on Critical
- **Cron 2:** `qa-shield-daily-report` — 9 AM PKT, daily summary report

**Intelligence:**
- Reads state file before each run to avoid re-filing known issues
- Fingerprints every finding by `(check_type + endpoint)` — no duplicates
- Posts AI Fix Prompt as a comment on every ticket — a ready-to-paste Cursor/Claude Code prompt so devs can fix with AI immediately

---

### 6. 🔀 Pre-Merge Verification (Commit Watcher)
Monitors the `staging` branch for new commits with CRX-XXX references.

**Flow:**
1. Dev pushes fix: `CRX-900: fix liquidity showing 0`
2. QA Shield detects the commit via GitHub
3. Auto-triggers `POST /api/verify` for CRX-900
4. PASS → Done. FAIL → back to Todo with failure details.

> Nothing reaches Done without passing verify-fix.

---

### 7. 🧩 Chrome Extension (QA Toolbar)
A browser extension that surfaces QA Shield data directly inside Linear and dev.creator.fun.

- **On Linear ticket pages:** Injects a sidebar with AI-enriched analysis, test cases, scope, "Verify Fix" button
- **On dev.creator.fun:** Floating QA widget — screenshot capture, console error capture, network monitoring
- **Popup:** Quick status dashboard, recent verifications, alerts

---

### 8. 🤖 AI Engine & Fallback Chain

Primary AI: **Codex CLI** (powered by ChatGPT Plus, zero extra API cost, reads actual codebase)

| Priority | Engine | Model | Speed | Cost |
|---|---|---|---|---|
| 1st | Codex CLI | gpt-5.4 | 60–90s (async) | Free (ChatGPT Plus) |
| 2nd | OpenAI API | gpt-4o | 10–15s | ~$0.01/ticket |
| 3rd | Chief QA Proxy | claude-sonnet | 15–20s | Free (via OpenClaw) |
| 4th | Anthropic API | claude-sonnet | ~15s | Requires API key |
| 5th | Rule-based | — | <1s | Free |

---

## Version History — What Changed From V1 to Now

### 🟦 V1 — MVP (Initial Build)
The first version was a **Chrome Extension + basic backend** with minimal automation:
- Chrome extension injected a sidebar on Linear ticket pages
- `/api/enrich` — called OpenAI/Anthropic to generate test cases and post a comment
- `/api/verify` — ran basic DOM + API checks
- `/api/security/scan` — basic CORS, auth, headers check on 9 hardcoded endpoints (5 of which didn't exist on dev.creator.fun — FALSE PASSes)
- `/api/monitor/health` — benchmarked homepage URLs (dev.creator.fun vs axiom.trade vs pump.fun root pages — completely useless, comparing apples to oranges)
- Linear integration for ticket reading and commenting

**V1 Problems:**
- Scanned 5 non-existent endpoints (`/api/user`, `/api/chat`, `/api/trade`, `/api/holdings`, `/api/fees`) → false "secure" verdicts
- Auth check used substring search for `wallet` → triggered on every token response (contains `creatorWallet`) → mass false-positive Critical tickets
- Duplicate detection too loose → created 11 CORS tickets for the same issue (CRX-865, CRX-871–880)
- Token detail benchmark used wrong URL path (path segment vs query param) → always hit 404, always returned -1
- Performance benchmark compared homepage load times, not API response times
- Verify fix ran irrelevant generic checks regardless of what the ticket was about

---

### 🟨 V2 — Bug Fixes + Guardian (March 11–12, 2026)
Major reliability fixes + always-on autonomous scanning:

**Security Scanner Overhaul:**
- Fixed `DEFAULT_ENDPOINTS` — removed all 5 non-existent paths, replaced with real API endpoints
- Fixed auth check false positives — switched from substring `wallet` to field-path matching
- Fixed deduplication — hash-based fingerprinting by `(check_type + endpoint)` instead of fuzzy title matching
- Added `checkRateLimit()` — fires 10 rapid requests, checks for 429 or throttling
- Added Web3 pattern detection — base58 private key patterns, seed phrase detection

**Performance Engine Overhaul:**
- Fixed Token Detail benchmark path → `/api/token?address=xxx` (correct query param)
- Added API-level benchmarking (replaced useless homepage comparison)
- Added axiom.trade as second competitor
- Added percentage delta thresholds: >500% → Critical ticket, >4000% → Slack alert

**Guardian Scanner (New):**
- Background `POST /api/background/scan` — runs full security + performance audit
- Cron: 2x per day + 9 AM daily report
- State file deduplication — never re-files the same fingerprinted issue
- AI Fix Prompt comment on every ticket

**Always-On Backend:**
- macOS LaunchAgent (`com.qashield.backend`) — auto-starts on boot, auto-restarts on crash
- Backend locked to port 3000

---

### 🟩 V3 — AI Engine + Codex Integration (March 13–14, 2026)
Complete AI engine rebuild — from simple OpenAI calls to deep codebase analysis:

**Codex AI Engine (New):**
- Integrated Codex CLI as primary AI — `codex-ai.ts` subprocess wrapper
- Detached background runner (`codex-runner-process.mjs`) — API responds instantly, Codex runs in background
- `GET /api/enrich/status` — track job progress by ticket identifier or job ID
- Reads actual codebase files during analysis (not just the ticket text) → root cause accuracy dramatically improved

**Chief QA AI Proxy (New):**
- Queue system at `/api/ai/queue` — QA Shield writes tasks, Chief QA (OpenClaw) processes them
- QA Shield polls up to 90s for result, then falls back to rule-based
- Enables AI enrichment even when Codex and API keys are unavailable

**GitHub Integration (New):**
- GitHub PAT integration in `github.ts`
- Reads last 200 commits from `staging` branch — scans for CRX-XXX references
- Feeds commit diffs as context into enrichment + verification prompts
- Pre-merge commit watcher (`commit-runner.ts`) — auto-triggers verify on new staging commits

---

### 🟥 V3.1 — Verify Scope Fix + API Benchmark Precision (March 15, 2026 — Today)
Targeted surgical fixes to make verify and benchmarks production-accurate:

**Verify Fix — Strict Scope Enforcement:**
- Critical rule added to AI system prompt: *"ONLY generate checks that verify what THIS specific ticket says was broken — nothing else"*
- AI now reads developer comments before generating checks — narrows scope to what was actually changed
- Upgraded model from `claude-haiku` → `claude-sonnet-4` for verify plan generation
- `buildFallbackPlan()` now returns empty arrays instead of generic platform checks when scope is unclear — flags as "Manual verification required"
- Eliminated all non-existent endpoints from the AI's endpoint knowledge base

**Performance Benchmark — API-Level Precision:**
- Replaced homepage benchmark with `apiLevelBenchmark()` — 4 specific API endpoints, 3 samples each
- Removed `step 3` (performance ticket creation was based on wrong homepage data — now handled by Guardian)
- `formatPerformanceComment()` now outputs per-endpoint table with our avg/p95 vs competitor avg/p95 + delta %
- SSE event renamed from `benchmark` → `api_benchmark` with structured per-endpoint results

---

## Current Live Status (2026-03-15)

| Metric | Value |
|---|---|
| Backend | ✅ Online — port 3000 |
| AI Engine | Codex CLI (gpt-5.4) + Chief QA fallback |
| Open Issues in Linear | **19** |
| Critical Issues Active | **1** (CRX-999 — `/api/token` 1149ms avg, 4496% slower than pump.fun) |
| Guardian Scans Today | 0 (next scheduled run TBD) |
| Total Tickets Filed (session) | 5 |

### 🚨 Live Findings Right Now
- **CRX-999 (Critical):** `/api/token` hit 1149ms avg — 4496% slower than pump.fun. Wildly inconsistent (same endpoint ranging 343ms–1149ms in one day). Likely no caching or unstable upstream.
- **CRX-966 (High):** CORS misconfiguration on `/api/token`
- **CRX-974 (High):** CORS + missing security headers on `/api/profile/stats/trading`
- **CRX-998 (Medium→Critical spike):** `/api/profile/stats/trading` hit 1223ms avg — 4792% slower than pump.fun

---

## Infrastructure

```
LaunchAgent: com.qashield.backend   → auto-start on boot, port 3000
Cron 1:      qa-shield-guardian     → 2x/day security+perf scan + Linear filing
Cron 2:      qa-shield-daily-report → 9 AM PKT summary
Cron 3:      qa-shield-ai-worker    → every 2min, processes Chief QA AI queue
State:       /tmp/qa-shield-guardian-state.json
Logs:        /tmp/qa-shield.log
Reports:     /Users/zohaibmac-mini/Projects/qa-shield/reports/
```

---

*Built and maintained by Chief QA 🛡️*
