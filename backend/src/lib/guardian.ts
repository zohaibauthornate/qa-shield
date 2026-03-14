/**
 * QA Shield Guardian — Always-On Background Scanner
 * Runs security + performance scans, deduplicates, auto-files Linear tickets
 * State tracked in: /tmp/qa-shield-state.json (persisted across runs)
 */

import { scanEndpoint, apiLevelBenchmark, shouldFilePerformanceTicket, type SecurityScanResult } from './scanner';
import { createIssue, findSimilarIssue, addComment, LABELS, WORKFLOW_STATES } from './linear';
import { getTicketContext } from './github';
import * as fs from 'fs';
import * as path from 'path';

// ============ State Management ============

const STATE_FILE = process.env.GUARDIAN_STATE_FILE || '/tmp/qa-shield-guardian-state.json';

interface FiledIssue {
  fingerprint: string;         // unique hash of issue type + endpoint
  linearId: string;            // Linear ticket ID e.g. CRX-870
  title: string;
  filedAt: string;
  severity: string;
  resolvedAt?: string;
}

interface GuardianState {
  lastScanAt: string | null;
  lastCleanScanAt: string | null;
  scanCount: number;
  filedIssues: FiledIssue[];   // issues we've filed — don't re-file these
  resolvedFingerprints: string[];  // issues that passed on last scan — can re-file if they regress
  lastGithubCommit: string | null; // last staging commit SHA we saw
  stats: {
    totalScans: number;
    totalIssuesFiled: number;
    totalCriticalFound: number;
  };
}

function loadState(): GuardianState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Guardian] Failed to load state:', e);
  }
  return {
    lastScanAt: null,
    lastCleanScanAt: null,
    scanCount: 0,
    filedIssues: [],
    resolvedFingerprints: [],
    lastGithubCommit: null,
    stats: { totalScans: 0, totalIssuesFiled: 0, totalCriticalFound: 0 },
  };
}

function saveState(state: GuardianState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[Guardian] Failed to save state:', e);
  }
}

// ============ Fingerprinting ============

function makeFingerprint(type: string, endpoint: string, checkType: string): string {
  // Normalize endpoint (strip query params for stable fingerprinting)
  const normalizedEndpoint = endpoint.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  return `${type}::${normalizedEndpoint}::${checkType}`;
}

// ============ Finding Types ============

export interface SecurityFinding {
  fingerprint: string;
  title: string;
  description: string;
  endpoint: string;
  checkType: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  details: string;
}

export interface PerformanceFinding {
  fingerprint: string;
  title: string;
  description: string;
  endpoint: string;
  severity: 'critical' | 'high' | 'medium';
  ourAvg: number;
  competitorAvg: number;
  deltaPct: number;
}

export interface GuardianScanResult {
  scanId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  securityFindings: SecurityFinding[];
  performanceFindings: PerformanceFinding[];
  newIssuesFiled: { identifier: string; title: string; url: string; severity: string }[];
  skippedDuplicates: number;
  overallHealth: 'healthy' | 'warning' | 'critical';
  summary: string;
}

// ============ Scan Endpoints ============

const SCAN_ENDPOINTS = [
  '/api/token/list?limit=5',
  '/api/token/search?q=test',
  '/api/token?address=Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD',
  '/api/leaderboard',
  '/api/leaderboard/stats',
  '/api/rewards',
];

// ============ Main Guardian Scan ============

