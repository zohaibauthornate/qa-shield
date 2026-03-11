# QA Shield — Mastermind Analysis & Upgrade Plan
**Author:** Chief QA 🛡️  
**Date:** March 11, 2026

---

## PART 1: CURRENT CRITERIA — WHAT QA SHIELD ACTUALLY DOES TODAY

### Performance Testing (Current)
**File:** `backend/src/lib/scanner.ts` → `apiLevelBenchmark()`  
**Trigger:** POST `/api/monitor/health` from extension

**What it measures:**
- Fetches 4 hardcoded API endpoints × 3 samples each
- Calculates avg + p95 per endpoint
- Compares to pump.fun equivalents only
- Verdict: slower/faster/similar/no_competitor_data (threshold: ±200ms delta)
- Posts markdown table to Linear comment (no ticket creation)

**4 endpoints benchmarked:**
1. `/api/token/list?limit=20` vs pump.fun coins list
2. `/api/token/search?q=test` vs pump.fun search
3. `/api/leaderboard/stats` (no competitor)
4. `/api/token/:address` vs pump.fun coin detail

---

### Security Testing (Current)
**File:** `backend/src/lib/scanner.ts` → `scanEndpoint()`  
**File:** `backend/src/app/api/security/scan/route.ts`  
**Trigger:** POST `/api/security/scan` from extension

**What it checks (4 checks per endpoint):**
1. **CORS** — OPTIONS request with `Origin: https://evil-site.com`, checks reflect + credentials
2. **Auth** — Unauthenticated GET, checks for 401/403. If 200, scans body for `userId`, `email`, `wallet` keywords
3. **Headers** — Checks HSTS, X-Content-Type-Options, X-Frame-Options (HEAD request)
4. **Data Exposure** — Regex patterns: `password`, `secret`, `private_key`, `api_key`, JWT tokens

**9 endpoints scanned (DEFAULT_ENDPOINTS):**
`/api/token`, `/api/watchlist`, `/api/user`, `/api/chat`, `/api/trade`, `/api/holdings`, `/api/leaderboard`, `/api/rewards`, `/api/fees`

**Linear auto-filing:** YES — creates tickets for critical/high findings, deduplicates by title similarity

---

## PART 2: WHAT'S BROKEN RIGHT NOW

### 🔴 Critical Bugs in Security Scanner

**BUG 1: Scanning 5 non-existent endpoints**
`/api/user`, `/api/chat`, `/api/trade`, `/api/holdings`, `/api/fees` → all return 404.  
A 404 endpoint "passes" the auth check (not accessible = treated as protected). This is a FALSE PASS — we're marking broken endpoints as secure.  
**Fix:** Update DEFAULT_ENDPOINTS to only real endpoints.

**BUG 2: `wallet` keyword causes false-positive auth failures**  
The auth check scans for `wallet` in response body. EVERY token response contains `creatorWallet` field → always triggers "Endpoint returns user-specific data WITHOUT authentication" → creates Critical security tickets for public endpoints.  
This is why we have 10 duplicate CORS+Auth tickets (CRX-871 through CRX-880).  
**Fix:** Use field-path matching, not substring search. Check for `"walletAddress"`, `"privateKey"` etc.

**BUG 3: Duplicate detection too loose → 10 duplicate tickets created**  
`findSimilarIssue()` does fuzzy title matching — "CORS reflects arbitrary origin" matched too broadly. Created CRX-865 + CRX-871-880 = 11 total CORS tickets.  
**Fix:** Deduplicate by finding TYPE + endpoint hash before any Linear call. One entry per (check_type, endpoint) pair.

**BUG 4: Rate-limit check not implemented**  
The `SecurityCheckResult` type includes `'rate-limit'` but `scanEndpoint()` never calls it. Rate limiting is one of the most critical checks for a Web3 platform (scraping, enumeration). Currently never tested.  
**Fix:** Implement `checkRateLimit()` — fire 5 rapid requests, check for 429 or throttling.

