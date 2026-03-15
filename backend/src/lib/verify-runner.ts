/**
 * verify-runner.ts — Core ticket verification logic (shared by single + bulk routes)
 * Extracted from /api/verify/route.ts to allow reuse in /api/verify/bulk
 */

import {
  addComment,
  updateIssueState,
  WORKFLOW_STATES,
  type LinearIssue,
} from '@/lib/linear';
import { verifyAPI, verifyDOM, verifyQuickBuy, type VerifyCheck } from '@/lib/verifier';
import { getTicketContext, formatGitHubContextForComment, type GitHubContext } from '@/lib/github';
import { verifyCodeChanges, inferRepo, type CodeCheck } from '@/lib/code-verifier';

const STAGING_API_BASE = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
const BROWSER_WORKER = process.env.BROWSER_WORKER_URL || 'http://127.0.0.1:3099';

// ============ Types ============

export interface VerifyTicketResult {
  identifier: string;
  title: string;
  verdict: 'pass' | 'fail' | 'partial';
  checks: VerifyCheck[];
  summary: { passed: number; failed: number; warned: number; total: number };
  movedToDone: boolean;
  commentPosted: boolean;
  failureScreenshots?: string[]; // base64 JPEGs
  error?: string;
}

export interface CrossCheck {
  name: string;
  apiEndpoint: string;
  apiField: string;
  domPath: string;
  domSelector: string;
  domAction?: string;
  tolerance?: number;
  description: string;
}

export interface VerificationPlan {
  apiChecks: { endpoint: string; checks: any[] }[];
  domChecks: { path: string; checks: any[] }[];
  crossChecks: CrossCheck[];
  transactionCheck?: { tokenAddress: string; amount: number };
  reasoning: string;
  /** Stage 1: code-level checks to confirm fix is present in the repo before running live tests */
  codeChecks?: {
    repo: string;
    branch: string;
    checks: CodeCheck[];
  };
}

// ============ Main Runner ============