export async function runGuardianScan(options: {
  fileTickets?: boolean;
  slackAlert?: boolean;
  minSeverityToFile?: 'critical' | 'high' | 'medium' | 'low';
} = {}): Promise<GuardianScanResult> {
  const {
    fileTickets = true,
    minSeverityToFile = 'high',
  } = options;

  const scanId = `scan-${Date.now()}`;
  const startedAt = new Date().toISOString();
  const state = loadState();
  const apiBase = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';

  console.log(`[Guardian] Starting scan ${scanId}`);

  const securityFindings: SecurityFinding[] = [];
  const performanceFindings: PerformanceFinding[] = [];
  const newIssuesFiled: { identifier: string; title: string; url: string; severity: string }[] = [];
  let skippedDuplicates = 0;

  // ── 1. Security Scan ──
  try {
    const scanResults = await Promise.all(
      SCAN_ENDPOINTS.map(ep => scanEndpoint(`${apiBase}${ep}`))
    );

    for (const result of scanResults) {
      for (const check of result.checks) {
        if (check.status === 'pass') continue;
        if (check.severity === 'low' && minSeverityToFile !== 'low') continue;

        const epShort = result.endpoint.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
        const fingerprint = makeFingerprint('security', result.endpoint, check.type);

        const title = `[Security] ${formatCheckType(check.type)} on ${epShort}`;
        const description = buildSecurityDescription(result.endpoint, check);

        securityFindings.push({
          fingerprint,
          title,
          description,
          endpoint: result.endpoint,
          checkType: check.type,
          severity: check.severity,
          details: check.details,
        });
      }
    }
  } catch (err) {
    console.error('[Guardian] Security scan error:', err);
  }

  // ── 2. Performance Benchmark ──
  try {
    const benchmarks = await apiLevelBenchmark(2); // 2 samples for speed

    for (const benchmark of benchmarks) {
      const decision = shouldFilePerformanceTicket(benchmark, undefined);
      if (!decision.shouldFile) continue;

      const fingerprint = makeFingerprint('performance', benchmark.name, 'slow');
      const fastestComp = benchmark.competitorResults
        .filter(c => c.avg >= 0)
        .sort((a, b) => a.avg - b.avg)[0];

      const title = `[Performance] ${benchmark.name} is ${decision.deltaPct}% slower than ${fastestComp?.name || 'competitors'}`;
      const description = buildPerformanceDescription(benchmark, decision);

      performanceFindings.push({
        fingerprint,
        title,
        description,
        endpoint: benchmark.name,
        severity: decision.severity,
        ourAvg: benchmark.ourAvg,
        competitorAvg: fastestComp?.avg ?? -1,
        deltaPct: decision.deltaPct,
      });
    }
  } catch (err) {
    console.error('[Guardian] Performance scan error:', err);
  }

  // ── 3. Auto-file Linear tickets ──
  if (fileTickets) {
    const allFindings = [
      ...securityFindings.map(f => ({ ...f, label: 'security' as const })),
      ...performanceFindings.map(f => ({ ...f, label: 'performance' as const })),
    ];

    for (const finding of allFindings) {
      // Skip if we already filed this issue and it hasn't been resolved
      const alreadyFiled = state.filedIssues.find(
        fi => fi.fingerprint === finding.fingerprint && !fi.resolvedAt
      );
      if (alreadyFiled) {
        skippedDuplicates++;
        console.log(`[Guardian] Skipping duplicate: ${finding.fingerprint} (already filed as ${alreadyFiled.linearId})`);
        continue;
      }

      // Skip low-severity unless configured
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      const minOrder = severityOrder[minSeverityToFile];
      const findingOrder = severityOrder[finding.severity as keyof typeof severityOrder] ?? 3;
      if (findingOrder > minOrder) {
        continue;
      }

      // Check Linear for similar existing tickets before filing
      try {
        const similar = await findSimilarIssue(finding.title);
        if (similar && !['canceled', 'done'].includes(similar.state.name.toLowerCase())) {
          skippedDuplicates++;
          // Register in state so we don't check Linear again next run
          state.filedIssues.push({
            fingerprint: finding.fingerprint,
            linearId: similar.identifier,
            title: similar.title,
            filedAt: new Date().toISOString(),
            severity: finding.severity,
          });
          console.log(`[Guardian] Similar ticket exists: ${similar.identifier} — skipping`);
          continue;
        }
      } catch (e) {
        // Continue — don't block filing on search error
      }

      // File the ticket
      try {
        const priority = finding.severity === 'critical' ? 1 : finding.severity === 'high' ? 2 : 3;
        const labelIds = finding.label === 'security'
          ? [LABELS.SECURITY, LABELS.BUG]
          : [LABELS.BACKEND]; // performance tickets get Backend label

        const issue = await createIssue({
          title: finding.title,
          description: finding.description,
          priority,
          labelIds,
          stateId: WORKFLOW_STATES.TODO,
        });

        newIssuesFiled.push({
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          severity: finding.severity,
        });

        state.filedIssues.push({
          fingerprint: finding.fingerprint,
          linearId: issue.identifier,
          title: issue.title,
          filedAt: new Date().toISOString(),
          severity: finding.severity,
        });

        state.stats.totalIssuesFiled++;
        if (finding.severity === 'critical') state.stats.totalCriticalFound++;

        // Post AI fix prompt as a comment — devs can copy-paste into Cursor/Claude Code
        try {
          const aiPrompt = buildAIFixPrompt(
            finding.label as 'performance' | 'security',
            finding.title,
            finding.description,
            finding.label === 'performance' ? (finding as any).endpoint : undefined
          );
          await addComment(issue.id, aiPrompt);
          console.log(`[Guardian] AI fix prompt posted to ${issue.identifier}`);
        } catch (promptErr) {
          console.warn(`[Guardian] Could not post AI fix prompt for ${issue.identifier}:`, promptErr);
        }

        console.log(`[Guardian] Filed: ${issue.identifier} — ${finding.title}`);
      } catch (err) {
        console.error(`[Guardian] Failed to file ticket for ${finding.fingerprint}:`, err);
      }
    }
  }

  // ── 4. Update state ──
  state.lastScanAt = new Date().toISOString();
  state.scanCount++;
  state.stats.totalScans++;

  const hasCritical = securityFindings.some(f => f.severity === 'critical') ||
    performanceFindings.some(f => f.severity === 'critical');
  const hasHigh = securityFindings.some(f => f.severity === 'high') ||
    performanceFindings.some(f => f.severity === 'high');

  if (!hasCritical && !hasHigh) {
    state.lastCleanScanAt = new Date().toISOString();
  }

  saveState(state);

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - new Date(startedAt).getTime();

  const overallHealth: 'healthy' | 'warning' | 'critical' =
    hasCritical ? 'critical' : hasHigh ? 'warning' : 'healthy';

  const summary = buildSummary(securityFindings, performanceFindings, newIssuesFiled, skippedDuplicates);

  console.log(`[Guardian] Scan complete in ${durationMs}ms — ${summary}`);

  return {
    scanId,
    startedAt,
    completedAt,
    durationMs,
    securityFindings,
    performanceFindings,
    newIssuesFiled,
    skippedDuplicates,
    overallHealth,
    summary,
  };
}

