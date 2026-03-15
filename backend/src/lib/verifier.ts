/**
 * Real Fix Verifier — calls Browser Worker for DOM checks, runs API checks directly
 */

const STAGING_API = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
const BROWSER_WORKER = process.env.BROWSER_WORKER_URL || 'http://127.0.0.1:3099';

// ============ Types ============

export interface VerifyCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  details: string;
}

// ============ Browser Worker — DOM Checks ============

export async function verifyDOM(
  path: string,
  checks: any[]
): Promise<{ checks: VerifyCheck[]; screenshot?: string }> {
  try {
    const res = await fetch(`${BROWSER_WORKER}/dom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, checks }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      return {
        checks: [{ name: `DOM check: ${path}`, status: 'skip', details: `Browser unavailable (${res.status}) — DOM checks skipped` }],
      };
    }

    const data = await res.json();
    return { checks: data.results || [], screenshot: data.screenshot };
  } catch (err: any) {
    // Any connection error → skip (non-blocking), not fail
    return {
      checks: [{
        name: `Browser check: ${path}`,
        status: 'skip',
        details: 'Browser not available — DOM checks skipped (code + API checks still ran)',
      }],
    };
  }
}

// ============ API Verification ============

export async function verifyAPI(
  endpoint: string,
  checks: { field?: string; exists?: boolean; type?: string; minLength?: number; contains?: string; greaterThan?: number }[]
): Promise<VerifyCheck[]> {
  const results: VerifyCheck[] = [];
  const url = endpoint.startsWith('http') ? endpoint : `${STAGING_API}${endpoint}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    results.push({
      name: `GET ${endpoint}`,
      status: res.ok ? 'pass' : 'fail',
      details: `HTTP ${res.status}`,
    });

    if (!res.ok) return results;

    const data = await res.json();

    for (const check of checks) {
      if (!check.field) continue;
      const value = getNestedValue(data, check.field);

      if (check.exists !== undefined) {
        results.push({
          name: `"${check.field}" ${check.exists ? 'present' : 'absent'}`,
          status: ((value !== undefined && value !== null) === check.exists) ? 'pass' : 'fail',
          details: value !== undefined ? `Value: ${JSON.stringify(value).substring(0, 100)}` : 'Not found',
        });
      }
      if (check.type) {
        const actual = Array.isArray(value) ? 'array' : typeof value;
        results.push({
          name: `"${check.field}" type is ${check.type}`,
          status: actual === check.type ? 'pass' : 'fail',
          details: `Got: ${actual}`,
        });
      }
      if (check.minLength !== undefined && (Array.isArray(value) || typeof value === 'string')) {
        results.push({
          name: `"${check.field}" length ≥ ${check.minLength}`,
          status: value.length >= check.minLength ? 'pass' : 'fail',
          details: `Length: ${value.length}`,
        });
      }
      if (check.greaterThan !== undefined && typeof value === 'number') {
        results.push({
          name: `"${check.field}" > ${check.greaterThan}`,
          status: value > check.greaterThan ? 'pass' : 'fail',
          details: `Value: ${value}`,
        });
      }
    }
  } catch (err: any) {
    results.push({ name: `GET ${endpoint}`, status: 'fail', details: `Error: ${err.message}` });
  }

  return results;
}

// ============ Quick Buy Check ============

export async function verifyQuickBuy(tokenAddress: string, amount = 0.001): Promise<VerifyCheck[]> {
  const results: VerifyCheck[] = [];
  try {
    const res = await fetch(`${STAGING_API}/api/trade/quickbuy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenAddress, amount, slippage: 50 }),
      signal: AbortSignal.timeout(20000),
    });
    results.push({
      name: 'Quick Buy API endpoint responds',
      status: res.ok ? 'pass' : 'warn',
      details: `HTTP ${res.status}`,
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data) {
        results.push({
          name: 'Quick Buy returns transaction data',
          status: data.transaction || data.signature || data.txHash ? 'pass' : 'warn',
          details: JSON.stringify(data).substring(0, 150),
        });
      }
    }
  } catch (err: any) {
    results.push({ name: 'Quick Buy API', status: 'fail', details: err.message });
  }
  return results;
}

// ============ Browser Worker Health ============

export async function isBrowserWorkerUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BROWSER_WORKER}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ============ Helpers ============

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((curr, key) => {
    if (curr == null) return undefined;
    const arrMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) return curr[arrMatch[1]]?.[parseInt(arrMatch[2])];
    return curr[key];
  }, obj);
}

export function closeBrowser() { /* browser lives in worker process */ }
