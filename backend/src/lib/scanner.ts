/**
 * Security Scanner & Performance Benchmarker for QA Shield
 * Sprint 1: fixed ghost endpoints, Token Detail path, auth FP, dedup, added rate-limit check
 * Sprint 2: added input validation, payload tracking, regression tracker, WS benchmark, report engine
 */

// ============ Types ============

export interface SecurityScanResult {
  endpoint: string;
  checks: SecurityCheckResult[];
  overallStatus: 'pass' | 'warn' | 'fail';
  timestamp: string;
}

export interface SecurityCheckResult {
  type: 'cors' | 'auth' | 'data-exposure' | 'rate-limit' | 'headers' | 'input-validation';
  status: 'pass' | 'warn' | 'fail';
  details: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface PerformanceResult {
  url: string;
  responseTime: number;
  statusCode: number;
  contentSize: number;
  ttfb: number;
  timestamp: string;
}

export interface BenchmarkResult {
  metric: string;
  ours: PerformanceResult;
  competitors: { name: string; result: PerformanceResult }[];
  verdict: 'faster' | 'slower' | 'similar';
  delta: string;
}

// ============ Security Scanner ============

export async function scanEndpoint(endpoint: string): Promise<SecurityScanResult> {
  const checks: SecurityCheckResult[] = [];

  // 1. CORS Check
  checks.push(await checkCORS(endpoint));

  // 2. Auth Check (try without token)
  checks.push(await checkAuth(endpoint));

  // 3. Security Headers Check
  checks.push(await checkSecurityHeaders(endpoint));

  // 4. Data Exposure Check
  checks.push(await checkDataExposure(endpoint));

  // 5. Rate Limit Check — Sprint 1
  checks.push(await checkRateLimit(endpoint));

  // 6. Input Validation Check — Sprint 2
  checks.push(await checkInputValidation(endpoint));

  const overallStatus = checks.some(c => c.status === 'fail')
    ? 'fail'
    : checks.some(c => c.status === 'warn')
    ? 'warn'
    : 'pass';

  return {
    endpoint,
    checks,
    overallStatus,
    timestamp: new Date().toISOString(),
  };
}

async function checkCORS(endpoint: string): Promise<SecurityCheckResult> {
  try {
    const res = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://evil-site.com' },
    });

    const allowOrigin = res.headers.get('access-control-allow-origin');
    const allowCreds = res.headers.get('access-control-allow-credentials');

    if (allowOrigin === '*' || allowOrigin === 'https://evil-site.com') {
      return {
        type: 'cors',
        status: allowCreds === 'true' ? 'fail' : 'warn',
        details: `CORS reflects arbitrary origin: ${allowOrigin}${allowCreds === 'true' ? ' WITH credentials' : ''}`,
        severity: allowCreds === 'true' ? 'critical' : 'high',
      };
    }

    return {
      type: 'cors',
      status: 'pass',
      details: `CORS properly configured. Allow-Origin: ${allowOrigin || 'not set'}`,
      severity: 'low',
    };
  } catch (err) {
    return {
      type: 'cors',
      status: 'warn',
      details: `Could not check CORS: ${err}`,
      severity: 'medium',
    };
  }
}

// Sprint 1 Fix: Tightened auth keyword scan — no more false positives from "creatorWallet"
// Now checks for explicit user-private field names only
const PRIVATE_FIELD_PATTERNS = [
  /"userId"\s*:/i,
  /"email"\s*:/i,
  /"privateKey"\s*:/i,
  /"walletAddress"\s*:/i,
  /"seedPhrase"\s*:/i,
  /"mnemonic"\s*:/i,
  /"accessToken"\s*:/i,
  /"authToken"\s*:/i,
  /"sessionToken"\s*:/i,
];

