# QA Shield — Gap Analysis & Improvement Roadmap
**Date:** 2026-03-15 | **Author:** Chief QA 🛡️  
**Perspective:** Senior Web3 Automation Tester

---

## 1. What QA Shield Does Today (Honest Inventory)

| Module | Status | What it actually does |
|---|---|---|
| `/api/enrich` | ✅ Working | Fetches ticket + GitHub context, spawns Codex async, posts AI analysis to Linear |
| `/api/verify` | ⚠️ Partial | Builds rule-based verification plan, runs API checks, DOM checks require browser worker (offline) |
| `/api/verify/bulk` | ⚠️ Partial | Same as verify but for multiple tickets |
| `/api/github/poll` | ✅ Working | Polls GitHub for new commits on `pre-staging`, detects CRX-XXX refs, triggers verify + enrich |
| `/api/background/scan` | ✅ Working | Security (CORS, headers, auth, rate-limit, input validation) + perf benchmarks |
| `/api/security/scan` | ✅ Working | On-demand security scan against any endpoint |
| `guardian.ts` | ✅ Working | Runs 2x/day, files Linear tickets for security/perf regressions with dedup |
| `commit-analyzer.ts` | ✅ Working | Rule-based file→feature impact mapping (no AI needed) |
| `commit-runner.ts` | ⚠️ Partial | Runs targeted checks per commit — DOM checks blocked by browser worker |
| `scanner.ts` | ✅ Working | Security + perf scanning, competitor benchmarking |
| Browser Worker | ❌ Down | `127.0.0.1:3099` — not running, all DOM checks return `warn` → `partial` verdict |
| Codex Integration | ✅ Working | Background enrichment, dedup, ~2-3 min turnaround |

**Pass rate on verify today: ~40%** (API checks run, DOM checks skip, verdicts always `partial`)

---

## 2. Critical Gaps (Fix These First)

### GAP-1 🔴 Browser Worker is Permanently Down
**Impact: HIGH** — Every single ticket verify returns `partial` instead of `pass`/`fail`. DOM checks are the backbone of UI verification.

**Root cause:** Browser worker (`127.0.0.1:3099`) was never built or is not running. The verifier code calls it but it doesn't exist.

**Fix:** Implement the browser worker as a small Express server that uses Playwright/Puppeteer:
```
POST /dom → { path, checks } → run checks → { results, screenshot }
POST /screenshot → { url } → { base64 }
GET /health → { ok: true }
```
This single fix unlocks ~60% of QA Shield's missing capability.

---

### GAP-2 🔴 No Wallet Extension Testing
**Impact: CRITICAL for Web3** — Every trade, swap, PnL, and portfolio flow requires Phantom wallet interaction. QA Shield has zero ability to simulate wallet transactions.

**Current state:** `verifyQuickBuy()` calls the backend API directly (no wallet auth) — this tests the endpoint exists, not the actual user flow.

**What's missing:**
- No Phantom wallet automation
- No transaction signing simulation
- No wallet connect/disconnect testing
- No balance change assertions after trade

**Fix:** Browser worker should use the real Chrome profile (with Phantom installed). Use `profile="chrome"` via OpenClaw Browser Relay OR inject a mock wallet for API-level transaction testing.

---

### GAP-3 🔴 Verify Verdict is Meaningless Without DOM
**Impact: HIGH** — Every ticket that involves UI shows `partial`. `partial` never moves tickets. Commit-poll detects commits, runs verify, always gets `partial`, posts comment but never resolves tickets.

**Fix:** Once browser worker is up, verdicts become meaningful. Short-term: make `partial` configurable — if only DOM checks are unavailable (browser worker down), and all API checks pass → verdict should be `pass` (with note: "DOM checks skipped — browser worker offline").

---

### GAP-4 🟡 Static Hardcoded Token Addresses
**Impact: MEDIUM** — `commit-analyzer.ts` has hardcoded token addresses (e.g., `Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG`). This token doesn't exist on dev env. Every API check returns 404.

**Fix:** Before running checks, query `/api/token/list?limit=1` to get a live active token address and use that for all checks.

---

### GAP-5 🟡 No Real-Time WebSocket Test Assertions
**Impact: HIGH for Web3** — The platform's core value is real-time price/trade feeds. QA Shield benchmarks REST APIs but never validates WebSocket messages.

**What's missing:**
- No WS connect + subscribe test
- No message-delivery time assertion
- No WS reconnect behavior test
- No `tokens` topic silence bug detection (known issue from our audit)

**Fix:** Add a `wsVerify()` function in verifier.ts that connects to `wss://dev.bert.creator.fun:8081/`, subscribes to a topic, and asserts messages arrive within a timeout.

---

### GAP-6 🟡 No Solana Transaction Verification
**Impact: HIGH for Web3** — When a trade executes, QA Shield cannot:
- Confirm the transaction landed on-chain
- Verify the correct token amount transferred
- Assert PnL updated correctly post-trade
- Detect failed transactions that look "successful" in the UI

**Fix:** Integrate Helius devnet RPC to query transaction signatures post-trade and assert expected outcomes.

---

## 3. Architecture Gaps

### GAP-7 — No Test State/Session Management
Every verify run is stateless. If a ticket requires: (1) login → (2) navigate → (3) trigger action → (4) assert result, there's no way to chain these steps.