// ============ Helpers ============

function formatCheckType(type: string): string {
  const map: Record<string, string> = {
    cors: 'CORS Misconfiguration',
    auth: 'Missing Authentication',
    headers: 'Missing Security Headers',
    'data-exposure': 'Sensitive Data Exposure',
    'rate-limit': 'No Rate Limiting',
    'input-validation': 'Missing Input Validation',
  };
  return map[type] || type.toUpperCase();
}

function buildSecurityDescription(endpoint: string, check: { type: string; details: string; severity: string }): string {
  const epShort = endpoint.replace(/^https?:\/\/[^/]+/, '');
  return `## 🔒 Security Issue — Auto-detected by QA Shield Guardian

**Endpoint:** \`${epShort}\`
**Check Type:** ${formatCheckType(check.type)}
**Severity:** ${check.severity.toUpperCase()}

### Finding
${check.details}

### Why This Matters
${getSecurityContext(check.type)}

### How to Verify
\`\`\`bash
curl -si -H "Origin: https://evil-site.com" "${endpoint}" | grep -i "access-control"
\`\`\`

### Expected Fix
${getSecurityFix(check.type)}

---
*Auto-filed by QA Shield Guardian 🛡️ at ${new Date().toISOString()}*`;
}

function buildPerformanceDescription(
  benchmark: {
    name: string;
    ourAvg: number;
    ourEndpoint?: string;
    samples?: number[];
    competitorResults: { name: string; avg: number; endpoint: string; samples?: number[] }[];
  },
  decision: { reason: string; deltaPct: number; severity: string }
): string {
  const now = new Date().toISOString();
  const validComps = benchmark.competitorResults.filter(c => c.avg >= 0).sort((a, b) => a.avg - b.avg);
  const fastest = validComps[0];
  const slowest = validComps[validComps.length - 1];

  // Waterfall comparison table
  const allResults = [
    { name: '🔴 Creator.fun (us)', avg: benchmark.ourAvg, samples: benchmark.samples },
    ...validComps.map(c => ({ name: `✅ ${c.name}`, avg: c.avg, samples: c.samples })),
  ].sort((a, b) => a.avg - b.avg);

  const tableRows = allResults.map(r => {
    const pct = r.avg === benchmark.ourAvg && benchmark.ourAvg !== allResults[0].avg
      ? ` (+${decision.deltaPct}%)`
      : r.avg === allResults[0].avg ? ' (fastest)' : '';
    const bar = '█'.repeat(Math.min(20, Math.round(r.avg / 100)));
    return `| ${r.name} | **${r.avg}ms** | ${bar}${pct} |`;
  }).join('\n');

  // Percentile stats if samples available
  let percentilesSection = '';
  if (benchmark.samples && benchmark.samples.length > 1) {
    const sorted = [...benchmark.samples].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1];
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1];
    percentilesSection = `\n### Latency Percentiles (Creator.fun)\n| P50 | P95 | P99 | Samples |\n|-----|-----|-----|------|\n| ${p50}ms | ${p95}ms | ${p99}ms | ${sorted.length} |\n`;
  }

  // Severity-based impact text
  const impactMap: Record<string, string> = {
    critical: '🚨 **Critical** — Users experience visible lag on every page load. In meme coin trading, a 500ms delay causes traders to miss price action and switch to faster platforms (Axiom, Pump.fun). This is directly costing trades.',
    high: '⚠️ **High** — Noticeable slowness on active trading sessions. Users on mobile or slower connections will experience frustrating wait times.',
    medium: '📊 **Medium** — Measurable performance gap vs competitors. While not blocking, this compounds with other latency sources and degrades perceived app quality.',
  };

  // Root cause hypotheses based on endpoint name
  const epLower = benchmark.name.toLowerCase();
  let rootCauseHypotheses = '';
  if (epLower.includes('token') || epLower.includes('list')) {
    rootCauseHypotheses = `
**Likely root causes for token list endpoints:**
1. **N+1 query** — fetching price/holder data per token in a loop instead of batching
2. **No caching** — recalculating aggregates (market cap, volume) on every request
3. **Missing DB index** — slow full-table scan on tokens table
4. **Unoptimized joins** — joining orders + tokens + holders without proper indexes`;
  } else if (epLower.includes('profile') || epLower.includes('user')) {
    rootCauseHypotheses = `
**Likely root causes for profile endpoints:**
1. **On-chain RPC call** — fetching live balance from Helius/Solana RPC on every request
2. **No caching of computed stats** — recalculating PnL/holdings on every page load
3. **Large transaction history scan** — scanning all orders without pagination`;
  } else {
    rootCauseHypotheses = `
**Likely root causes:**
1. **No response caching** — identical requests recomputed on each call
2. **Synchronous external calls** — waiting on RPC/price feed sequentially
3. **Missing indexes** — unindexed query fields causing full table scans
4. **Unoptimized aggregation** — heavy GROUP BY or COUNT queries without materialization`;
  }

  return `## ⚡ Performance Issue — Comprehensive Report

> Auto-detected by **QA Shield Guardian** 🛡️ | ${now}

---

### Summary
**Creator.fun is ${decision.deltaPct > 0 ? `${decision.deltaPct}% SLOWER` : 'on par'} than ${fastest?.name || 'competitors'}** on \`${benchmark.name}\`.

| Platform | Avg Response | Speed Bar |
|----------|-------------|-----------|
${tableRows}
${percentilesSection}
### Severity: ${decision.severity.toUpperCase()}
${impactMap[decision.severity] || impactMap.medium}

---

### Finding Detail
${decision.reason}

**Our endpoint:** \`${benchmark.ourEndpoint || benchmark.name}\`
**Measured avg:** ${benchmark.ourAvg}ms
**Fastest competitor:** ${fastest?.name || 'N/A'} at ${fastest?.avg ?? 'N/A'}ms
**Slowest competitor:** ${slowest?.name || 'N/A'} at ${slowest?.avg ?? 'N/A'}ms
${rootCauseHypotheses}

---

### Investigation Steps
\`\`\`bash
# 1. Measure current latency
time curl -s "${benchmark.ourEndpoint || `https://dev.bep.creator.fun${benchmark.name}`}" -o /dev/null

