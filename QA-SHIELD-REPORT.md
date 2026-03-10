# QA Shield — Extension Report

**Owner:** Chief QA (zohaib@authornate.com)
**Date:** March 2026
**Platform:** Chrome Extension (MV3) + Next.js Backend + Playwright Browser Worker

---

## Core Idea

creator.fun is being rebuilt with AI. More code ships faster — but quality control can't keep up manually.

**QA Shield bridges that gap.** It sits inside Linear and automates the full QA cycle: enriching tickets for developers, verifying fixes, scanning for security issues, and benchmarking APIs — all without leaving the ticket page.

> **AI writes the code. QA Shield makes sure it works.**

---

## How It Works

A floating panel injects into every Linear ticket. Four independent actions:

| Action | Who It's For | What It Does |
|---|---|---|
| **Enrich Ticket** | Developer | Analyzes the ticket, posts structured context + fix hints |
| **Verify Fix** | QA | Tests the fix against staging, moves ticket to Done or Todo |
| **Security Scan** | QA / Dev | Runs OWASP checks, creates bug tickets for findings |
| **Benchmark** | QA / Dev | Hits API endpoints, flags performance regressions |

Each action streams live progress via SSE — no waiting, results appear step by step.

---

## Enrich Ticket

**Purpose:** Give developers everything they need before writing a single line of code.

A developer opens a ticket, clicks **Enrich**, and gets a comment posted with:

- Plain-language summary of the problem
- Exact steps to reproduce on dev.creator.fun
- Expected vs actual behaviour
- Affected components, files, and API endpoints
- Suggested fix approach with code-level hints
- Test cases to verify the fix is complete

They hand the enriched ticket to an AI coding agent (Cursor, Copilot, Claude Code) and ship the fix in one pass — no back-and-forth, no re-reading vague descriptions.

---

## Verify Fix

**Purpose:** Confirm a fix is real before marking it Done.

Steps (streamed live):
1. Fetch ticket from Linear
2. Build verification plan — AI maps ticket to specific API + DOM checks
3. Run API checks — hit staging endpoints, validate response shape
4. Run DOM checks — headless browser inspects the live page
5. Run transaction checks — if the ticket involves trading or wallet logic
6. **PASS** → post verification comment + move to Done
   **FAIL** → post failure details + move back to Todo

---

## Security Scan

**Purpose:** Catch OWASP-class vulnerabilities before they reach production.

Checks: CORS policy, security headers, auth endpoints, exposed API keys, open routes.

- Posts a security comment on the ticket
- Creates new Linear tickets for each finding (with Security + Bug labels)
- Skips duplicates — never creates the same ticket twice

---

## Benchmark

**Purpose:** Catch API performance regressions at the ticket level.

Hits core endpoints: tokens, leaderboard, trades, search.

- `< 200ms` → ✅ Good
- `200–500ms` → ⚠️ Warn
- `> 500ms` → ❌ Fail

Posts a performance comment and creates a ticket if regressions are found.

---

## Architecture

```
Chrome Extension  →  Next.js Backend (port 3000)  →  Browser Worker (port 3099)
                          │                                    │
                   Linear + Anthropic API           Playwright (headless Chromium)
                                                    dev.creator.fun / dev.bep.creator.fun
```

---

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Read ticket identifier from the Linear URL |
| `scripting` | Inject the floating panel |
| `storage` | Save backend URL setting locally |
| `host_permissions` (localhost:3000) | Talk to the local backend without CORS issues |

**All data stays local.** Extension → localhost backend → staging API. Nothing goes to third-party servers. API keys live in `.env.local` on the backend only.

---

## Room for Improvement

1. **Smarter ticket detection** — regex-based type detection breaks on ambiguous titles; a proper classifier would handle edge cases
2. **Reuse browser session** — worker navigates fresh each time; reusing the loaded page would be faster
3. **Screenshot diff** — attach before/after screenshots to the verify comment for visual proof
4. **Batch verify** — verify all In Review tickets in one run from the board view
5. **Persistent test specs** — save the verification plan per ticket as a reusable regression test
6. **Auto-escalate failures to Slack** — post to `#dev` on FAIL with the dev tagged
7. **Coverage dashboard** — track QA throughput and recurring failure patterns over time
8. **Load test button** — trigger the `creator-stress` suite inline from the panel