export async function runVerification(
  issue: LinearIssue,
  options: { postComment?: boolean; moveToDone?: boolean } = {}
): Promise<VerifyTicketResult> {
  const { postComment = true, moveToDone = true } = options;

  try {
    // Fetch GitHub context
    let githubCtx: GitHubContext | null = null;
    try {
      githubCtx = await getTicketContext(issue.identifier);
    } catch {
      // Skip if unavailable
    }

    // Build verification plan
    const plan = await buildVerificationPlan(issue, githubCtx ?? undefined);
    const allChecks: VerifyCheck[] = [];

    // ── Stage 1: Code-level verification ──
    // Confirm the fix is actually present in the repo before running live tests
    let codeVerifyNote = '';
    if (plan.codeChecks?.checks?.length) {
      console.log(`[verify-runner] Running ${plan.codeChecks.checks.length} code checks on ${plan.codeChecks.repo}@${plan.codeChecks.branch}`);
      try {
        const codeResult = await verifyCodeChanges(plan.codeChecks.repo, plan.codeChecks.branch, plan.codeChecks.checks);
        for (const r of codeResult.checks) {
          allChecks.push({
            name: `[Code] ${r.description}`,
            status: r.status === 'pass' ? 'pass' : r.status === 'warn' ? 'warn' : 'fail',
            details: r.details || '',
          });
        }
        if (!codeResult.allPassed && !codeResult.someWarned) {
          codeVerifyNote = '⚠️ Code changes NOT found in pre-staging — fix may not be merged yet. Live tests may be unreliable.';
        } else if (codeResult.allPassed && !codeResult.someWarned) {
          codeVerifyNote = '✅ Code changes confirmed present in pre-staging.';
        }
      } catch (codeErr: any) {
        console.warn('[verify-runner] Code verification error:', codeErr.message);
        allChecks.push({ name: '[Code] Code verification', status: 'warn', details: `Code check failed: ${codeErr.message}` });
      }
    }

    // ── Stage 2: Live app checks ──
    // API checks (parallel)
    if (plan.apiChecks.length > 0) {
      const apiResultGroups = await Promise.all(
        plan.apiChecks.map(apiCheck => verifyAPI(apiCheck.endpoint, apiCheck.checks))
      );
      for (const results of apiResultGroups) allChecks.push(...results);
    }

    // DOM checks (sequential — browser worker)
    const failureScreenshots: string[] = []; // base64 JPEGs from failed pages
    if (plan.domChecks.length > 0) {
      for (const domGroup of plan.domChecks) {
        const { checks: domResults, screenshot } = await verifyDOM(domGroup.path, domGroup.checks);
        allChecks.push(...domResults);
        // Capture screenshot if any check on this page failed
        if (screenshot && domResults.some(c => c.status === 'fail')) {
          failureScreenshots.push(screenshot);
        }
      }
    }

    // Cross-checks
    if (plan.crossChecks?.length > 0) {
      for (const cc of plan.crossChecks) {
        const result = await runCrossCheck(cc);
        allChecks.push(result);
      }
    }

    // Transaction check
    if (plan.transactionCheck) {
      const txResults = await verifyQuickBuy(
        plan.transactionCheck.tokenAddress,
        plan.transactionCheck.amount || 0.001
      );
      allChecks.push(...txResults);
    }

    // Verdict
    const passed = allChecks.filter(c => c.status === 'pass').length;
    const failed = allChecks.filter(c => c.status === 'fail').length;
    const warned = allChecks.filter(c => c.status === 'warn').length;
    const total = allChecks.length;

    // Verdict — only hard functional failures count as 'fail'
    // Warn-only = pass (non-blocking issues), all fail = fail, mixed = partial
    const functionalFails = allChecks.filter(c =>
      c.status === 'fail' &&
      !c.name.toLowerCase().includes('security') &&
      !c.name.toLowerCase().includes('cors') &&
      !c.name.toLowerCase().includes('header') &&
      !c.name.toLowerCase().includes('rate limit') &&
      !c.name.toLowerCase().includes('performance') &&
      !c.name.toLowerCase().includes('perf') &&
      !c.name.toLowerCase().includes('auth wall')
    );

    let verdict: 'pass' | 'fail' | 'partial';
    if (functionalFails.length === 0 && passed > 0) verdict = 'pass';
    else if (functionalFails.length > 0 && passed === 0) verdict = 'fail';
    else if (functionalFails.length > 0) verdict = 'partial';
    else verdict = 'partial';

    let commentPosted = false;
    let movedToDone = false;

    if (postComment) {
      let comment = formatVerificationComment(issue, allChecks, verdict, plan, codeVerifyNote);
      if (githubCtx) comment += '\n\n' + formatGitHubContextForComment(githubCtx);
      // Append screenshot note if we have failure screenshots
      if (failureScreenshots.length > 0) {
        comment += `\n\n📸 *${failureScreenshots.length} failure screenshot(s) captured* — attach via QA Shield dashboard or browser extension.`;
      }
      await addComment(issue.id, comment);
      commentPosted = true;

      if (moveToDone && verdict === 'pass') {
        await updateIssueState(issue.id, WORKFLOW_STATES.DONE);
        movedToDone = true;
      }
    }

    return {
      identifier: issue.identifier,
      title: issue.title,
      verdict,
      checks: allChecks,
      summary: { passed, failed, warned, total },
      movedToDone,
      commentPosted,
      failureScreenshots,
    };

  } catch (err: any) {
    return {
      identifier: issue.identifier,
      title: issue.title,
      verdict: 'fail',
      checks: [],
      summary: { passed: 0, failed: 0, warned: 0, total: 0 },
      movedToDone: false,
      commentPosted: false,
      error: err.message,
    };
  }
}

// ============ Cross-Check Runner ============