**BUG 5: Headers check misses CSP and x-powered-by**  
Currently only checks 3 headers: HSTS, X-Content-Type-Options, X-Frame-Options.  
Missing: Content-Security-Policy, X-Powered-By (tech fingerprinting), Referrer-Policy.  
**Fix:** Add 3 more header checks.

---

### 🔴 Critical Bugs in Performance Benchmarker

**BUG 6: Token Detail uses wrong API path**  
`ourPath: '/api/token/Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD'`  
Actual API is: `/api/token?address=Ffyi2x1...` (query param, not path segment).  
Token Detail benchmark is hitting a 404 → always returns -1 timing.  
**Fix:** Change to `/api/token?address=Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD`

**BUG 7: No axiom.trade comparison**  
Competitor list only has pump.fun. axiom.trade is also a direct competitor.  
**Fix:** Add axiom.trade endpoints.

**BUG 8: 200ms verdict threshold is too loose**  
478ms vs 22ms = 21x slower = verdict "slower" ✅  
But the threshold means anything within 200ms is "similar" — 220ms vs 22ms (10x slower) would still be "slower" but barely.  
This is fine but the percentage delta should also be reported — 200ms slower at 22ms baseline = 909% slower, which is critical.  
**Fix:** Add percentage threshold: if >500% slower = critical performance issue, auto-file ticket.

**BUG 9: No performance regression tracking**  
No baseline stored. Can't detect if things got 2x slower since last week.  
**Fix:** Store benchmark results in JSON file, compare to last run.

---

### 🟡 Missing Features (Not Bugs — Just Not Built Yet)

**MISSING 1: Web3-specific security checks**
- No Solana address validation in responses
- No private key pattern detection (base58 58-char strings)
- No seed phrase detection (12/24 word BIP-39 patterns)
- No transaction replay attack check
- No wallet drainer JavaScript pattern detection

**MISSING 2: Page performance (Core Web Vitals)**
- No LCP, FCP, CLS measurement
- No time-to-interactive tracking
- No bundle size analysis

**MISSING 3: WebSocket testing**
- No WS connection test
- No WS message latency
- No WS reconnection behavior
- Real-time data is critical for this platform — completely untested

**MISSING 4: Payload size analysis**
- No response size tracking
- Large JSON responses slow mobile users

**MISSING 5: Concurrent load test**
- Sequential samples only (no parallel)
- Can't detect concurrency bugs or degradation under load

**MISSING 6: Proper report generation**
- No structured HTML/MD report output
- Linear tickets filed but no consolidated report
- No tracking of what passed vs failed over time
- Manual tests not recorded anywhere

**MISSING 7: Auto-ticket creation for performance regressions**
- Removed in v0.4 (it was creating bad tickets)
- Needs to come back but with proper dedup + only when >5x slower

---

## PART 3: MASTERMIND APPROACH — HOW TO MAKE IT A SOLID AUTOMATED WEB3 SENIOR TESTER

### Architecture: 3 Pillars

```
QA Shield v1.0
├── 🔒 SECURITY ENGINE
│   ├── checkCORS()          ✅ exists (fix false positives)
│   ├── checkAuth()          ✅ exists (fix keyword scan)  
│   ├── checkHeaders()       ✅ exists (add CSP, x-powered-by)
│   ├── checkDataExposure()  ✅ exists (add Web3 patterns)
│   ├── checkRateLimit()     ❌ MISSING — implement
│   ├── checkInputValidation() ❌ MISSING — XSS, SQLi, path traversal
│   └── checkWeb3Patterns()  ❌ MISSING — keys, seeds, wallet drainers
│
├── ⚡ PERFORMANCE ENGINE
│   ├── apiLevelBenchmark()  ✅ exists (fix endpoint, add axiom)
│   ├── payloadAnalysis()    ❌ MISSING
│   ├── webSocketBenchmark() ❌ MISSING
│   ├── concurrentLoadTest() ❌ MISSING
│   └── regressionTracker()  ❌ MISSING
│
└── 📊 REPORT ENGINE
    ├── Linear auto-filing   ✅ exists (fix deduplication)
    ├── HTML report          ❌ MISSING
    ├── Pass/fail tracking   ❌ MISSING
    └── Trend analysis       ❌ MISSING
```

