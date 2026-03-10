# QA Shield — Chrome Extension + Backend Report

**Owner:** Chief QA (zohaib@authornate.com)
**Date:** March 2026
**Platform:** Chrome Extension (Manifest V3) + Next.js Backend + Playwright Browser Worker

---

## Core Idea

The creator.fun codebase is being actively revamped with AI-assisted development. More code shipping faster means quality control becomes the bottleneck — and a manual QA process doesn't scale with AI-accelerated output.

**QA Shield exists to close that gap.** It automates the QA layer so that as development velocity increases, quality assurance keeps pace — without adding headcount or manual toil. The goal is not just to catch bugs faster, but to build a feedback loop that makes the entire development process smarter: developers get instant, structured verification on every fix; security gaps are surfaced before they compound; performance regressions are caught at the ticket level, not after deployment.

In short: **AI writes the code, QA Shield verifies it.**

---

## Problem Statement

When developers push fixes to Linear tickets and move them to **In Review**, a QA engineer must manually:

- Navigate to the live staging environment and reproduce the original issue
- Check API responses match expected data shapes
- Inspect DOM for correct UI rendering, layout, and state
- Run security scans to catch exposed headers, CORS misconfig, and auth gaps
- Benchmark API endpoints for performance regressions
- Write a detailed verification comment on the Linear ticket
- Move the ticket to **Done** or back to **Todo** with a failure report

This process is slow, context-switching-heavy, and inconsistent — and it doesn't scale when development is moving at AI speed. QA Shield automates the entire flow — directly from the Linear ticket page — via a floating panel with three independent actions: **Verify Fix**, **Security Scan**, and **Benchmark**.

---

## Architecture Overview

```
Chrome Extension (content script on linear.app)
        │
        │  SSE streams (progress events)
        ▼
Next.js Backend (port 3000)
  ├── POST /api/verify       → ticket-scoped fix verification
  ├── POST /api/security/scan → OWASP-style security checks
  └── POST /api/monitor/health → API benchmark + perf scoring
        │
        │  HTTP (DOM + API checks)
        ▼
Browser Worker (port 3099) — standalone Playwright process
  └── POST /dom              → headless Chromium, real DOM inspection
        │
        ▼
dev.creator.fun (staging) + dev.bep.creator.fun (API)
```

---

## User Journey Loop

```
1. Open a Linear Ticket
   User navigates to any ticket on linear.app/creatorfun.
   QA Shield content script detects the ticket identifier (e.g. CRX-870)
   and injects a floating panel in the bottom-right corner.

2. Choose an Action
   Three independent buttons appear in the panel:
   - [Verify Fix]      → confirms the ticket's reported issue is resolved
   - [Security Scan]   → checks for OWASP-class vulnerabilities
   - [Benchmark]       → measures API response times + scores performance

3. SSE Stream Begins
   Backend responds with a Server-Sent Events stream.
   Progress events arrive step-by-step — the panel renders live updates
   as each check completes, so the user sees real-time results instead
   of waiting for a batch response.

4. Verify Fix Flow (6 steps)
   Step 1 — Fetch ticket from Linear API (title, description, labels)
   Step 2 — Build verification plan (AI parses ticket → targeted checks)
   Step 3 — Run API checks (curl staging endpoints, validate response shape)
   Step 4 — Run DOM checks (browser worker navigates to live page, inspects elements)
   Step 5 — Run transaction checks (if ticket involves trading/wallet logic)
   Step 6 — Verdict: PASS → post comment + move to Done
                      FAIL → post comment + move to Todo

5. Security Scan Flow (3 steps)
   Step 1 — Run OWASP checks (CORS, security headers, auth endpoints, key exposure)
   Step 2 — Post security comment on the ticket
   Step 3 — Create new Linear tickets for each finding (deduped against existing)
             with Security + Bug labels; skips if identical ticket already exists

6. Benchmark Flow (3 steps)
   Step 1 — Hit core API endpoints (tokens, leaderboard, trades, search)
   Step 2 — Score performance: <200ms = good, 200–500ms = warn, >500ms = fail
   Step 3 — Post performance comment + create ticket if regressions found

7. Iterate
   Panel stays open between actions.
   Collapse button shrinks it to a pill (⚡ QA Shield).
   Click the pill to restore.
   Each button is fully independent — security scan won't trigger verify,
   benchmark won't post verify comments, etc.
```

---

## Security & Permissions Review

