# QA Shield Upgrade Task

You are upgrading the QA Shield system. There are TWO issues to fix. Read all referenced files carefully before making changes.

---

## ISSUE 1 — VERIFY FIX: Must ONLY test what the ticket says was broken

The current `buildVerificationPlan()` in `backend/src/app/api/verify/route.ts` has two problems:
1. The AI system prompt lists **completely wrong API endpoints** that don't exist on dev.creator.fun — causing all API checks to return 404 and fail on things unrelated to the ticket
2. The fallback plan runs irrelevant generic checks (trending, leaderboard, search) when ticket keywords don't match — these have nothing to do with the fix being verified

### Correct dev.creator.fun API endpoints (replace ALL wrong ones in the system prompt):
```
GET /api/token/list?limit=20  → { data: [{name, ticker, mcap:{usd,sol,baseToken}, liquidity:{value,unit}, volume:{usd,buys,sells}, holders:{all}, change1hr, change24h, ath, banner, icon, address}], total, volume1h, volume24h }
GET /api/token/:address  → single token detail
GET /api/token/search?q=X  → { data: [...] }
GET /api/leaderboard/stats  → { tv:{current}, crxPrice, platformFeeRate, rewardsPercentage, platformRevenue, dollarRewardPool, totalCrxDistributed }
GET /api/rewards  → raw float (KNOWN BUG — returns raw number not JSON object)
```

DO NOT include /api/holdings, /api/user, /api/chat/messages, /api/wallet/balance, /api/tokens/trending — these endpoints DO NOT EXIST.

### Changes to `buildVerificationPlan` function in `backend/src/app/api/verify/route.ts`:

1. **Change the model** from `claude-haiku-4-20250514` to `claude-sonnet-4-20250514`

2. **Replace the ENTIRE system prompt** with one that:
   - Starts with this CRITICAL RULE at the very top: "STRICT SCOPE RULE: You must ONLY generate checks that directly verify what THIS specific ticket says was broken or fixed. If the ticket is about liquidity showing 0, ONLY check liquidity. If it is about a missing UI element, ONLY check that element exists and displays correctly. NEVER run generic platform health checks that are unrelated to the ticket. If nothing in the ticket is testable via API or DOM, return empty arrays."
   - Uses ONLY the correct API endpoints listed above
   - Explains the three check types clearly:
     - `apiChecks`: for tickets where the API returns wrong/missing data (check the actual API response fields)
     - `domChecks`: for tickets where a UI element is missing, wrong position, wrong style (check the DOM)
     - `crossChecks`: for tickets where the UI shows a wrong VALUE from the API (fetch API value + extract DOM displayed value + compare them)
   - Instructs: "Read the DEVELOPER COMMENTS section carefully — it tells you what was actually changed/fixed, which should narrow your verification scope even further"

3. **Pass issue comments to the AI** — in the user message content (in the messages array), after the ticket info, add:
   ```
   Developer comments:
   ${issue.comments?.nodes?.map(c => `[${c.user?.name || 'Dev'}]: ${c.body?.substring(0, 400)}`).join('\n') || 'None'}
   ```

4. **Fix `buildFallbackPlan`**: Replace the entire function body. When no keywords match, return:
   ```typescript
   plan.reasoning = 'Ticket scope unclear — no automatable checks could be derived. Manual verification required.';
   return plan; // all arrays empty
   ```
   Keep the existing keyword-based branches (leaderboard, balance/pill/chat) but fix them to use correct API endpoints.

---

## ISSUE 2 — PERFORMANCE BENCHMARK: Must compare SPECIFIC APIs, not homepages

