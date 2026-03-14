# 🛡️ Coin Details Page — Regression Test Report

**Date:** 2026-03-14  
**Tester:** Chief QA (Automated + Manual)  
**Environment:** `dev.creator.fun` + `dev.bep.creator.fun`  
**Scope:** Full coin details page flow — API, UI, Charts, WebSocket, PnL, Transactions  
**Coins Tested:** CRX (Creator), MININO (The Washing Monkey), CALEO (ClawdBot AI), GROVEIFY (OpenClaw City)

---

## Executive Summary

| Category | Count |
|----------|-------|
| 🔴 Critical / High bugs | 3 |
| 🟡 Medium bugs | 2 |
| ✅ Already tracked | 2 |
| 📋 New Linear tickets filed | 5 |
| ⚠️ API endpoints failing | 4 |
| ✅ Features working correctly | 7 |

---

## 🔴 HIGH — New Bugs Filed

---

### CRX-959 — `/api/token?address=` returns empty data for ALL tokens

**Severity:** High  
**Status:** Filed → Todo  

**Summary:**  
`GET /api/token?address=:address` returns a response object with all fields as empty `{}` for every token address. Additionally, the alternative path format `/api/token/:address` returns **404 Not Found**.

**Reproduction:**
```bash
# Returns empty data — all fields {}
curl https://dev.bep.creator.fun/api/token?address=78QfQc8P8XTxUhU9z58PwFrnhnk9JvG9FEYnBc3geRDA

# Returns 404
curl https://dev.bep.creator.fun/api/token/78QfQc8P8XTxUhU9z58PwFrnhnk9JvG9FEYnBc3geRDA
```

**Actual Response:**
```json
{ "mcap": {}, "price": {}, "liquidity": {}, "volume": {}, "holders": {}, "ath": {}, "change1hr": 0, "change24h": 0 }
```

**Expected:**  
Rich token data matching what `/api/token/list` returns:
```json
{ "name": "Creator", "ticker": "CRX", "mcap": { "usd": 785.89, "sol": 4.56 }, "price": { "usd": 0.000000786 }, ... }
```

**Note:** The coin details page itself still renders data, suggesting the frontend uses WebSocket or an undocumented internal route. But the documented REST endpoint is broken for all consumers.

**Verified Across:** CRX, Minino, CALEO, GROVEIFY — all return empty.

---

### CRX-960 — `/api/rewards/graph` returns 404 — Rewards chart broken + server spam

**Severity:** High  
**Status:** Filed → Todo  

**Summary:**  
`GET /api/rewards/graph?userId=:userId` returns **404** on every request. The frontend retries this call every ~1–2 seconds, creating a continuous stream of failed requests that hammers the server unnecessarily.

**Console Error (repeating):**
```
Failed to load resource: 404
https://dev.bep.creator.fun/api/rewards/graph?userId=2QWEF61njb3q84vye669Lw9C6wa6GYXRuQFTBpMKX9om
```

**Impact:**
- Rewards chart on coin details page does not render for any user
- Server receives dozens of failed requests per minute per active user
- Creates misleading error noise in backend logs

**Affected Pages:** All `/details/:address` pages

---

### CRX-961 — `/api/profile/stats/trading` returns 404 — Invested/Holding/Sold/PnL all show $0.00

**Severity:** High  
**Status:** Filed → Todo  

**Summary:**  
`GET /api/profile/stats/trading?userId=:userId&period=0&tokenAddress=:address` returns **404**. This endpoint powers the top stats bar showing a user's Invested / Holding / Sold / PnL for each coin.

**Console Error (repeating):**
```
Failed to load resource: 404
https://dev.bep.creator.fun/api/profile/stats/trading?userId=2QWEF61...&period=0&tokenAddress=78QfQc...
```

**Visual Impact:**
```
Invested: $0.00   Holding: $0.00   Sold: $0.00   PnL: 0
```
All values zero even for users with open positions.

**Affected Pages:** All `/details/:address` pages when logged in

---

## 🟡 MEDIUM — New Bugs Filed

---

### CRX-962 — All coins show 0% price change across ALL timeframes globally

**Severity:** Medium  
**Status:** Filed → Todo  

**Summary:**  
Every coin on the platform shows **0.00%** for all price change indicators — 5M, 1H, 6H, 24H — regardless of actual trading activity. Tested across all 4 coins.

**Data Table:**

| Coin | 5M | 1H | 6H | 24H |
|------|-----|-----|-----|------|
| CRX | 0.00% | 0.00% | 0.00% | 0.00% |
| Minino | 0.00% | 0.00% | 0.00% | 0.00% |
| CALEO | 0.00% | 0.00% | 0.00% | 0.00% |
| GROVEIFY | 0.00% | 0.00% | 0.00% | 0.00% |

**Impact:**
- Momentum and trend signals broken for all traders
- Gainers / Losers / Top sort filters non-functional
- Platform feels like a dead market even with active trades

**Root Cause Hypothesis:**  
Price change calculation job (cron/worker) is not running, or the baseline snapshot price is not being captured/stored correctly.

---