# 2. Check DB query time (add EXPLAIN ANALYZE in Prisma)
# Find the route handler → add console.time() around Prisma calls

# 3. Verify caching headers
curl -si "${benchmark.ourEndpoint || `https://dev.bep.creator.fun${benchmark.name}`}" | grep -i "cache\\|etag\\|age"

# 4. Compare vs competitors
curl -s -o /dev/null -w "%{time_total}s" "${fastest?.endpoint || 'https://axiom.trade/api/tokens'}"
\`\`\`

### Recommended Fix
1. **Add Redis/in-memory cache** for this endpoint (TTL: 5-30s depending on data freshness needs)
2. **Batch database queries** — eliminate N+1 patterns
3. **Add DB indexes** on frequently filtered/sorted columns
4. **Profile with \`EXPLAIN ANALYZE\`** — identify slow queries
5. **Consider CDN caching** for public/semi-static responses

---
*Auto-filed by QA Shield Guardian 🛡️*`;
}

// ── Build AI fix prompt for any ticket type ──
function buildAIFixPrompt(
  type: 'performance' | 'security',
  title: string,
  description: string,
  endpoint?: string
): string {
  if (type === 'performance') {
    return `## 🤖 AI Fix Prompt — Copy into Cursor / Claude Code

\`\`\`
You are a senior Node.js/TypeScript backend engineer working on Creator.fun — a Solana meme coin trading platform.

PERFORMANCE ISSUE: ${title}

${endpoint ? `SLOW ENDPOINT: ${endpoint}` : ''}

TASK:
1. Find the route handler for this endpoint in the backend-persistent Express/Prisma codebase
2. Identify the root cause: N+1 queries, missing DB indexes, no caching, sync RPC calls
3. Add Redis caching using the existing cache utility (TTL appropriate to data freshness)
4. If N+1: rewrite to use Prisma's include/select batching or a single aggregated query
5. Add EXPLAIN ANALYZE comments for any slow Prisma queries
6. Ensure the fix does not break existing response shape (same fields, same types)
7. Add a brief comment explaining what was optimized and why

Target: reduce response time to under 200ms average (currently: ${description.match(/Our Avg Response: (\d+)ms/)?.[1] || '500+'}ms)

Files to check first:
- src/modules/ — route handlers
- src/lib/cache.ts or similar — existing cache utility
- prisma/schema.prisma — check indexes on relevant models

Do NOT: change authentication, modify response shape, add new dependencies without checking package.json first.
\`\`\`

---
*Paste this prompt directly into Cursor AI, Claude Code, or GitHub Copilot Chat to get a targeted fix.*`;
  }

  return `## 🤖 AI Fix Prompt — Copy into Cursor / Claude Code

\`\`\`
You are a senior security engineer reviewing Creator.fun — a Solana meme coin trading platform built with Express.js/TypeScript.

SECURITY ISSUE: ${title}

${endpoint ? `VULNERABLE ENDPOINT: ${endpoint}` : ''}

TASK:
1. Find this endpoint/middleware in the backend-persistent codebase
2. Implement the exact security fix described below
3. Do NOT break existing functionality or change the response shape
4. Add a test case or curl command showing the fix works

ISSUE DETAILS:
${description.split('\n').slice(0, 8).join('\n')}

Files to check first:
- src/middleware/ — auth, CORS, rate limiting middleware
- src/modules/ — route handlers
- src/app.ts or index.ts — global middleware setup

Do NOT: remove authentication from any other endpoints, introduce new security vulnerabilities, or change the database schema.
\`\`\`

---
*Paste this prompt directly into Cursor AI, Claude Code, or GitHub Copilot Chat to get a targeted fix.*`;
}

