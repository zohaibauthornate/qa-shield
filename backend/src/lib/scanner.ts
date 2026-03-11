/**
 * Security Scanner & Performance Benchmarker for QA Shield
 * Checks CORS, auth gaps, data exposure + benchmarks against competitors
 */

// ============ Types ============

export interface SecurityScanResult {
  endpoint: string;
  checks: SecurityCheckResult[];
  overallStatus: 'pass' | 'warn' | 'fail';
  timestamp: string;
}

export interface SecurityCheckResult {
  type: 'cors' | 'auth' | 'data-exposure' | 'rate-limit' | 'headers';
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

    if (res.ok) {
      const body = await res.text();
      const hasUserData = body.includes('userId') || body.includes('email') || body.includes('wallet');

      return {
        type: 'auth',
        status: hasUserData ? 'fail' : 'warn',
        details: hasUserData
          ? 'Endpoint returns user-specific data WITHOUT authentication'
          : `Endpoint accessible without auth (${res.status}) but no obvious user data detected`,
        severity: hasUserData ? 'critical' : 'medium',
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

    if (!res.headers.get('strict-transport-security')) issues.push('Missing HSTS');
    if (!res.headers.get('x-content-type-options')) issues.push('Missing X-Content-Type-Options');
    if (!res.headers.get('x-frame-options')) issues.push('Missing X-Frame-Options');

    return {
      type: 'headers',
      status: issues.length > 2 ? 'fail' : issues.length > 0 ? 'warn' : 'pass',
      details: issues.length > 0 ? `Missing headers: ${issues.join(', ')}` : 'All security headers present',
      severity: issues.length > 2 ? 'high' : issues.length > 0 ? 'medium' : 'low',
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
      { pattern: /password/i, label: 'password field' },
      { pattern: /secret/i, label: 'secret field' },
      { pattern: /private_key/i, label: 'private key' },
      { pattern: /api_key/i, label: 'API key' },
      { pattern: /token.*eyJ/i, label: 'JWT token' },
      { pattern: /\b[A-Za-z0-9]{32,64}\b.*key/i, label: 'possible API key' },
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
      details: 'No obvious sensitive data patterns detected',
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

// ============ Performance Benchmarker ============

export async function benchmarkEndpoint(url: string): Promise<PerformanceResult> {
  const start = performance.now();
  let ttfbTime = 0;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });

    ttfbTime = performance.now() - start;
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

const API_ENDPOINT_MAPPINGS: EndpointMapping[] = [
  {
    name: 'Token List',
    ourPath: '/api/token/list?limit=20',
    competitors: [
      { name: 'pump.fun', endpoint: 'https://frontend-api.pump.fun/coins?limit=20&sort=last_trade_unix_timestamp&includeNsfw=false' },
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
    name: 'Token Detail',
    ourPath: '/api/token/Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD',
    competitors: [
      { name: 'pump.fun', endpoint: 'https://frontend-api.pump.fun/coins/Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD' },
    ],
  },
];

async function sampleEndpoint(url: string): Promise<number> {
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    await res.text(); // consume body
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

  // Compare against fastest competitor
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