async function checkAuth(endpoint: string): Promise<SecurityCheckResult> {
  try {
    const res = await fetch(endpoint, { method: 'GET' });

    if (res.status === 401 || res.status === 403) {
      return {
        type: 'auth',
        status: 'pass',
        details: `Endpoint properly requires authentication (${res.status})`,
        severity: 'low',
      };
    }

    if (res.status === 404 || res.status === 405) {
      return {
        type: 'auth',
        status: 'pass',
        details: `Endpoint not found or method not allowed (${res.status}) — not publicly accessible`,
        severity: 'low',
      };
    }

    if (res.ok) {
      const body = await res.text();
      // Sprint 1 Fix: use tight regex patterns instead of naive substring search
      const matchedPatterns = PRIVATE_FIELD_PATTERNS.filter(p => p.test(body));

      if (matchedPatterns.length > 0) {
        return {
          type: 'auth',
          status: 'fail',
          details: `Endpoint returns user-private data WITHOUT authentication (matched: ${matchedPatterns.map(p => p.source.replace(/\\s\*:/i, '')).join(', ')})`,
          severity: 'critical',
        };
      }

      return {
        type: 'auth',
        status: 'warn',
        details: `Endpoint accessible without auth (${res.status}) — no private fields detected, but verify manually`,
        severity: 'medium',
      };
    }

    return {
      type: 'auth',
      status: 'pass',
      details: `Endpoint returned ${res.status}`,
      severity: 'low',
    };
  } catch (err) {
    return {
      type: 'auth',
      status: 'warn',
      details: `Could not check auth: ${err}`,
      severity: 'medium',
    };
  }
}

async function checkSecurityHeaders(endpoint: string): Promise<SecurityCheckResult> {
  try {
    const res = await fetch(endpoint, { method: 'HEAD' });
    const issues: string[] = [];
    const info: string[] = [];

    // Required headers
    if (!res.headers.get('strict-transport-security')) issues.push('Missing HSTS');
    if (!res.headers.get('x-content-type-options')) issues.push('Missing X-Content-Type-Options');
    if (!res.headers.get('x-frame-options')) issues.push('Missing X-Frame-Options');
    if (!res.headers.get('content-security-policy')) issues.push('Missing Content-Security-Policy');
    if (!res.headers.get('referrer-policy')) issues.push('Missing Referrer-Policy');

    // Disclosure headers that should NOT be present
    const poweredBy = res.headers.get('x-powered-by');
    if (poweredBy) issues.push(`x-powered-by exposes tech: "${poweredBy}"`);

    const server = res.headers.get('server');
    if (server && server.toLowerCase() !== 'vercel') {
      info.push(`server header: "${server}"`);
    }

    return {
      type: 'headers',
      status: issues.length > 3 ? 'fail' : issues.length > 0 ? 'warn' : 'pass',
      details: issues.length > 0
        ? `Issues: ${issues.join(' | ')}`
        : `All security headers present`,
      severity: issues.length > 3 ? 'high' : issues.length > 0 ? 'medium' : 'low',
    };
  } catch (err) {
    return {
      type: 'headers',
      status: 'warn',
      details: `Could not check headers: ${err}`,
      severity: 'medium',
    };
  }
}

async function checkDataExposure(endpoint: string): Promise<SecurityCheckResult> {
  try {
    const res = await fetch(endpoint);
    if (!res.ok) {
      return { type: 'data-exposure', status: 'pass', details: 'Endpoint not publicly accessible', severity: 'low' };
    }

    const body = await res.text();
    const sensitivePatterns = [
      { pattern: /"password"\s*:/i, label: 'password field' },
      { pattern: /"secret"\s*:/i, label: 'secret field' },
      { pattern: /"private_?key"\s*:/i, label: 'private key' },
      { pattern: /"api_?key"\s*:/i, label: 'API key' },
      { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i, label: 'JWT token' },
      // Web3-specific: Solana private key is 88-char base58, seed phrase is 12/24 BIP-39 words
      { pattern: /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/, label: 'possible Solana private key (base58)' },
      { pattern: /\b(abandon|ability|able|about|above|absent|absorb|abstract|absurd|abuse|access|accident)\b.*\b(zoo|zone|zombie)\b/i, label: 'possible seed phrase' },
    ];

    const found = sensitivePatterns.filter(p => p.pattern.test(body));

    if (found.length > 0) {
      return {
        type: 'data-exposure',
        status: 'fail',
        details: `Potentially sensitive data exposed: ${found.map(f => f.label).join(', ')}`,
        severity: 'critical',
      };
    }

    return {
      type: 'data-exposure',
      status: 'pass',
      details: 'No sensitive data patterns detected',
      severity: 'low',
    };
  } catch (err) {
    return {
      type: 'data-exposure',
      status: 'warn',
      details: `Could not check data exposure: ${err}`,
      severity: 'medium',
    };
  }
}