### Priority Fix Order (What to Build First)

**Phase 1 — Fix Broken Things (2-3 hours)**
1. Fix DEFAULT_ENDPOINTS (remove 5 non-existent paths)
2. Fix Token Detail benchmark path
3. Fix auth keyword false positives (`wallet` → `walletAddress`, `privateKey`)
4. Fix duplicate detection (hash by check_type + endpoint, not fuzzy title)
5. Implement `checkRateLimit()` — 5 rapid requests, check for 429

**Phase 2 — Make Security World-Class (4-6 hours)**
6. Add CSP + x-powered-by + Referrer-Policy to header checks
7. Add `checkInputValidation()` — XSS via search, SQL injection, path traversal
8. Add Web3 patterns: private key (base58), seed phrase, transaction signing patterns
9. Add `checkWeb3Auth()` — verify wallet signature required for sensitive ops

**Phase 3 — Make Performance World-Class (4-6 hours)**
10. Add axiom.trade competitor endpoints
11. Add `payloadAnalysis()` — track response size, gzip compression ratio
12. Add `regressionTracker()` — save JSON baseline, compare on each run
13. Add percentage-based performance severity (>500% = auto-file ticket)
14. Add `webSocketBenchmark()` — connect to WS, measure first message latency

**Phase 4 — Report Engine (2-3 hours)**
15. Generate structured Markdown report per run
16. Report includes: summary table, all test results (pass/fail/manual), Linear tickets filed
17. Save to `reports/YYYY-MM-DD-HH.md`
18. Post report link as Linear comment
19. Add trend chart data (JSON) for dashboard display

---

## PART 4: WHAT THE FIXED SECURITY SCANNER SHOULD CHECK

### Updated Endpoint List (Real Endpoints Only)
```
/api/token/list?limit=5
/api/token/search?q=test
/api/token?address=<test_token>
/api/leaderboard
/api/leaderboard/stats
/api/rewards
```

### Full Check Matrix (per endpoint)
| Check | What | Pass Criteria |
|-------|------|---------------|
| CORS | OPTIONS with evil origin | Origin not reflected OR credentials=false |
| Auth | GET without token | 401/403 OR no user-specific fields |
| Headers | HEAD request | HSTS + X-Content-Type + X-Frame + CSP + no x-powered-by |
| Data Exposure | Body scan | No password/secret/privateKey/seed/JWT |
| Rate Limit | 5 rapid GETs | At least one 429 within 10 rapid requests |
| Input | Inject via search params | No XSS reflection, no SQLi error messages |
| Web3 | Body scan | No base58 private keys, no seed phrases |

### Deduplication Strategy (Fixed)
```
For each finding:
  key = hash(check_type + endpoint_path)  // e.g., "cors:/api/token"
  if key in filed_this_session: SKIP
  elif findExistingLinearTicket(key): SKIP + log "existing: CRX-XXX"
  else: CREATE ticket + add key to session set
```

---

## PART 5: WHAT THE FIXED PERFORMANCE BENCHMARKER SHOULD DO

### Updated Endpoint Mappings
```
Token List:    /api/token/list?limit=20
  vs pump.fun: frontend-api.pump.fun/coins?limit=20&sort=last_trade_unix_timestamp
  vs axiom:    api2.axiom.trade/solana/v2/tokens?limit=20&sortBy=volume24h

Token Search:  /api/token/search?q=test
  vs pump.fun: frontend-api.pump.fun/coins?searchTerm=test&limit=10

Token Detail:  /api/token?address=Ffyi2x1...    ← FIXED PATH
  vs pump.fun: frontend-api.pump.fun/coins/Ffyi2x1...

Leaderboard:   /api/leaderboard/stats
  (no competitor)
```