function getSecurityContext(type: string): string {
  const ctx: Record<string, string> = {
    cors: 'CORS misconfigurations allow malicious websites to make authenticated requests on behalf of users, potentially stealing funds or data.',
    auth: 'Unauthenticated endpoints expose user data to anyone on the internet without requiring a wallet signature.',
    headers: 'Missing security headers (CSP, HSTS, X-Frame-Options) expose users to XSS, clickjacking, and protocol downgrade attacks.',
    'data-exposure': 'Sensitive data in API responses (API keys, private keys, email addresses) can be harvested by attackers.',
    'rate-limit': 'Without rate limiting, endpoints are vulnerable to brute force, scraping, and DoS attacks.',
    'input-validation': 'Missing input validation allows injection attacks and unexpected application behavior.',
  };
  return ctx[type] || 'Security vulnerability that could expose users or the platform to attacks.';
}

function getSecurityFix(type: string): string {
  const fixes: Record<string, string> = {
    cors: 'Restrict `Access-Control-Allow-Origin` to `https://creator.fun` and `https://dev.creator.fun` only. Never reflect the Origin header back.',
    auth: 'Add wallet signature verification middleware to this endpoint. All user-specific data must require authentication.',
    headers: 'Add security headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy`.',
    'data-exposure': 'Audit the response payload. Remove any fields that contain sensitive data. Never expose API keys or private keys in responses.',
    'rate-limit': 'Add rate limiting middleware (e.g. `express-rate-limit`): 100 req/min per IP for public endpoints, 300 req/min for authenticated.',
    'input-validation': 'Add input validation using `zod` or similar. Sanitize all query parameters and request bodies before processing.',
  };
  return fixes[type] || 'Review the endpoint implementation and apply appropriate security controls.';
}

