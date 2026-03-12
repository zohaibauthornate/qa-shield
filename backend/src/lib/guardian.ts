/**
 * QA Shield Guardian — Always-On Background Scanner
 * Runs security + performance scans, deduplicates, auto-files Linear tickets
 * State tracked in: /tmp/qa-shield-state.json (persisted across runs)
 */

import { scanEndpoint, apiLevelBenchmark, shouldFilePerformanceTicket, type SecurityScanResult } from './scanner';
import { createIssue, findSimilarIssue, LABELS, WORKFLOW_STATES } from './linear';
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
  benchmark: { name: string; ourAvg: number; ourEndpoint?: string; competitorResults: { name: string; avg: number; endpoint: string }[] },
  decision: { reason: string; deltaPct: number; severity: string }
): string {
  const fastest = benchmark.competitorResults.filter(c => c.avg >= 0).sort((a, b) => a.avg - b.avg)[0];
  return `## ⚡ Performance Issue — Auto-detected by QA Shield Guardian

**Endpoint:** \`${benchmark.name}\`
**Our Avg Response:** ${benchmark.ourAvg}ms
**Competitor (${fastest?.name || 'N/A'}):** ${fastest?.avg ?? 'N/A'}ms
**Delta:** ${decision.deltaPct > 0 ? '+' : ''}${decision.deltaPct}% slower

### Finding
${decision.reason}

### Impact
Users on slow connections will experience noticeable lag. In the meme coin trading space, every millisecond of latency costs trades.

### Suggested Fix
- Add server-side caching (Redis/in-memory) for this endpoint
- Review database query optimization
- Consider CDN caching for static/semi-static responses
- Profile the endpoint handler for N+1 queries

---
*Auto-filed by QA Shield Guardian 🛡️ at ${new Date().toISOString()}*`;
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