### Severity Tiers (Fixed Thresholds)
| Delta | Verdict | Action |
|-------|---------|--------|
| <200ms | Similar | ✅ Pass |
| 200–500ms | Slower | ⚠️ Warn |
| >500ms OR >300% | Critical | ❌ Auto-file performance ticket |
| >2000ms | Severe | 🚨 Critical ticket + Slack alert |

### Report Output (Per Run)
```
## ⚡ Performance Benchmark — 2026-03-11 22:15 PKT
3 samples per endpoint | Baseline vs pump.fun + axiom.trade

| Endpoint      | Ours (avg) | Ours (p95) | pump.fun | axiom.trade | % Slower | Verdict |
|---------------|-----------|------------|---------|------------|---------|---------|
| Token List    | 478ms     | 521ms      | 22ms    | 45ms       | +2072%  | 🚨 SEVERE |
| Token Search  | 330ms     | 360ms      | 22ms    | —          | +1400%  | ❌ Critical |
| Token Detail  | 362ms     | 380ms      | 21ms    | —          | +1624%  | ❌ Critical |
| Leaderboard   | 481ms     | 510ms      | —       | —          | N/A     | ✅ No baseline |

Payload sizes:
| Endpoint     | Size   | Gzipped | Compression |
|--------------|--------|---------|-------------|
| Token List   | 18.2KB | 4.1KB   | 77% ✅      |
| Token Detail | 2.3KB  | 0.8KB   | 65% ✅      |

Regression vs last run (2026-03-10):
| Endpoint    | Last  | Now   | Change |
|-------------|-------|-------|--------|
| Token List  | 420ms | 478ms | +14% ⚠️|
```

---

## PART 6: PROPER REPORT STRUCTURE (Beyond Linear Tickets)

Every QA Shield run should produce a structured report with this format:

```markdown
# QA Shield Run Report
Date: YYYY-MM-DD HH:MM PKT
Triggered by: [manual | cron | ticket-verify]
Target: dev.creator.fun / dev.bep.creator.fun

## Executive Summary
| Category        | Pass | Warn | Fail | Total |
|-----------------|------|------|------|-------|
| Security        |  2   |  1   |  4   |   7   |
| Performance     |  1   |  0   |  3   |   4   |
| Verification    |  3   |  0   |  1   |   4   |

## Linear Actions
| Action          | Ticket  | Title                  |
|-----------------|---------|------------------------|
| Created         | CRX-904 | No rate limiting...    |
| Existing (skip) | CRX-865 | CORS reflects origin   |
| Comment posted  | CRX-892 | Performance data       |

## Security Findings
[full detail per endpoint per check]

## Performance Findings  
[full benchmark table with regression comparison]

## Verification Results
[per-ticket: pass/fail/manual + steps executed]

## Manual Verification Required
[items that need human/wallet interaction]

## Next Actions
1. [HIGH] Fix rate limiting — assign to backend team
2. [HIGH] Fix Token List performance — 21x slower than pump.fun
```

---

## PART 7: IMPLEMENTATION PLAN (Prioritized)

### Sprint 1 (Do Now — Fixes Only)
- [ ] Fix DEFAULT_ENDPOINTS (remove non-existent ones)
- [ ] Fix Token Detail benchmark path
- [ ] Fix auth keyword false positives
- [ ] Fix duplicate detection (hash-based, not fuzzy title)
- [ ] Implement `checkRateLimit()`

### Sprint 2 (This Week — Web3 Hardening)
- [ ] Add CSP, x-powered-by, Referrer-Policy checks
- [ ] Add `checkInputValidation()` (XSS/SQLi)
- [ ] Add Web3 pattern detection (private keys, seeds)
- [ ] Add axiom.trade competitor endpoints
- [ ] Add payload size + gzip tracking

### Sprint 3 (Next Week — Intelligence)
- [ ] Add regression tracking (save/compare baselines)
- [ ] Add WebSocket benchmark
- [ ] Add concurrent load test (3 parallel)
- [ ] Generate structured MD report per run
- [ ] Re-enable performance auto-ticket creation with proper dedup

---

*Generated by Chief QA 🛡️ — March 11, 2026*