function buildSummary(
  secFindings: SecurityFinding[],
  perfFindings: PerformanceFinding[],
  filed: { identifier: string; severity: string }[],
  skipped: number
): string {
  const total = secFindings.length + perfFindings.length;
  const criticalCount = [...secFindings, ...perfFindings].filter(f => f.severity === 'critical').length;
  const highCount = [...secFindings, ...perfFindings].filter(f => f.severity === 'high').length;

  if (total === 0) return 'All clear — no security or performance issues found ✅';

  let s = `${total} issue(s) found`;
  if (criticalCount > 0) s += ` (${criticalCount} critical)`;
  if (highCount > 0) s += ` (${highCount} high)`;
  if (filed.length > 0) s += ` — ${filed.length} new ticket(s) filed`;
  if (skipped > 0) s += ` — ${skipped} duplicate(s) skipped`;
  return s;
}

// ============ Commit-triggered ticket filing ============
// Called by commit-runner after spotting security/perf issues in a specific commit.
// Uses same deduplication + AI fix prompt as guardian scans.

export interface CommitFinding {
  type: 'security' | 'performance';
  endpoint: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  // perf-specific
  ourAvgMs?: number;
  competitorAvgMs?: number;
  competitorName?: string;
  deltaPct?: number;
}

export async function fileCommitFindings(
  findings: CommitFinding[],
  commitSha: string,
  ticketId?: string,
): Promise<{ filed: string[]; skipped: number }> {
  if (findings.length === 0) return { filed: [], skipped: 0 };

  const state = loadState();
  const filed: string[] = [];
  let skipped = 0;
  const shortSha = commitSha.slice(0, 7);

  for (const f of findings) {
    const fingerprint = makeFingerprint(f.type, f.endpoint, f.title);

    // Skip already filed
    const alreadyFiled = state.filedIssues.find(fi => fi.fingerprint === fingerprint && !fi.resolvedAt);
    if (alreadyFiled) { skipped++; continue; }

    // Check Linear for similar open ticket
    try {
      const similar = await findSimilarIssue(f.title);
      if (similar && !['canceled', 'done'].includes(similar.state.name.toLowerCase())) {
        state.filedIssues.push({ fingerprint, linearId: similar.identifier, title: similar.title, filedAt: new Date().toISOString(), severity: f.severity });
        skipped++;
        continue;
      }
    } catch { /* don't block */ }

    // Build rich description
    const contextLine = ticketId ? `\n> **Detected during commit [\`${shortSha}\`](https://github.com/creatorfun) on \`pre-staging\` — linked to ${ticketId}**\n` : `\n> **Detected during commit \`${shortSha}\` on \`pre-staging\`**\n`;

    let description = f.description + contextLine;

    if (f.type === 'performance' && f.ourAvgMs) {
      description += `\n**Metrics:**\n- Our avg: ${f.ourAvgMs}ms\n- ${f.competitorName || 'Competitor'}: ${f.competitorAvgMs}ms\n- Delta: +${f.deltaPct}% slower\n\n**Industry Standard:** Under 200ms avg for API endpoints (Google/RAIL model). Under 100ms for critical trading endpoints.`;
    }

    try {
      const priority = f.severity === 'critical' ? 1 : f.severity === 'high' ? 2 : 3;
      const labelIds = f.type === 'security' ? [LABELS.SECURITY, LABELS.BUG] : [LABELS.BACKEND];

      const issue = await createIssue({ title: f.title, description, priority, labelIds, stateId: WORKFLOW_STATES.TODO });

      // Post AI fix prompt immediately
      try {
        const aiPrompt = buildAIFixPrompt(f.type, f.title, description, f.endpoint);
        await addComment(issue.id, aiPrompt);
      } catch { /* non-blocking */ }

      state.filedIssues.push({ fingerprint, linearId: issue.identifier, title: issue.title, filedAt: new Date().toISOString(), severity: f.severity });
      state.stats.totalIssuesFiled++;
      if (f.severity === 'critical') state.stats.totalCriticalFound++;
      filed.push(issue.identifier);
      console.log(`[Guardian] Commit finding filed: ${issue.identifier} — ${f.title}`);
    } catch (err: any) {
      console.error(`[Guardian] Failed to file commit finding:`, err.message);
    }
  }

  saveState(state);
  return { filed, skipped };
}

// ============ State Reader (for status endpoint) ============

export function getGuardianState(): GuardianState {
  return loadState();
}

export function formatGuardianStatusForSlack(result: GuardianScanResult): string {
  const icon = result.overallHealth === 'critical' ? '🔴' :
    result.overallHealth === 'warning' ? '🟡' : '✅';

  let msg = `${icon} *QA Shield Guardian — Scan Complete*\n`;
  msg += `${result.summary}\n`;
  msg += `_Scan took ${Math.round(result.durationMs / 1000)}s | ${new Date(result.completedAt).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} PKT_\n`;

  if (result.newIssuesFiled.length > 0) {
    msg += `\n*New tickets filed:*\n`;
    for (const issue of result.newIssuesFiled) {
      const sevIcon = issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟠' : '🟡';
      msg += `${sevIcon} *${issue.identifier}* — ${issue.title}\n`;
    }
  }

  return msg;
}