**Fix:** Add a `TestSession` concept — a sequence of steps with shared state (cookies, wallet address, auth token).

---

### GAP-8 — Verify Plan is Keyword-Matched (Brittle)
`buildVerificationPlan()` matches keywords in ticket titles/descriptions to generate checks. If a ticket says "Fix PnL overflow" it generates PnL-related checks — but if the actual fix is in a calculation utility and the endpoint URL doesn't match any pattern, no checks run.

**Fix:** Use GitHub diff context (which files changed) as the primary signal for what to test — not just ticket text. `commit-analyzer.ts` already does this correctly for commit-level checks; bring that logic into `buildVerificationPlan`.

---

### GAP-9 — Guardian Scans Same Endpoints Every Run
The guardian scans a fixed list of endpoints with no awareness of recently changed code. It files tickets for issues that were there last week and will be there next week.

**Fix:** Guardian should prioritize endpoints that changed in the last 24h (from GitHub commits) and run deeper checks on those, lighter checks on stable endpoints.

---

### GAP-10 — No Regression Baseline
QA Shield has no memory of "what did this endpoint return last week?" so it can't detect data regressions — e.g., token count dropped from 50 to 2, or average response time jumped from 180ms to 900ms.

**Fix:** Store baseline snapshots (key metrics per endpoint) and compare on each scan. Alert when delta > threshold.

---

## 4. Missing Web3-Specific Checks

These are checks that pump.fun/axiom-level QA must cover that QA Shield currently has NONE of:

| Check | Priority | Notes |
|---|---|---|
| **PnL math validation** | 🔴 Critical | Assert `(exitPrice - entryPrice) / entryPrice = pnl%`. CRX-898 is a symptom of no automated PnL assertion. |
| **Market cap formula** | 🔴 Critical | `mcap = price × supply`. Cross-check API vs on-chain via Helius. |
| **Bonding curve math** | 🔴 Critical | Buy X SOL → verify token received matches curve formula |
| **Graduation threshold** | 🟡 High | Detect when a token should graduate but hasn't |
| **WebSocket data freshness** | 🟡 High | Assert last WS message < 5s old on active tokens |
| **Holder count accuracy** | 🟡 High | Compare API holder count vs on-chain token accounts |
| **Liquidity lock verification** | 🟡 High | After graduation — verify LP tokens are locked |
| **Duplicate transaction detection** | 🟡 High | Same tx hash appearing twice in trade history |
| **Slippage validation** | 🟡 High | Actual slippage vs requested slippage |
| **Fee calculation accuracy** | 🟡 High | Platform fee (1%) deducted from correct amount |

---

## 5. Operational Gaps

### GAP-11 — Daily Report Cron is Broken
`qa-shield-daily-report` (cron `f5b310e4`) shows `error` status. No daily summaries going out.

### GAP-12 — No Slack Alerting on Verify Failures
When a commit triggers verify and the ticket fails, only a Linear comment is posted. No Slack alert to the dev who pushed the commit.

**Fix:** On `fail` verdict — post to `#dev` (C0A53K6M7PG) with ticket link, commit SHA, and what failed.

### GAP-13 — No Bulk Enrich
When a sprint ends, there might be 20+ tickets needing enrichment. No batch endpoint exists.

**Fix:** `POST /api/enrich/bulk` — accepts array of identifiers, queues Codex jobs for each with rate limiting.

### GAP-14 — Codex Job State Not Persisted
`/tmp/qa-shield-codex-jobs.json` is in `/tmp` — cleared on reboot. After Mac restarts, all running job history is lost and dedup breaks.

**Fix:** Move to `~/.qa-shield/codex-jobs.json` or a proper state directory.

---

## 6. Prioritized Roadmap

### Sprint 1 — Make Verify Actually Work (1-2 days)
1. Build browser worker (Playwright Express server) — unblocks 60% of current gaps
2. Fix verdict when browser worker is down → `pass` if all API checks pass
3. Replace hardcoded token addresses with live token lookup
4. Fix `qa-shield-daily-report` cron

### Sprint 2 — Web3-Specific Assertions (2-3 days)
5. Add `wsVerify()` — WebSocket subscription + message delivery test
6. Add PnL math validation (formula check, not just field existence)
7. Add market cap cross-check (API vs formula)
8. Slack alert on `fail` verdict after commit verify

### Sprint 3 — Full Automation (3-5 days)
9. Browser worker with real Chrome profile + Phantom for wallet flows
10. Helius RPC integration — on-chain transaction verification
11. Regression baseline storage — detect data regressions
12. Bulk enrich endpoint
13. Move Codex job state out of `/tmp`

---

## 7. Quick Wins (Today)

- [ ] Fix verdict logic: browser worker down → `pass` if API checks all pass
- [ ] Replace hardcoded token address in impact rules with live lookup
- [ ] Add Slack alert on `fail` verdict
- [ ] Fix daily report cron
- [ ] Move codex job state out of `/tmp`

---

**Bottom line:** QA Shield has solid bones — the pipeline (commit → detect → verify → Linear) is working end-to-end. The biggest single fix is the browser worker. Without it, QA Shield is a smart API tester, not a real product verifier. With it + wallet simulation, it becomes a genuine Web3 QA automation platform.