// Sprint 1 Fix: Implement checkRateLimit — was declared in types but never built
async function checkRateLimit(endpoint: string): Promise<SecurityCheckResult> {
  try {
    const BURST = 10;
    const results: number[] = [];

    // Fire 10 rapid sequential requests
    for (let i = 0; i < BURST; i++) {
      const res = await fetch(endpoint, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      results.push(res.status);
    }

    const has429 = results.includes(429);
    const has503 = results.includes(503);
    const allOk = results.every(s => s === 200 || s === 304);

    if (has429 || has503) {
      return {
        type: 'rate-limit',
        status: 'pass',
        details: `Rate limiting active — got ${results.filter(s => s === 429 || s === 503).length}/${BURST} throttle responses`,
        severity: 'low',
      };
    }

    if (allOk) {
      return {
        type: 'rate-limit',
        status: 'fail',
        details: `No rate limiting detected — all ${BURST} rapid requests returned 200. Endpoint is susceptible to scraping and abuse.`,
        severity: 'high',
      };
    }

    return {
      type: 'rate-limit',
      status: 'warn',
      details: `Mixed responses: ${results.join(', ')} — rate limiting may be partial`,
      severity: 'medium',
    };
  } catch (err) {
    return {
      type: 'rate-limit',
      status: 'warn',
      details: `Could not check rate limit: ${err}`,
      severity: 'medium',
    };
  }
}

// ============ Performance Benchmarker ============

export async function benchmarkEndpoint(url: string): Promise<PerformanceResult> {
  const start = performance.now();

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });

    const ttfbTime = performance.now() - start;
    const body = await res.text();
    const totalTime = performance.now() - start;

    return {
      url,
      responseTime: Math.round(totalTime),
      statusCode: res.status,
      contentSize: body.length,
      ttfb: Math.round(ttfbTime),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      url,
      responseTime: -1,
      statusCode: 0,
      contentSize: 0,
      ttfb: -1,
      timestamp: new Date().toISOString(),
    };
  }
}

// ============ API-Level Benchmark (per-endpoint comparison) ============

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

interface EndpointMapping {
  name: string;
  ourPath: string;
  competitors: { name: string; endpoint: string }[];
}

// Sprint 1 Fix: Token Detail path corrected from /api/token/:address → /api/token?address=:address
// Sprint 1 Fix: Added axiom.trade competitor for Token List
const API_ENDPOINT_MAPPINGS: EndpointMapping[] = [
  {
    name: 'Token List',
    ourPath: '/api/token/list?limit=20',
    competitors: [
      { name: 'pump.fun', endpoint: 'https://frontend-api.pump.fun/coins?limit=20&sort=last_trade_unix_timestamp&includeNsfw=false' },
      { name: 'axiom.trade', endpoint: 'https://api2.axiom.trade/solana/v2/tokens?limit=20&sortBy=volume24h' },
    ],
  },
  {
    name: 'Token Search',
    ourPath: '/api/token/search?q=test',
    competitors: [
      { name: 'pump.fun', endpoint: 'https://frontend-api.pump.fun/coins?searchTerm=test&limit=10' },
    ],
  },
  {
    name: 'Leaderboard Stats',
    ourPath: '/api/leaderboard/stats',
    competitors: [],
  },
  {
    // Sprint 1 Fix: was '/api/token/Ffyi2x1...' (wrong — path segment doesn't exist)
    // Now using correct query-param format: /api/token?address=Ffyi2x1...
    name: 'Token Detail',
    ourPath: '/api/token?address=Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD',
    competitors: [
      { name: 'pump.fun', endpoint: 'https://frontend-api.pump.fun/coins/Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD' },
    ],
  },
];

async function sampleEndpoint(url: string): Promise<number> {
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    await res.text();
    return Math.round(performance.now() - start);
  } catch {
    return -1;
  }
}