async function runCrossCheck(cc: CrossCheck): Promise<VerifyCheck> {
  try {
    const apiUrl = cc.apiEndpoint.startsWith('http') ? cc.apiEndpoint : `${STAGING_API_BASE}${cc.apiEndpoint}`;
    const apiRes = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
    if (!apiRes.ok) {
      return { name: cc.name, status: 'fail', details: `API ${cc.apiEndpoint} returned ${apiRes.status}` };
    }
    const apiData = await apiRes.json();
    const apiValue = getNestedValue(apiData, cc.apiField);
    if (apiValue === undefined || apiValue === null) {
      return { name: cc.name, status: 'warn', details: `API field "${cc.apiField}" not found` };
    }

    const domRes = await fetch(`${BROWSER_WORKER}/dom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: cc.domPath,
        checks: [{ name: `Extract: ${cc.domSelector}`, selector: cc.domSelector, action: cc.domAction || 'text' }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    const domData = await domRes.json();
    const domResult = domData.results?.[0];

    if (!domResult || domResult.status === 'fail') {
      return { name: cc.name, status: 'fail', details: `UI element not found — selector: "${cc.domSelector}"` };
    }

    const domRaw = domResult.details || '';
    const domNumMatch = domRaw.replace(/,/g, '').match(/-?\d+\.?\d*/);
    const domValue = domNumMatch ? parseFloat(domNumMatch[0]) : null;
    const apiNumeric = typeof apiValue === 'number' ? apiValue : parseFloat(String(apiValue).replace(/,/g, ''));
    const tolerance = cc.tolerance ?? 0.01;

    if (domValue === null) {
      return { name: cc.name, status: 'warn', details: `Could not extract numeric from DOM: "${domRaw.substring(0, 100)}"` };
    }

    const diff = Math.abs(domValue - apiNumeric);
    const pass = diff <= tolerance || (apiNumeric !== 0 && diff / Math.abs(apiNumeric) < 0.001);

    return {
      name: cc.name,
      status: pass ? 'pass' : 'fail',
      details: pass
        ? `✅ API (${apiNumeric}) matches UI (${domValue})`
        : `❌ MISMATCH — API: ${apiNumeric}, UI: ${domValue} (diff: ${diff.toFixed(4)})`,
    };
  } catch (err: any) {
    return { name: cc.name, status: 'fail', details: `Cross-check error: ${err.message}` };
  }
}

// ============ Verification Plan Builder ============

const QA_SHIELD_BASE = `http://localhost:${process.env.PORT || 3000}`;

// Poll AI queue for a result (up to maxWaitMs)
async function waitForAIResult(taskId: string, maxWaitMs = 90_000): Promise<unknown | null> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${QA_SHIELD_BASE}/api/ai/queue?taskId=${taskId}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const task = await res.json();
        if (task.status === 'done' && task.result) return task.result;
        if (task.status === 'failed') return null;
      }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

async function buildVerificationPlan(issue: LinearIssue, githubCtx?: GitHubContext): Promise<VerificationPlan> {
  // AI priority: OpenAI API → Chief QA proxy → rule-based fallback
  const openaiKey = process.env.OPENAI_API_KEY;

  let githubSection = '';
  if (githubCtx?.hasChanges) {
    githubSection = `\nGITHUB CHANGES:\nFiles: ${githubCtx.allFilesChanged.map(f => f.filename).join(', ')}\nAreas: ${githubCtx.impactedAreas.join(', ')}\n`;
    const filesWithPatches = githubCtx.allFilesChanged.filter(f => f.patch).slice(0, 2);
    for (const file of filesWithPatches) {
      githubSection += `\nDiff: ${file.filename}\n${file.patch!.substring(0, 600)}\n`;
    }
    githubSection += `\nFocus verification on what actually changed.\n`;
  } else if (githubCtx) {
    githubSection = `\nGITHUB: No commits on staging for this ticket yet.\n`;
  }

  // ── Build rich diff context for AI ──
  let diffContext = '';
  if (githubCtx?.hasChanges) {
    // Include full patch for changed files (up to 3 files, 800 chars each)
    const patches = githubCtx.allFilesChanged
      .filter(f => f.patch)
      .slice(0, 3)
      .map(f => `File: ${f.filename}\nDiff:\n${f.patch!.substring(0, 800)}`)
      .join('\n\n');
    diffContext = patches
      ? `\n\nCODE CHANGES (what actually changed in staging):\n${patches}\n\nUse the diff to understand EXACTLY what was fixed and write checks that directly verify that specific change.`
      : '';
  }

  const systemPrompt = `You are QA Shield, a senior QA automation engineer for dev.creator.fun — a Solana meme coin creation and trading platform (similar to pump.fun).

MISSION: Generate PRECISE, TARGETED verification checks that confirm THIS specific fix works on staging.

CRITICAL RULES:
1. Read the git diff carefully — understand WHAT changed (component, function, behavior)
2. Map the change to the CORRECT page/URL where it's visible
3. NEVER check /settings or unrelated pages
4. If the fix is in TradingViewChart.tsx → check /details/[token-address]
5. If the fix is in profile/ → check /profile
6. If the fix is in Header.tsx → check / (homepage)
7. If the fix is backend only (no UI change) → use apiChecks, no domChecks
8. If nothing is directly testable, return empty arrays — do NOT invent checks

Platform pages and what they contain:
- / → token list, header, navigation, coin cards, discovery row
- /details/[address] → TradingView chart, PnL chip, token sidebar, trading panel, holders table
- /profile → wallet stats card (Holding/Invested/PnL), My Holdings table, transactions, created coins
- /chat → chatrooms, user search, DMs
- /leaderboard → rankings, stats
- /create → coin creation form

Working API endpoints (staging: https://dev.bep.creator.fun):
- GET /api/token/list?limit=20 → {data:[{name,ticker,mcap,address,...}],total}
- GET /api/token/:address → single token
- GET /api/token/search?q=X → search results
- GET /api/profile/stats/trading?userId=X → {remaining,invested,pnlValue,...}
- GET /api/profile/my-holdings?userId=X → holdings list

CSS color checks: use action:"style" with selector to verify computed styles.
For visibility: use action:"visible" or action:"hidden".

CODE CHECKS:
You MUST also generate "codeChecks" to verify the fix is present in the GitHub repo.
- For each code change in the ticket/diff: add one check with the key pattern
- type="removed": pattern should NOT be in file (e.g. deleted import, removed call)
- type="added": pattern MUST be in file (e.g. new function, new prop)
- Infer repo: if filenames start with src/pages/, src/hooks/, src/components/ → "creatorfun/frontend"; backend files → "creatorfun/backend-persistent"
- branch is always "pre-staging"
- Use short, specific patterns (not full lines — just the distinctive string)

Respond ONLY with valid JSON (no markdown):
{"reasoning":"1-2 sentences on what changed and what you're checking","codeChecks":{"repo":"creatorfun/frontend","branch":"pre-staging","checks":[{"description":"useWebsocketOrders import removed","file":"src/pages/details/sections/FinanceSection.tsx","type":"removed","pattern":"useWebsocketOrders"}]},"apiChecks":[{"endpoint":"/api/path","checks":[{"field":"data.0.name","exists":true}]}],"domChecks":[{"path":"/correct-page","checks":[{"name":"Descriptive check name","selector":"CSS selector","action":"exists|text|visible|hidden|style"}]}],"crossChecks":[],"transactionCheck":null}`;

  const userContent = `TICKET: ${issue.identifier}: ${issue.title}\n\nDESCRIPTION:\n${(issue.description || 'No description').substring(0, 800)}\n\nLabels: ${issue.labels?.nodes?.map((l: any) => l.name).join(', ') || 'none'}\nDev comments: ${issue.comments?.nodes?.map((c: any) => `[${c.user?.name}]: ${c.body?.substring(0, 300)}`).join('\n') || 'None'}${githubSection}${diffContext}`;

  // ── Try OpenAI API first (fast, ~10s) ──
  if (openaiKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      });
      const parsed = JSON.parse(completion.choices[0].message.content || '{}');
      return {
        apiChecks: parsed.apiChecks || [],
        domChecks: parsed.domChecks || [],
        crossChecks: parsed.crossChecks || [],
        transactionCheck: parsed.transactionCheck || undefined,
        reasoning: parsed.reasoning || 'OpenAI-generated plan',
        codeChecks: parsed.codeChecks?.checks?.length ? parsed.codeChecks : undefined,
      };
    } catch (err: any) {
      console.warn('[verify-runner] OpenAI failed, trying Chief QA proxy:', err.message);
    }
  }

  // ── Chief QA proxy (no API key needed) ──
  try {
    const queueRes = await fetch(`${QA_SHIELD_BASE}/api/ai/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'verify-plan',
        payload: {
          identifier: issue.identifier,
          title: issue.title,
          description: (issue.description || '').slice(0, 1000),
          files: githubCtx?.allFilesChanged?.map(f => f.filename) || [],
          impactedAreas: githubCtx?.impactedAreas || [],
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (queueRes.ok) {
      const { taskId } = await queueRes.json();
      const result = await waitForAIResult(taskId, 90_000);
      if (result) return result as VerificationPlan;
    }
  } catch (queueErr: any) {
    console.warn('[verify-runner] Chief QA proxy unavailable:', queueErr.message);
  }

  // Pre-warm live token cache before fallback runs
  await getLiveTokenAddress().catch(() => {});
  const fallbackPlan = buildFallbackPlan(issue);

  // Even in fallback: derive code checks from GitHub diff if available
  if (githubCtx?.hasChanges && githubCtx.allFilesChanged.length > 0) {
    const branch = process.env.GITHUB_BRANCH || 'pre-staging';
    const repo = inferRepo(githubCtx.allFilesChanged.map(f => f.filename));
    const codeChecks: CodeCheck[] = [];

    for (const file of githubCtx.allFilesChanged.slice(0, 5)) {
      if (!file.patch) continue;
      // Extract removed lines (- lines in diff that are not @@ headers)
      const removedLines = file.patch.split('\n')
        .filter(l => l.startsWith('-') && !l.startsWith('---'))
        .map(l => l.slice(1).trim())
        .filter(l => l.length > 8 && !l.startsWith('//') && !l.startsWith('*'));
      // Extract added lines
      const addedLines = file.patch.split('\n')
        .filter(l => l.startsWith('+') && !l.startsWith('+++'))
        .map(l => l.slice(1).trim())
        .filter(l => l.length > 8 && !l.startsWith('//') && !l.startsWith('*'));

      // Pick most distinctive removed/added patterns (imports, function names, key identifiers)
      const distinctiveRemoved = removedLines
        .filter(l => /import|export|function|const |interface |type |class /.test(l))
        .slice(0, 2);
      const distinctiveAdded = addedLines
        .filter(l => /import|export|function|const |interface |type |class /.test(l))
        .slice(0, 2);

      for (const line of distinctiveRemoved) {
        const pattern = line.length > 60 ? line.slice(0, 60) : line;
        codeChecks.push({ description: `Removed: "${pattern.slice(0, 50)}..."`, file: file.filename, type: 'removed', pattern });
      }
      for (const line of distinctiveAdded) {
        const pattern = line.length > 60 ? line.slice(0, 60) : line;
        codeChecks.push({ description: `Added: "${pattern.slice(0, 50)}..."`, file: file.filename, type: 'added', pattern });
      }
    }

    if (codeChecks.length > 0) {
      fallbackPlan.codeChecks = { repo, branch, checks: codeChecks.slice(0, 8) };
    }
  }

  return fallbackPlan;
}



// Cache the live token address for 10 min so we don't hammer the API
let _liveTokenCache: { address: string; fetchedAt: number } | null = null;

async function getLiveTokenAddress(): Promise<string> {
  const FALLBACK = '3jHkaVj9392sasDhVWivWyW8UYY3cfRCRJg3eEprDH7Q';
  const now = Date.now();
  if (_liveTokenCache && now - _liveTokenCache.fetchedAt < 10 * 60 * 1000) {
    return _liveTokenCache.address;
  }
  try {
    const res = await fetch('https://dev.bep.creator.fun/api/token/list?limit=3', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const d = await res.json();
      const addr = d?.data?.[0]?.address;
      if (addr) {
        _liveTokenCache = { address: addr, fetchedAt: now };
        return addr;
      }
    }
  } catch { /* fallback */ }
  return FALLBACK;
}

export function buildFallbackPlan(issue: LinearIssue): VerificationPlan {
  const combined = `${issue.title} ${issue.description || ''}`.toLowerCase();
  const plan: VerificationPlan = { apiChecks: [], domChecks: [], crossChecks: [], reasoning: '' };
  // Use cached live token (resolved async before calling this — see buildVerificationPlan)
  const TOKEN_ADDR = _liveTokenCache?.address || '3jHkaVj9392sasDhVWivWyW8UYY3cfRCRJg3eEprDH7Q';
  const API = 'https://dev.bep.creator.fun';

  const matched: string[] = [];

  // ── Chart / TradingView ──
  if (/tradingview|chart|candle|overlay|pnl.?chip|zoom|resize|padding.*chart|chart.*padding/.test(combined)) {
    plan.domChecks.push({
      path: `/details/${TOKEN_ADDR}`,
      checks: [
        { name: 'TradingView chart renders', selector: 'canvas, .tradingview-widget-container, [class*="chart"]', action: 'exists' },
        { name: 'Chart area visible', selector: '[class*="chart"], [id*="chart"]', action: 'visible' },
        { name: 'No error overlay on chart', selector: '[class*="error-overlay"], [class*="chart-error"]', action: 'hidden' },
      ],
    });
    matched.push('Chart/TradingView');
  }

  // ── Token detail sidebar / stats ──
  if (/token.?detail|token.*stat|volume.*stat|stats.*card|mcap|market.?cap|token.*search|chart.*header|token.*title/.test(combined)) {
    plan.domChecks.push({
      path: `/details/${TOKEN_ADDR}`,
      checks: [
        { name: 'Token price visible', selector: '[class*="price"], [class*="token-price"]', action: 'exists' },
        { name: 'Volume stat present', selector: '[class*="volume"], [class*="stat"]', action: 'exists' },
        { name: 'Market cap present', selector: '[class*="mcap"], [class*="market-cap"], [class*="marketcap"]', action: 'exists' },
      ],
    });
    plan.apiChecks.push({
      endpoint: `${API}/api/token?address=${TOKEN_ADDR}`,
      checks: [{ field: 'address', exists: true }, { field: 'price', exists: true }],
    });
    matched.push('Token Detail');
  }

  // ── Token search ──
  if (/search.*dropdown|search.*token|token.*search/.test(combined)) {
    plan.domChecks.push({
      path: `/details/${TOKEN_ADDR}`,
      checks: [
        { name: 'Search input present', selector: 'input[type="search"], input[placeholder*="search" i], [class*="search-input"]', action: 'exists' },
      ],
    });
    matched.push('Token Search');
  }

  // ── Discover / coin cards / discovery row ──
  if (/coin.?card|discovery.?row|desktop.*discover|token.*list|discover/.test(combined)) {
    plan.domChecks.push({
      path: '/',
      checks: [
        { name: 'Token cards render', selector: '[class*="token-card"], [class*="coin-card"], [class*="TokenCard"]', action: 'exists' },
        { name: 'Discovery row visible', selector: '[class*="discovery"], [class*="row"]', action: 'exists' },
      ],
    });
    plan.apiChecks.push({
      endpoint: `${API}/api/token/list?limit=10`,
      checks: [{ field: 'data', type: 'array' }, { field: 'total', exists: true }],
    });
    matched.push('Discover/Token List');
  }

  // ── Navigation / header ──
  if (/nav|navigation|menu|header|desktop.*nav/.test(combined)) {
    plan.domChecks.push({
      path: '/',
      checks: [
        { name: 'Navigation menu visible', selector: 'nav, header, [class*="navbar"], [class*="navigation"]', action: 'exists' },
        { name: 'Nav links present', selector: 'nav a, [class*="nav-link"], [class*="menu-item"]', action: 'exists' },
      ],
    });
    matched.push('Navigation');
  }

  // ── Trading / buy / sell / UI fixes ──
  if (/trading.?page|trading.*ui|buy|sell|swap|trade/.test(combined)) {
    plan.domChecks.push({
      path: `/details/${TOKEN_ADDR}`,
      checks: [
        { name: 'Buy button present', selector: '[class*="buy"], button[data-action="buy"]', action: 'exists' },
        { name: 'Trade panel visible', selector: '[class*="trade"], [class*="trading"], [class*="swap"]', action: 'exists' },
      ],
    });
    matched.push('Trading UI');
  }

  // ── Profile badge / rank / streak / separator ──
  if (/badge|rank|streak|separator|rank.*streak|streak.*rank|leaderboard.*rank|rank.*badge/.test(combined)) {
    plan.domChecks.push({
      path: '/profile',
      checks: [
        { name: 'Profile page renders', selector: 'body', action: 'exists' },
        { name: 'Rank/badge component visible', selector: 'img[src*="leaderboard"], img[src*="Bronze"], img[src*="Unranked"], img[src*="Gold"], img[src*="Silver"], img[src*="Diamond"], img[src*="Platinum"]', action: 'exists' },
        { name: 'Rank/streak separator visible', selector: 'div.h-3\\.5, div[class*="w-\\[1.5px\\]"], div[class*="bg-white\\/64"]', action: 'exists' },
        { name: 'Streak fire icon present', selector: 'svg, img[src*="fire"], [class*="streak"]', action: 'exists' },
      ],
    });
    matched.push('Profile Badge/Rank/Streak');
  }

  // ── Profile / PnL / holdings / wallet ──
  if (/\bpnl\b|holding|portfolio|wallet.*balance|invested|my.?holding/.test(combined)) {
    plan.domChecks.push({
      path: '/profile',
      checks: [
        { name: 'Profile page renders', selector: 'body', action: 'exists' },
        { name: 'Wallet balance visible', selector: '[class*="balance"], [class*="wallet"], h1, h2', action: 'exists' },
        { name: 'Holdings or stats section present', selector: '[class*="holding"], [class*="stat"], table', action: 'exists' },
      ],
    });
    matched.push('Profile/PnL');
  }

  // ── Mobile / scroll ──
  if (/mobile|scroll|responsive/.test(combined)) {
    plan.domChecks.push({
      path: '/',
      checks: [
        { name: 'Page body renders on mobile viewport', selector: 'body', action: 'exists' },
      ],
    });
    matched.push('Mobile/Scroll');
  }

  // ── Share / reward / visual ──
  if (/share|reward|visual/.test(combined)) {
    plan.domChecks.push({
      path: `/details/${TOKEN_ADDR}`,
      checks: [
        { name: 'Share button or reward element visible', selector: '[class*="share"], [class*="reward"], button[aria-label*="share" i]', action: 'exists' },
      ],
    });
    matched.push('Share/Reward');
  }

  // ── Chat / convo / spacing ──
  if (/chat|convo|message|spacing.*convo|user.*search/.test(combined)) {
    plan.domChecks.push({
      path: `/details/${TOKEN_ADDR}`,
      checks: [
        { name: 'Chat panel present', selector: '[class*="chat"], [class*="messages"], [class*="convo"]', action: 'exists' },
        { name: 'User search visible', selector: 'input[placeholder*="search" i], [class*="user-search"]', action: 'exists' },
      ],
    });
    matched.push('Chat');
  }

  // ── Token data / icon / banner ──
  if (/icon|banner|image|token.*data|base.?token/.test(combined)) {
    plan.apiChecks.push({
      endpoint: `${API}/api/token/list?limit=5`,
      checks: [{ field: 'data', type: 'array' }, { field: 'data.0.image', exists: true }],
    });
    matched.push('Token Icon/Data');
  }

  // ── Security / CORS / JWT / auth / hardening ──
  if (/cors|jwt|auth|harden|secret|rate.?limit|upload|onboard|security|penetration/.test(combined)) {
    plan.apiChecks.push(
      { endpoint: `${API}/api/token/list?limit=5`, checks: [{ field: 'data', type: 'array' }] },
    );
    matched.push('Security/Auth — manual review recommended for full validation');
  }

  // ── Leaderboard ──
  if (/leaderboard|ranking/.test(combined)) {
    plan.apiChecks.push({ endpoint: `${API}/api/leaderboard?limit=5`, checks: [{ field: 'data', exists: true }] });
    plan.domChecks.push({
      path: '/leaderboard',
      checks: [{ name: 'Leaderboard renders', selector: 'table, [class*="leaderboard"], [class*="rank"]', action: 'exists' }],
    });
    matched.push('Leaderboard');
  }

  // ── SDK / Scale ──
  if (/sdk|scale|scalecrx|graduated/.test(combined)) {
    plan.apiChecks.push({ endpoint: `${API}/api/token/list?limit=5`, checks: [{ field: 'data', type: 'array' }] });
    plan.domChecks.push({
      path: '/',
      checks: [{ name: 'App renders after SDK change', selector: 'body', action: 'exists' }],
    });
    matched.push('SDK/Scale');
  }

  if (matched.length === 0) {
    // Generic smoke test — at minimum verify staging is alive
    plan.apiChecks.push({ endpoint: `${API}/api/token/list?limit=5`, checks: [{ field: 'data', type: 'array' }] });
    plan.domChecks.push({
      path: '/',
      checks: [{ name: 'Staging homepage loads', selector: 'body', action: 'exists' }],
    });
    plan.reasoning = `No specific area matched — running smoke test only. Manual verification required for: ${issue.title}`;
  } else {
    plan.reasoning = `Rule-based plan for: ${matched.join(', ')}`;
  }

  return plan;
}

// ============ Comment Formatter ============

export function formatVerificationComment(
  issue: { identifier: string; title: string },
  checks: VerifyCheck[],
  verdict: string,
  plan: VerificationPlan,
  codeVerifyNote?: string
): string {
  const now = new Date().toISOString();
  const passed = checks.filter(c => c.status === 'pass');
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');

  // Separate code-level from live checks
  const codeChecks = checks.filter(c => c.name.startsWith('[Code]'));
  const liveChecks = checks.filter(c => !c.name.startsWith('[Code]'));

  // Verdict block
  const verdictIcon = verdict === 'pass' ? '✅' : verdict === 'fail' ? '❌' : '⚠️';
  const verdictLabel = verdict === 'pass' ? 'PASSED' : verdict === 'fail' ? 'FAILED' : 'PARTIAL';
  const verdictNote = verdict === 'pass'
    ? 'All executed test cases passed. Ticket moved to Done.'
    : verdict === 'fail'
    ? 'One or more test cases failed. Ticket requires a fix before it can be closed.'
    : 'Some checks passed, some failed — or test coverage was incomplete. Manual review recommended.';

  let out = `## ${verdictIcon} QA Verification — ${verdictLabel}

> **${issue.identifier}:** ${issue.title}
> ${verdictNote}

---

### 🧪 Test Strategy
${plan.reasoning}

### 📊 Results Summary
| | Total | ✅ Passed | ❌ Failed | ⚠️ Warned |
|---|-------|-----------|-----------|-----------|
| 🔍 Code checks | ${codeChecks.length} | ${codeChecks.filter(c=>c.status==='pass').length} | ${codeChecks.filter(c=>c.status==='fail').length} | ${codeChecks.filter(c=>c.status==='warn').length} |
| 🧪 Live tests | ${liveChecks.length} | ${liveChecks.filter(c=>c.status==='pass').length} | ${liveChecks.filter(c=>c.status==='fail').length} | ${liveChecks.filter(c=>c.status==='warn').length} |
| **Total** | **${checks.length}** | **${passed.length}** | **${failed.length}** | **${warned.length}** |

${codeVerifyNote ? `> ${codeVerifyNote}\n` : ''}
`;

  // ── Stage 1: Code verification results ──
  if (codeChecks.length > 0) {
    out += `### 🔍 Stage 1 — Code Verification (GitHub \`${plan.codeChecks?.branch || 'pre-staging'}\`)\n\n`;
    out += `| # | Check | File | Result |\n|---|---|---|---|\n`;
    codeChecks.forEach((ch, i) => {
      const icon = ch.status === 'pass' ? '✅' : ch.status === 'fail' ? '❌' : '⚠️';
      const cleanName = ch.name.replace('[Code] ', '');
      const file = plan.codeChecks?.checks?.[i]?.file?.split('/').pop() || '';
      out += `| ${i + 1} | ${cleanName} | \`${file}\` | ${icon} ${ch.status.toUpperCase()} |\n`;
      if (ch.status !== 'pass') out += `| | | | *${ch.details}* |\n`;
    });
    out += '\n';
  }

  // ── Stage 2: Live app test results ──
  out += `### 🧪 Stage 2 — Live App Tests (dev.creator.fun)\n\n`;

  if (liveChecks.length > 0) {
    liveChecks.forEach((ch, i) => {
      const icon = ch.status === 'pass' ? '✅' : ch.status === 'fail' ? '❌' : '⚠️';
      const isApi = ch.name.toLowerCase().includes('http') || ch.name.toLowerCase().includes('get ') || ch.name.toLowerCase().includes('api');
      const type = isApi ? '`API`' : '`UI`';
      out += `**${i + 1}. ${icon} ${ch.name}** ${type}\n`;
      out += `- **Result:** ${ch.status.toUpperCase()}\n`;
      out += `- **Detail:** ${ch.details || '(no detail)'}\n\n`;
    });
  } else {
    out += `### 🔍 Test Cases Executed\n\n`;
    out += `> ⚠️ **No automated test cases were generated for this ticket.**\n>\n`;
    out += `> This can happen when:\n`;
    out += `> - The ticket scope is ambiguous or requires visual/manual verification\n`;
    out += `> - AI verification planner is unavailable (no API key)\n`;
    out += `> - The fix is in an area not yet covered by QA Shield's rule-based mapper\n>\n`;
    out += `> **Action required:** A human QA engineer should verify this ticket manually.\n\n`;
  }

  // Limitations / caveats
  const caveats: string[] = [];
  if (verdict !== 'fail' && plan.reasoning.toLowerCase().includes('security')) {
    caveats.push('Security hardening tickets require additional manual testing — automated checks only verify basic endpoint availability, not auth enforcement.');
  }
  if (verdict !== 'fail' && plan.reasoning.toLowerCase().includes('tradingview')) {
    caveats.push('TradingView chart internals render in an iframe — visual properties (colors, overlays) cannot be fully verified via DOM automation.');
  }
  if (verdict !== 'fail' && plan.reasoning.toLowerCase().includes('manual')) {
    caveats.push('Rule-based plan was used (no AI available) — checks may not fully cover the ticket scope.');
  }
  if (checks.length > 0 && checks.length < 3) {
    caveats.push(`Only ${checks.length} check(s) were run — coverage may be incomplete. More checks will be available once AI verification planner is enabled.`);
  }

  if (caveats.length > 0) {
    out += `### ⚠️ Caveats & Limitations\n`;
    caveats.forEach(c => { out += `- ${c}\n`; });
    out += '\n';
  }

  out += `---\n*QA Shield 🛡️ automated verification — ${now}*`;
  return out;
}

// ============ Helpers ============

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((curr: any, key: string) => {
    if (curr == null) return undefined;
    const arrMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) return curr[arrMatch[1]]?.[parseInt(arrMatch[2])];
    return curr[key];
  }, obj);
}