The current benchmark hits root homepage URLs (https://dev.creator.fun, https://axiom.trade, https://pump.fun) — this is useless. It always shows the same generic comparison.

### Changes to `backend/src/lib/scanner.ts`:

Add this interface and function:

```typescript
export interface ApiEndpointBenchmark {
  name: string;
  ourEndpoint: string;
  ourAvg: number;
  ourP95: number;
  ourSamples: number[];
  competitorResults: {
    name: string;
    endpoint: string;
    avg: number;
    p95: number;
    samples: number[];
  }[];
  verdict: 'faster' | 'slower' | 'similar' | 'no_competitor_data';
  deltaMs: number;
  deltaPct: string;
}

export async function apiLevelBenchmark(samples = 3): Promise<ApiEndpointBenchmark[]> {
  // ...
}
```

The function benchmarks these endpoints (construct our URLs as `${process.env.STAGING_API_URL || 'https://dev.bep.creator.fun'}${ourEndpoint}`):

| name | ourEndpoint | competitorMappings |
|------|-------------|-------------------|
| Token List | /api/token/list?limit=20 | pump.fun: https://frontend-api.pump.fun/coins?limit=20&sort=last_trade_unix_timestamp&includeNsfw=false |
| Token Search | /api/token/search?q=test | pump.fun: https://frontend-api.pump.fun/coins?searchTerm=test&limit=10 |
| Leaderboard Stats | /api/leaderboard/stats | (no competitors) |
| Token Detail | /api/token/Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD | pump.fun: https://frontend-api.pump.fun/coins/Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD |

For each endpoint:
- Run `samples` measurements (default 3) with 300ms gap between each
- Use `AbortSignal.timeout(8000)` per request
- On error or timeout, record -1 for that sample
- Calculate avg and p95 from successful samples only (filter out -1 values)
- If all samples fail, avg = -1

Compare our avg vs fastest competitor avg:
- If diff > 200ms → verdict = 'slower', deltaMs = diff
- If diff < -200ms → verdict = 'faster', deltaMs = diff  
- Otherwise → verdict = 'similar'
- If no competitor data → verdict = 'no_competitor_data'
- deltaPct = percentage difference as string like "+23.4%" or "-15.2%"

### Changes to `backend/src/app/api/monitor/health/route.ts`:

In the POST handler:
1. Import `apiLevelBenchmark` from `@/lib/scanner`
2. Replace the 3 `benchmarkEndpoint` calls (staging homepage + axiom + pump) with a single call: `const apiBenchmarks = await apiLevelBenchmark(3);`
3. Send results as `send('api_benchmark', { results: apiBenchmarks })` instead of `send('benchmark', ...)`
4. Update step labels to be informative: "Benchmarking 4 API endpoints (3 samples each)..."
5. Remove step 3 entirely (the performance ticket creation was based on wrong data anyway)
6. Keep step 2 (post to Linear comment) but update it to call `formatPerformanceComment(apiBenchmarks)` with the new signature

### Changes to `backend/src/lib/ai.ts`:

1. Change `formatPerformanceComment` signature from `benchmark: { ours: any; axiom: any; pump: any }` to `benchmarks: ApiEndpointBenchmark[]`
   - Import the type: `import type { ApiEndpointBenchmark } from './scanner';`
   
2. Replace the table format with a per-API breakdown:
```
## ⚡ API Performance Benchmark

| Endpoint | Our Avg | Our P95 | Competitor | Their Avg | Delta | Verdict |
|----------|---------|---------|------------|-----------|-------|---------|
| Token List | 234ms | 445ms | pump.fun | 189ms | +45ms | ⚠️ Slower |
| Token Search | 167ms | 280ms | pump.fun | 145ms | +22ms | ✅ Similar |
| Leaderboard Stats | 89ms | 134ms | — | — | — | ✅ No baseline |
| Token Detail | 312ms | 567ms | pump.fun | 198ms | +114ms | ⚠️ Slower |

(3 samples per endpoint)
```

Use `N/A` for endpoints with no competitor data. Show the fastest competitor in the table.
Verdict emoji: ⚠️ for slower, ✅ for faster or similar/no_data.
Add a summary line at the bottom: "X of Y endpoints are slower than competitors" or "All endpoints performing competitively."

3. Update `buildVerificationPrompt` in ai.ts — it currently receives `benchmark: { ours: any; axiom: any; pump: any }`. Change the parameter type to `benchmarks: ApiEndpointBenchmark[]` and update the performance section in the prompt string to show the per-API data instead of the generic frontend comparison.

---

## IMPORTANT RULES:
- Do NOT touch extension/ files or browser-worker/ files
- Do NOT break the SSE event structure
- After all changes, run: `cd backend && npm run build 2>&1 | tail -40` and fix ALL TypeScript errors
- Make sure all imports are correct

When completely finished and the TypeScript build passes, run:
`openclaw system event --text "Done: QA Shield upgraded — verify fix scoped correctly + API-level benchmark ready. Build passing." --mode now`