function calcAvg(samples: number[]): number {
  const valid = samples.filter(s => s >= 0);
  if (valid.length === 0) return -1;
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

function calcP95(samples: number[]): number {
  const valid = samples.filter(s => s >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return -1;
  const idx = Math.ceil(valid.length * 0.95) - 1;
  return valid[Math.min(idx, valid.length - 1)];
}

export async function apiLevelBenchmark(samples = 3): Promise<ApiEndpointBenchmark[]> {
  const apiBase = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
  const results: ApiEndpointBenchmark[] = [];

  for (const mapping of API_ENDPOINT_MAPPINGS) {
    const ourUrl = `${apiBase}${mapping.ourPath}`;

    // Sample our endpoint
    const ourSamples: number[] = [];
    for (let i = 0; i < samples; i++) {
      ourSamples.push(await sampleEndpoint(ourUrl));
      if (i < samples - 1) await new Promise(r => setTimeout(r, 300));
    }

    // Sample competitor endpoints
    const competitorResults: ApiEndpointBenchmark['competitorResults'] = [];
    for (const comp of mapping.competitors) {
      const compSamples: number[] = [];
      for (let i = 0; i < samples; i++) {
        compSamples.push(await sampleEndpoint(comp.endpoint));
        if (i < samples - 1) await new Promise(r => setTimeout(r, 300));
      }
      competitorResults.push({
        name: comp.name,
        endpoint: comp.endpoint,
        avg: calcAvg(compSamples),
        p95: calcP95(compSamples),
        samples: compSamples,
      });
    }

    const ourAvg = calcAvg(ourSamples);
    const ourP95 = calcP95(ourSamples);

    // Compare vs fastest competitor
    const fastestComp = competitorResults
      .filter(c => c.avg >= 0)
      .sort((a, b) => a.avg - b.avg)[0];

    let verdict: ApiEndpointBenchmark['verdict'] = 'no_competitor_data';
    let deltaMs = 0;
    let deltaPct = 'N/A';

    if (fastestComp && ourAvg >= 0) {
      deltaMs = ourAvg - fastestComp.avg;
      const pct = fastestComp.avg > 0 ? ((deltaMs / fastestComp.avg) * 100) : 0;
      deltaPct = `${deltaMs >= 0 ? '+' : ''}${pct.toFixed(1)}%`;

      if (deltaMs > 200) verdict = 'slower';
      else if (deltaMs < -200) verdict = 'faster';
      else verdict = 'similar';
    }

    results.push({
      name: mapping.name,
      ourEndpoint: mapping.ourPath,
      ourAvg,
      ourP95,
      ourSamples,
      competitorResults,
      verdict,
      deltaMs,
      deltaPct,
    });
  }

  return results;
}

// ============ Legacy Comparative Benchmark (frontend-level) ============

export async function comparativeBehnchmark(
  ourUrl: string,
  competitors: { name: string; url: string }[]
): Promise<BenchmarkResult> {
  const ours = await benchmarkEndpoint(ourUrl);
  const competitorResults = await Promise.all(
    competitors.map(async c => ({
      name: c.name,
      result: await benchmarkEndpoint(c.url),
    }))
  );

  const fastestCompetitor = competitorResults
    .filter(c => c.result.responseTime > 0)
    .sort((a, b) => a.result.responseTime - b.result.responseTime)[0];

  let verdict: 'faster' | 'slower' | 'similar' = 'similar';
  let delta = 'N/A';

  if (fastestCompetitor && ours.responseTime > 0) {
    const diff = ours.responseTime - fastestCompetitor.result.responseTime;
    const pct = Math.abs(diff / fastestCompetitor.result.responseTime * 100).toFixed(1);

    if (diff > 200) {
      verdict = 'slower';
      delta = `${Math.round(diff)}ms slower (${pct}%)`;
    } else if (diff < -200) {
      verdict = 'faster';
      delta = `${Math.round(Math.abs(diff))}ms faster (${pct}%)`;
    } else {
      verdict = 'similar';
      delta = `Within 200ms (${Math.round(diff)}ms diff)`;
    }
  }

  return {
    metric: 'API Response Time',
    ours,
    competitors: competitorResults,
    verdict,
    delta,
  };
}

// ============ Sprint 2: Input Validation Check ============

async function checkInputValidation(endpoint: string): Promise<SecurityCheckResult> {
  // Only test endpoints that accept search/query parameters
  const url = new URL(endpoint);
  const isSearchable = url.pathname.includes('search') || url.pathname.includes('list') || url.search;

  if (!isSearchable) {
    return {
      type: 'input-validation',
      status: 'pass',
      details: 'Endpoint does not accept user-supplied query parameters — skipped',
      severity: 'low',
    };
  }

  const baseUrl = endpoint.split('?')[0];
  const issues: string[] = [];

  const tests: { name: string; param: string; value: string; redFlags: RegExp[] }[] = [
    {
      name: 'XSS reflection',
      param: 'q',
      value: '<script>alert(1)</script>',
      redFlags: [/<script>/i, /alert\(1\)/i],
    },
    {
      name: 'SQLi error',
      param: 'q',
      value: "1' OR '1'='1",
      redFlags: [/sql\s+error/i, /syntax.*near/i, /unclosed.*quotation/i, /pg.*error/i, /mysql.*error/i],
    },
    {
      name: 'Path traversal',
      param: 'q',
      value: '../../etc/passwd',
      redFlags: [/root:x:/i, /\[boot\s+loader\]/i, /daemon:x:/i],
    },
    {
      name: 'Oversized input (DoS)',
      param: 'q',
      value: 'A'.repeat(5000),
      redFlags: [], // Just check if it crashes (5xx)
    },
  ];

  try {
    for (const test of tests) {
      const testUrl = `${baseUrl}?${test.param}=${encodeURIComponent(test.value)}`;
      const res = await fetch(testUrl, { signal: AbortSignal.timeout(5000) });
      const body = await res.text();

      // Check for reflected content
      const reflected = test.redFlags.some(pattern => pattern.test(body));
      if (reflected) {
        issues.push(`${test.name}: reflected in response — possible injection vector`);
        continue;
      }

      // Check for server error on oversized input
      if (test.name === 'Oversized input (DoS)' && res.status >= 500) {
        issues.push(`${test.name}: server returned ${res.status} — possible DoS vector`);
        continue;
      }

      // Check for unexpected 5xx on any test
      if (res.status >= 500) {
        issues.push(`${test.name}: server error ${res.status} — possible unstable handling`);
      }
    }

    if (issues.length > 0) {
      return {
        type: 'input-validation',
        status: 'fail',
        details: `Input validation issues: ${issues.join(' | ')}`,
        severity: 'high',
      };
    }

    return {
      type: 'input-validation',
      status: 'pass',
      details: `All ${tests.length} input validation checks passed (XSS, SQLi, path traversal, DoS)`,
      severity: 'low',
    };
  } catch (err) {
    return {
      type: 'input-validation',
      status: 'warn',
      details: `Could not run input validation: ${err}`,
      severity: 'medium',
    };
  }
}

// ============ Sprint 2: Payload Size Tracking ============

export interface PayloadResult {
  endpoint: string;
  sizeBytes: number;
  sizeKb: string;
  isGzipped: boolean;
  contentType: string;
}

export async function measurePayload(url: string): Promise<PayloadResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    const sizeBytes = new TextEncoder().encode(body).length;
    const isGzipped = (res.headers.get('content-encoding') || '').includes('gzip');
    const contentType = res.headers.get('content-type') || 'unknown';

    return {
      endpoint: url.replace(/^https?:\/\/[^/]+/, ''),
      sizeBytes,
      sizeKb: (sizeBytes / 1024).toFixed(1) + 'KB',
      isGzipped,
      contentType,
    };
  } catch {
    return {
      endpoint: url.replace(/^https?:\/\/[^/]+/, ''),
      sizeBytes: -1,
      sizeKb: 'N/A',
      isGzipped: false,
      contentType: 'error',
    };
  }
}