### CRX-963 — TradingView chart Y-axis scale mismatch on CRX details page (~2,000x off)

**Severity:** Medium  
**Status:** Filed → Todo  

**Summary:**  
On the CRX coin details page, the TradingView chart Y-axis displays values in the **4,000–22,000 range**, while the OHLC header simultaneously shows `O:8.9789 H:8.9789 L:8.8713 C:8.8713`. These two values cannot both be correct — the candlesticks are rendering at approximately 2,000x the correct scale.

**Screenshot Evidence:** Captured at `dev.creator.fun/details/78QfQc8P8XTxUhU9z58PwFrnhnk9JvG9FEYnBc3geRDA`

**Root Cause Hypothesis:**  
Chart is receiving raw lamport-denominated prices instead of USD-converted prices specifically for the CRX platform token. Other coins (Minino, CALEO) render at correct scale.

**Affected Coins:** CRX specifically (not reproduced on Minino or CALEO)

---

## ✅ Already Tracked (Skipped — Not Duplicate Filed)

| Ticket | Description | Status |
|--------|-------------|--------|
| **CRX-888** | SVG `feBlend` `plus-lighter` unrecognized — fires 13+ times per page load | Open |
| **CRX-579** | Embedded wallet signup 400 error: "Please provide user id and wallet address" | Open |

---

## 📊 API Performance Audit

| Endpoint | Latency | Threshold | Status |
|----------|---------|-----------|--------|
| `GET /api/token/list?limit=20` | 1,009ms | 200ms | ❌ 5x over threshold |
| `GET /api/token?address=CRX` | 502ms | 200ms | ❌ 2.5x over + empty data |
| `GET /api/token?address=Minino` | 626ms | 200ms | ❌ 3x over + empty data |
| `GET /api/token?address=CALEO` | 872ms | 200ms | ❌ 4.3x over + empty data |
| `GET /api/token?address=GROVEIFY` | 620ms | 200ms | ❌ 3x over + empty data |
| `GET /api/rewards/graph` | N/A | — | ❌ 404 |
| `GET /api/profile/stats/trading` | N/A | — | ❌ 404 |
| `GET /api/onboarding/signup` | N/A | — | ❌ 400 |
| `GET /api/leaderboard/stats` | ~200ms | 200ms | ✅ OK |

**Industry Reference:** pump.fun ~25ms, axiom.trade ~45ms avg API response

---

## ✅ Working Correctly

| Feature | Status | Notes |
|---------|--------|-------|
| WebSocket connection | ✅ Connected | Footer shows "Online" |
| TradingView chart rendering (Minino, CALEO) | ✅ Renders | Candles visible, OHLC updates |
| Transaction feed | ✅ Working | Real trade history loads |
| Token metadata (name, ticker, image) | ✅ Working | Correct for all 4 coins |
| Buy/Sell panel | ✅ Renders | Buttons present, SOL balance shown |
| Market cap display (from list data) | ✅ Working | CRX $785.89, Minino $6.9 |
| 24H Volume display | ✅ Working | CRX $458.93, Minino $400.11 |
| Holder count | ✅ Working | CRX 24, others 10-11 |
| Social links (Twitter, Telegram) | ✅ Present | Visible on token cards |
| Dark mode / Theme toggle | ✅ Working | Footer toggle functional |
| Copy address button | ✅ Present | Truncated addresses with copy icon |

---

## 🔌 WebSocket Observations

- **Status:** Connected (footer "Online" indicator active)
- **Real-time data:** Price ticks visible in chart for active coins
- **No WebSocket errors** in console logs
- **Concern:** Despite WS connection, price change % is 0 — suggests WS delivers price ticks but the change calculation runs separately and is broken

---

## 📋 Transaction Data Integrity

Checked transaction rows on Minino and CRX details pages:

| Check | Result |
|-------|--------|
| Trade amounts mathematically consistent | ✅ USD = tokens × price per token |
| Transaction timestamps showing | ✅ "Xm ago" format |
| Wallet addresses shown (truncated) | ✅ Format: `Abc...xyz` |
| Buy/Sell type labelled | ✅ Green BUY / Red SELL |
| Market cap at time of trade shown | ✅ Each row shows MC at trade time |
| USD value $0.01 for micro-cap buys | ✅ Expected — tokens are micro-cap |

---

## 🎯 Priority Action Items for Dev Team

| Priority | Action |
|----------|--------|
| P1 | Fix `/api/rewards/graph` — endpoint does not exist (CRX-960) |
| P1 | Fix `/api/profile/stats/trading` — endpoint does not exist (CRX-961) |
| P1 | Fix `/api/token?address=` — returns empty objects (CRX-959) |
| P2 | Fix price change calculation — 0% across all coins globally (CRX-962) |
| P2 | Fix CRX chart Y-axis scale — 2,000x mismatch (CRX-963) |
| P3 | Reduce API response times — `token/list` at 1s is 5x over threshold |
| P3 | Fix SVG feBlend console spam — already tracked CRX-888 |

---

*Generated by Chief QA 🛡️ — dev.creator.fun Regression Audit — 2026-03-14*