| Permission | Usage | Justification |
|---|---|---|
| `activeTab` | Read current Linear ticket URL + identifier | Required to detect ticket context on linear.app |
| `scripting` | Inject floating panel + SSE consumer into Linear | Required for panel UI and stream handling |
| `storage` | Persist backend URL config | Local-only, no sync/remote storage |
| `host_permissions` (localhost:3000) | POST to local Next.js backend | Avoids CORS block; backend never exposed externally |

**Data Handling:**
- All verification data flows locally: extension → localhost backend → staging API
- No ticket content, API responses, or DOM data is sent to third-party servers
- Anthropic API is called from the backend (server-side) only — API key never touches the extension
- Linear API key stored in backend `.env.local` — not bundled in extension

**Backend Security:**
- Backend runs on `localhost:3000` only — not network-exposed
- Browser worker runs on `127.0.0.1:3099` only — loopback, not LAN-accessible
- Staging credentials (`georgecfun` password gate) handled in browser worker, not in extension

**Playwright Browser Worker:**
- Runs as a separate Node.js process (not inside Next.js webpack bundle)
- Uses `chromium` headless with a persistent profile (`openclaw`)
- Already authenticated as `zohaib@authornate.com` on dev.creator.fun
- Password gate (`georgecfun`) handled automatically on first navigation

---

## Extension File Structure

```
extension/
├── manifest.json          # MV3, v0.3.0
├── popup/
│   ├── popup.html
│   └── popup.js           # Config UI (backend URL)
└── content/
    ├── linear.js          # Main content script — panel, SSE, actions
    └── linear.css         # Floating panel styles, live update UI
```

---

## Backend File Structure

```
backend/
└── src/
    ├── app/api/
    │   ├── verify/route.ts          # SSE — fix verification (6 steps)
    │   ├── security/scan/route.ts   # SSE — OWASP security scan (3 steps)
    │   └── monitor/health/route.ts  # SSE — API benchmark (4 steps)
    └── lib/
        ├── linear.ts     # Linear GraphQL client (fetch, comment, move, create)
        ├── ai.ts         # Anthropic prompts (verification plan, security, perf)
        ├── verifier.ts   # Real checks — calls browser worker HTTP API
        └── scanner.ts    # OWASP checks — headers, CORS, auth, key exposure
```

---

## AI Integration

QA Shield uses Claude (Anthropic) at three points:

| Step | Prompt | Purpose |
|---|---|---|
| Verify — Step 2 | `buildVerificationOnlyPrompt()` | Parses ticket title+description → targeted API endpoints + DOM selectors to check |
| Security — Step 2 | `buildSecurityPrompt()` | Summarises raw security findings into structured comment for Linear |
| Benchmark — Step 2 | `buildPerformancePrompt()` | Interprets latency data + flags regressions with context |

The AI **never makes pass/fail decisions** — all verdicts are based on deterministic API + DOM check results. AI is used only for plan building and comment formatting.

---

## Room for Improvement

1. **Auto-detection of ticket type** — Currently `buildVerificationPlan()` uses regex on title/description to detect leaderboard, search, nav, trading tickets. A more robust classifier (keyword embedding or fine-tuned prompt) would handle ambiguous ticket titles more reliably.

2. **Persistent browser session in worker** — The browser worker currently navigates fresh for each DOM check. Reusing an already-loaded page session (with cookies/auth intact) and only re-navigating when the URL changes would cut DOM check time significantly.

3. **Screenshot diff on verify** — Capture a screenshot before and after a ticket fix and attach the diff image to the Linear comment, giving developers visual proof of the change rather than just pass/fail text.

4. **Multi-ticket batch verify** — Allow verifying all In Review tickets in a single run from the Linear board view. The panel could process them sequentially, streaming results per ticket and posting comments automatically.

5. **Test case persistence** — Store the verification plan (API endpoints + DOM selectors) generated for each ticket as a reusable test spec. When the same component is touched in a future ticket, the spec runs automatically as a regression check.

6. **Slack integration for failures** — On FAIL verdict, automatically post to the `#dev` Slack channel with the ticket link, failure details, and assigned developer tagged — eliminating the need for manual escalation.

7. **Coverage tracking** — Track which tickets have been QA-verified over time (by label, component, developer) and surface a coverage dashboard so the team can see QA throughput and recurring failure areas.

8. **Load test trigger from panel** — Add a fourth button that triggers the `creator-stress` load testing suite (port 3001) against the staging API and streams results directly into the panel, giving a full performance picture alongside the functional verify.