// ============ Sprint 2: Regression Tracker ============

import * as fs from 'fs';
import * as path from 'path';

const BASELINE_PATH = path.join(process.cwd(), 'src', 'data', 'benchmark-baseline.json');

export interface RegressionResult {
  endpoint: string;
  previousAvg: number;
  currentAvg: number;
  deltaMs: number;
  deltaPct: number;
  verdict: 'improved' | 'regressed' | 'new' | 'stable';
}

export function loadBaseline(): Record<string, number> {
  try {
    if (fs.existsSync(BASELINE_PATH)) {
      return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function saveBaseline(benchmarks: ApiEndpointBenchmark[]): void {
  try {
    const dir = path.dirname(BASELINE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const existing = loadBaseline();
    for (const b of benchmarks) {
      if (b.ourAvg >= 0) existing[b.name] = b.ourAvg;
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(existing, null, 2));
  } catch (err) {
    console.warn('Could not save benchmark baseline:', err);
  }
}

export function compareToBaseline(benchmarks: ApiEndpointBenchmark[]): RegressionResult[] {
  const baseline = loadBaseline();
  return benchmarks.map(b => {
    const prev = baseline[b.name];
    if (prev === undefined || b.ourAvg < 0) {
      return {
        endpoint: b.name,
        previousAvg: -1,
        currentAvg: b.ourAvg,
        deltaMs: 0,
        deltaPct: 0,
        verdict: 'new' as const,
      };
    }

    const deltaMs = b.ourAvg - prev;
    const deltaPct = prev > 0 ? Math.round((deltaMs / prev) * 100) : 0;
    let verdict: RegressionResult['verdict'] = 'stable';
    if (deltaMs > 0 && deltaPct > 20) verdict = 'regressed';
    else if (deltaMs < 0 && deltaPct < -20) verdict = 'improved';

    return { endpoint: b.name, previousAvg: prev, currentAvg: b.ourAvg, deltaMs, deltaPct, verdict };
  });
}

// ============ Sprint 2: WebSocket Benchmark ============

export interface WebSocketBenchmarkResult {
  url: string;
  connectMs: number;
  firstMessageMs: number;
  status: 'connected' | 'timeout' | 'error' | 'not_configured';
  error?: string;
}

export async function benchmarkWebSocket(wsUrl?: string): Promise<WebSocketBenchmarkResult> {
  const url = wsUrl || process.env.STAGING_WS_URL;

  if (!url) {
    return {
      url: 'not configured',
      connectMs: -1,
      firstMessageMs: -1,
      status: 'not_configured',
      error: 'Set STAGING_WS_URL in .env.local to enable WebSocket benchmarking',
    };
  }

  return new Promise((resolve) => {
    const startTime = Date.now();
    let connectTime = -1;

    try {
      // Dynamic import to avoid issues in non-Node environments
      const WebSocket = require('ws');
      const ws = new WebSocket(url, { handshakeTimeout: 5000 });

      const timeout = setTimeout(() => {
        ws.terminate();
        resolve({
          url,
          connectMs: connectTime >= 0 ? connectTime : -1,
          firstMessageMs: -1,
          status: 'timeout',
          error: 'Timeout waiting for first message (5s)',
        });
      }, 5000);

      ws.on('open', () => {
        connectTime = Date.now() - startTime;
      });

      ws.on('message', () => {
        clearTimeout(timeout);
        ws.close();
        resolve({
          url,
          connectMs: connectTime,
          firstMessageMs: Date.now() - startTime,
          status: 'connected',
        });
      });

      ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        resolve({
          url,
          connectMs: connectTime,
          firstMessageMs: -1,
          status: 'error',
          error: err.message,
        });
      });
    } catch (err) {
      resolve({
        url,
        connectMs: -1,
        firstMessageMs: -1,
        status: 'error',
        error: String(err),
      });
    }
  });
}

// ============ Sprint 2: Report Engine ============

import * as os from 'os';

export interface QAShieldReport {
  runId: string;
  timestamp: string;
  target: string;
  securitySummary: { passed: number; warnings: number; failed: number; total: number };
  benchmarkSummary: { slower: number; total: number };
  regressions: RegressionResult[];
  wsResult: WebSocketBenchmarkResult | null;
  payloads: PayloadResult[];
  newTickets: string[];
  existingTickets: string[];
  durationMs: number;
}

export function generateMarkdownReport(report: QAShieldReport): string {
  const d = new Date(report.timestamp);
  const dateStr = d.toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  const lines: string[] = [];

  lines.push(`# QA Shield Run Report`);
  lines.push(`**Run ID:** ${report.runId}`);
  lines.push(`**Date:** ${dateStr}`);
  lines.push(`**Target:** ${report.target}`);
  lines.push(`**Duration:** ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  // Executive Summary
  lines.push('## Executive Summary');
  lines.push('');
  lines.push('| Category | Pass | Warn | Fail | Total |');
  lines.push('|----------|------|------|------|-------|');
  const s = report.securitySummary;
  lines.push(`| Security | ${s.passed} | ${s.warnings} | ${s.failed} | ${s.total} |`);
  const b = report.benchmarkSummary;
  lines.push(`| Performance | ${b.total - b.slower} | 0 | ${b.slower} | ${b.total} |`);
  lines.push('');

  // Performance Benchmark
  if (report.payloads.length > 0) {
    lines.push('## Performance & Payload');
    lines.push('');
    lines.push('| Endpoint | Size | Gzipped | Content-Type |');
    lines.push('|----------|------|---------|--------------|');
    for (const p of report.payloads) {
      lines.push(`| ${p.endpoint} | ${p.sizeKb} | ${p.isGzipped ? '✅' : '❌'} | ${p.contentType.split(';')[0]} |`);
    }
    lines.push('');
  }

  // Regression Analysis
  if (report.regressions.length > 0) {
    lines.push('## Regression Analysis');
    lines.push('');
    lines.push('| Endpoint | Previous | Current | Delta | Status |');
    lines.push('|----------|----------|---------|-------|--------|');
    for (const r of report.regressions) {
      const prev = r.previousAvg >= 0 ? `${r.previousAvg}ms` : 'N/A';
      const curr = r.currentAvg >= 0 ? `${r.currentAvg}ms` : 'N/A';
      const delta = r.verdict === 'new' ? '—' : `${r.deltaMs >= 0 ? '+' : ''}${r.deltaMs}ms (${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct}%)`;
      const icon = r.verdict === 'regressed' ? '⚠️ Regressed' : r.verdict === 'improved' ? '🚀 Improved' : r.verdict === 'new' ? '🆕 New' : '✅ Stable';
      lines.push(`| ${r.endpoint} | ${prev} | ${curr} | ${delta} | ${icon} |`);
    }
    lines.push('');
  }

  // WebSocket
  if (report.wsResult) {
    lines.push('## WebSocket Benchmark');
    lines.push('');
    const ws = report.wsResult;
    if (ws.status === 'not_configured') {
      lines.push(`> ⚠️ WebSocket benchmark not configured. Set \`STAGING_WS_URL\` in \`.env.local\`.`);
    } else if (ws.status === 'connected') {
      lines.push(`- **URL:** \`${ws.url}\``);
      lines.push(`- **Connect time:** ${ws.connectMs}ms`);
      lines.push(`- **First message:** ${ws.firstMessageMs}ms`);
      lines.push(`- **Status:** ✅ Connected`);
    } else {
      lines.push(`- **URL:** \`${ws.url}\``);
      lines.push(`- **Status:** ❌ ${ws.status} — ${ws.error}`);
    }
    lines.push('');
  }

  // Linear Actions
  if (report.newTickets.length > 0 || report.existingTickets.length > 0) {
    lines.push('## Linear Actions');
    lines.push('');
    if (report.newTickets.length > 0) {
      lines.push(`**Created (${report.newTickets.length}):** ${report.newTickets.join(', ')}`);
    }
    if (report.existingTickets.length > 0) {
      lines.push(`**Skipped/Existing (${report.existingTickets.length}):** ${report.existingTickets.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`_Generated by QA Shield 🛡️_`);

  return lines.join('\n');
}

export function saveReport(report: QAShieldReport, content: string): string {
  try {
    const reportsDir = path.join(process.cwd(), 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const filename = `qa-shield-${report.runId}.md`;
    const filepath = path.join(reportsDir, filename);
    fs.writeFileSync(filepath, content);
    return filepath;
  } catch (err) {
    console.warn('Could not save report:', err);
    return '';
  }
}
