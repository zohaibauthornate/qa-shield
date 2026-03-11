/**
 * POST /api/verify — Real fix verification
 * 1. AI reads ticket → generates verification strategy (what to check)
 * 2. Executes REAL checks: API calls, browser DOM inspection, screenshots
 * 3. AI analyzes real results → verdict
 * 4. If PASS → move to Done + comment. If FAIL → comment only.
 * NO security scan. NO benchmark. Those are separate.
 */

import { NextRequest } from 'next/server';
import {
  getIssueByIdentifier,
  addComment,
  updateIssueState,
  WORKFLOW_STATES,
  type LinearIssue,
} from '@/lib/linear';
import { verifyAPI, verifyDOM, verifyQuickBuy, closeBrowser, type VerifyCheck } from '@/lib/verifier';

export const maxDuration = 120;

const STAGING_URL = process.env.STAGING_URL || 'https://dev.creator.fun';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { identifier, postComment = true } = body;

  if (!identifier) {
    return new Response(JSON.stringify({ error: 'identifier required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: any) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // ── Step 1: Fetch ticket ──
        send('step', { step: 0, status: 'active', label: 'Fetching ticket...' });
        const issue = await getIssueByIdentifier(identifier);
        send('step', { step: 0, status: 'done', label: issue.title.substring(0, 60) });

        // ── Step 2: AI generates verification plan ──
        send('step', { step: 1, status: 'active', label: 'Building verification plan...' });
        const plan = await buildVerificationPlan(issue);
        send('step', { step: 1, status: 'done', label: `${plan.apiChecks.length} API + ${plan.domChecks.length} DOM checks` });
        send('plan', plan);

        // ── Step 3: Execute API checks ──
        const allChecks: VerifyCheck[] = [];

        if (plan.apiChecks.length > 0) {
          send('step', { step: 2, status: 'active', label: `Running ${plan.apiChecks.length} API checks in parallel...` });
          // ✅ Parallel — all API checks fire simultaneously
          const apiResultGroups = await Promise.all(
            plan.apiChecks.map(apiCheck => verifyAPI(apiCheck.endpoint, apiCheck.checks))
          );
          for (const results of apiResultGroups) {
            allChecks.push(...results);
            for (const r of results) {
              send('check', { type: 'api', ...r });
            }
          }
          const apiPassed = allChecks.filter(c => c.status === 'pass').length;
          send('step', { step: 2, status: 'done', label: `API: ${apiPassed}/${allChecks.length} passed` });
        } else {
          send('step', { step: 2, status: 'done', label: 'No API checks needed' });
        }

        // ── Step 4: Execute DOM checks ──
        if (plan.domChecks.length > 0) {
          send('step', { step: 3, status: 'active', label: `Inspecting ${plan.domChecks.length} pages...` });
          for (const domGroup of plan.domChecks) {
            const { checks: domResults, screenshot } = await verifyDOM(domGroup.path, domGroup.checks);
            allChecks.push(...domResults);
            for (const r of domResults) {
              send('check', { type: 'dom', page: domGroup.path, ...r });
            }
            if (screenshot) {
              send('screenshot', { path: domGroup.path, data: screenshot.substring(0, 200) + '...' });
            }
          }
          await closeBrowser();
          const domPassed = allChecks.filter(c => c.status === 'pass').length;
          send('step', { step: 3, status: 'done', label: `DOM: ${domPassed}/${allChecks.length} total passed` });
        } else {
          send('step', { step: 3, status: 'done', label: 'No DOM checks needed' });
        }

        // ── Step 4b: Cross-checks (API value vs DOM displayed value) ──
        if (plan.crossChecks && plan.crossChecks.length > 0) {
          send('step', { step: 4, status: 'active', label: `Running ${plan.crossChecks.length} cross-checks (API vs UI)...` });
          for (const cc of plan.crossChecks) {
            const result = await runCrossCheck(cc);
            allChecks.push(result);
            send('check', { type: 'cross', ...result });
          }
          send('step', { step: 4, status: 'done', label: `Cross-checks: ${plan.crossChecks.filter((_, i) => allChecks[allChecks.length - plan.crossChecks.length + i]?.status === 'pass').length}/${plan.crossChecks.length} passed` });
        }

        // ── Step 5: Transaction checks (if needed) ──
        if (plan.transactionCheck) {
          send('step', { step: 4, status: 'active', label: 'Testing transaction...' });
          const txResults = await verifyQuickBuy(
            plan.transactionCheck.tokenAddress,
            plan.transactionCheck.amount || 0.001
          );
          allChecks.push(...txResults);
          for (const r of txResults) {
            send('check', { type: 'transaction', ...r });
          }
          send('step', { step: 4, status: 'done', label: `Transaction: ${txResults.filter(c => c.status === 'pass').length}/${txResults.length}` });
        } else {
          send('step', { step: 4, status: 'done', label: 'No transaction test needed' });
        }

        // ── Step 6: Compute verdict ──
        send('step', { step: 5, status: 'active', label: 'Computing verdict...' });

        const passed = allChecks.filter(c => c.status === 'pass').length;
        const failed = allChecks.filter(c => c.status === 'fail').length;
        const warned = allChecks.filter(c => c.status === 'warn').length;
        const total = allChecks.length;

        let verdict: 'pass' | 'fail' | 'partial';
        if (failed === 0 && passed > 0) verdict = 'pass';
        else if (failed > 0 && passed === 0) verdict = 'fail';
        else if (failed > 0) verdict = 'partial';
        else verdict = 'partial'; // all skip/warn

        // ── Step 7: Post to Linear ──
        if (postComment) {
          const comment = formatRealVerificationComment(issue, allChecks, verdict, plan);
          await addComment(issue.id, comment);
          send('linear_update', { type: 'comment', ticket: identifier, message: 'Verification comment posted' });

          if (verdict === 'pass') {
            await updateIssueState(issue.id, WORKFLOW_STATES.DONE);
            send('linear_update', { type: 'status', ticket: identifier, message: `✅ ${identifier} → Done` });
          }
        }

        send('step', { step: 5, status: 'done', label: verdict === 'pass' ? `✅ ${identifier} → Done` : `${verdict.toUpperCase()}: ${passed}✅ ${failed}❌ ${warned}⚠️` });

        send('complete', {
          success: true,
          identifier: issue.identifier,
          verdict,
          checks: allChecks,
          summary: { passed, failed, warned, total },
          movedToDone: verdict === 'pass',
        });

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send('error', { message });
        await closeBrowser();
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ============ AI Verification Plan ============

const STAGING_API_BASE = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
const BROWSER_WORKER = process.env.BROWSER_WORKER_URL || 'http://127.0.0.1:3099';

// ── Cross-check: fetch API value, extract DOM value, compare ──
async function runCrossCheck(cc: CrossCheck): Promise<VerifyCheck> {
  try {
    // 1. Fetch real value from API
    const apiUrl = cc.apiEndpoint.startsWith('http') ? cc.apiEndpoint : `${STAGING_API_BASE}${cc.apiEndpoint}`;
    const apiRes = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
    if (!apiRes.ok) {
      return { name: cc.name, status: 'fail', details: `API ${cc.apiEndpoint} returned ${apiRes.status}` };
    }
    const apiData = await apiRes.json();
    const apiValue = getNestedValue(apiData, cc.apiField);
    if (apiValue === undefined || apiValue === null) {
      return { name: cc.name, status: 'warn', details: `API field "${cc.apiField}" not found in response. API returned: ${JSON.stringify(apiData).substring(0, 150)}` };
    }

    // 2. Extract displayed value from DOM via browser worker
    const domRes = await fetch(`${BROWSER_WORKER}/dom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: cc.domPath,
        checks: [{
          name: `Extract: ${cc.domSelector}`,
          selector: cc.domSelector,
          action: cc.domAction || 'text',
        }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    const domData = await domRes.json();
    const domResult = domData.results?.[0];

    if (!domResult || domResult.status === 'fail') {
      return {
        name: cc.name,
        status: 'fail',
        details: `UI element not found on ${cc.domPath} — selector: "${cc.domSelector}". ${cc.description}`,
      };
    }

    const domRaw = domResult.details || '';
    // Extract numeric value from DOM text (handles "$1,234.56 SOL", "1.23 SOL", etc.)
    const domNumMatch = domRaw.replace(/,/g, '').match(/-?\d+\.?\d*/);
    const domValue = domNumMatch ? parseFloat(domNumMatch[0]) : null;
    const apiNumeric = typeof apiValue === 'number' ? apiValue : parseFloat(String(apiValue).replace(/,/g, ''));
    const tolerance = cc.tolerance ?? 0.01;

    if (domValue === null) {
      return {
        name: cc.name,
        status: 'warn',
        details: `Could not extract numeric value from DOM. Element text: "${domRaw.substring(0, 100)}". API value: ${apiValue}`,
      };
    }

    const diff = Math.abs(domValue - apiNumeric);
    const pass = diff <= tolerance || (apiNumeric !== 0 && diff / Math.abs(apiNumeric) < 0.001);

    return {
      name: cc.name,
      status: pass ? 'pass' : 'fail',
      details: pass
        ? `✅ API value (${apiNumeric}) matches UI display (${domValue}) — within tolerance`
        : `❌ MISMATCH — API says: ${apiNumeric}, UI shows: ${domValue} (diff: ${diff.toFixed(4)}). ${cc.description}`,
    };

  } catch (err: any) {
    return { name: cc.name, status: 'fail', details: `Cross-check error: ${err.message}` };
  }
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((curr: any, key: string) => {
    if (curr == null) return undefined;
    const arrMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) return curr[arrMatch[1]]?.[parseInt(arrMatch[2])];
    return curr[key];
  }, obj);
}

interface CrossCheck {
  name: string;
  apiEndpoint: string;         // endpoint to fetch actual value from
  apiField: string;            // dot-path to extract value e.g. "balance" or "data[0].amount"
  domPath: string;             // page path to navigate to
  domSelector: string;         // CSS selector of element showing the value
  domAction?: string;          // "text" | "evaluate"
  tolerance?: number;          // numeric tolerance for float comparison (default 0.01)
  description: string;         // human-readable what we're checking
}

interface VerificationPlan {
  apiChecks: { endpoint: string; checks: any[] }[];
  domChecks: { path: string; checks: any[] }[];
  crossChecks: CrossCheck[];   // API value vs DOM displayed value
  transactionCheck?: { tokenAddress: string; amount: number };
  reasoning: string;
}

async function buildVerificationPlan(issue: LinearIssue): Promise<VerificationPlan> {
  const emptyPlan: VerificationPlan = { apiChecks: [], domChecks: [], crossChecks: [], reasoning: '' };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return buildFallbackPlan(issue);

  const systemPrompt = `You are QA Shield, a senior QA engineer verifying fixes on dev.creator.fun — a Solana meme coin trading platform.

🚨 STRICT SCOPE RULE 🚨
You must ONLY generate checks that directly verify what THIS SPECIFIC ticket says was broken or fixed.
- If the ticket is about "liquidity showing 0" → ONLY check the liquidity value
- If the ticket is about a missing UI element → ONLY check if that element exists
- If the ticket is about wrong PnL calculation → ONLY check PnL numbers
- NEVER run generic platform health checks unrelated to the ticket
- If nothing in the ticket is testable via API or DOM → return ALL empty arrays with reasoning explaining why

Platform routes: /dashboard, /chat, /leaderboard, /profile, /details/[tokenAddress], /create
API base: https://dev.bep.creator.fun

ACTUAL API endpoints (ONLY use these — no others exist):
  GET /api/token/list?limit=20  → { data: [{name, ticker, mcap:{usd,sol,baseToken}, liquidity:{value,unit}, volume:{usd,buys,sells}, holders:{all}, change1hr, change24h, ath, banner, icon, address}], total, volume1h, volume24h }
  GET /api/token/:address  → single token detail (same shape as list items)
  GET /api/token/search?q=X  → { data: [...] }
  GET /api/leaderboard/stats  → { tv:{current}, cp:{current}, uc:{current}, tc:{current}, crxPrice, platformFeeRate, rewardsPercentage, platformRevenue, dollarRewardPool, totalCrxDistributed }
  GET /api/rewards  → returns a raw float number (known bug — not JSON)

⚠️ These endpoints DO NOT EXIST: /api/holdings, /api/user, /api/chat/messages, /api/wallet/balance, /api/tokens/trending, /api/fees — DO NOT reference them.

Check types — choose based on ticket:
1. apiChecks → ticket says API returns wrong/missing data. Check specific response fields.
2. domChecks → ticket says UI element is missing, wrong position, or wrong style. Check DOM.
3. crossChecks → ticket says UI displays a WRONG VALUE. Fetch from API + extract from DOM + compare.
4. transactionCheck → ticket involves buy/sell flow. Test with 0.001 SOL.

Read the DEVELOPER COMMENTS section carefully — it tells you what was actually changed/fixed, narrowing your verification scope.

Respond ONLY with this JSON (no markdown wrapping):
{
  "reasoning": "one sentence: what specifically you are checking based on the ticket",
  "apiChecks": [{ "endpoint": "/api/...", "checks": [{ "field": "...", "exists": true }] }],
  "domChecks": [{ "path": "/page", "checks": [{ "name": "...", "selector": "...", "action": "exists|text|count|css" }] }],
  "crossChecks": [{ "name": "...", "description": "...", "apiEndpoint": "/api/...", "apiField": "path.to.field", "domPath": "/page", "domSelector": "CSS selector", "domAction": "text", "tolerance": 0.01 }],
  "transactionCheck": null
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        temperature: 0,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: `Ticket: ${issue.identifier}\nTitle: ${issue.title}\nDescription: ${issue.description || '(none)'}\nLabels: ${issue.labels?.nodes?.map((l: any) => l.name).join(', ')}\n\nDeveloper comments:\n${issue.comments?.nodes?.map((c: any) => `[${c.user?.name || 'Dev'}]: ${c.body?.substring(0, 400)}`).join('\n') || 'None'}`,
        }],
      }),
      signal: AbortSignal.timeout(25000),
    });

    const aiResp = await res.json();
    if (aiResp.error) throw new Error(aiResp.error.message);

    const raw = aiResp.content?.[0]?.text || '{}';
    const jsonStr = raw.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
    const parsed = JSON.parse(jsonStr);

    return {
      apiChecks: parsed.apiChecks || [],
      domChecks: parsed.domChecks || [],
      crossChecks: parsed.crossChecks || [],
      transactionCheck: parsed.transactionCheck || undefined,
      reasoning: parsed.reasoning || 'AI-generated verification plan',
    };
  } catch (err: any) {
    console.error('[buildVerificationPlan] AI failed, falling back to regex:', err.message);
    return buildFallbackPlan(issue);
  }
}

// ── Regex fallback (only used when AI is unavailable) ──
function buildFallbackPlan(issue: LinearIssue): VerificationPlan {
  const title = issue.title.toLowerCase();
  const desc = (issue.description || '').toLowerCase();
  const combined = `${title} ${desc}`;

  const plan: VerificationPlan = { apiChecks: [], domChecks: [], crossChecks: [], reasoning: '' };

  if (combined.includes('leaderboard')) {
    plan.apiChecks.push({ endpoint: '/api/leaderboard/stats', checks: [{ field: 'tv', exists: true }, { field: 'crxPrice', exists: true }] });
    plan.domChecks.push({ path: '/leaderboard', checks: [{ name: 'Leaderboard page loads', selector: 'main', action: 'exists' }] });
    plan.reasoning = 'Leaderboard ticket — checking leaderboard/stats API + page DOM';
  } else if (combined.includes('liquidity') || combined.includes('mcap') || combined.includes('market cap') || combined.includes('volume') || combined.includes('holders')) {
    plan.apiChecks.push({ endpoint: '/api/token/list?limit=5', checks: [{ field: 'data', type: 'array' }, { field: 'data', minLength: 1 }] });
    plan.reasoning = 'Token data ticket — checking token list API for relevant fields';
  } else if (combined.includes('balance') || combined.includes('chat') || combined.includes('pill')) {
    plan.domChecks.push({ path: '/chat', checks: [{ name: 'Chat page loads', selector: 'main', action: 'exists' }] });
    plan.reasoning = 'Chat/balance ticket — checking chat page DOM';
  } else if (combined.includes('settings') || combined.includes('404')) {
    plan.domChecks.push({ path: '/settings', checks: [{ name: 'Settings page loads (no 404)', selector: 'main', action: 'exists' }] });
    plan.reasoning = 'Settings/404 ticket — checking page renders without error';
  } else {
    // No specific scope detected — don't run irrelevant generic checks
    plan.reasoning = 'Ticket scope unclear — no automatable checks could be derived from the title/description. Manual verification required.';
  }

  return plan;
}
// ============ Format Comment ============

function formatRealVerificationComment(
  issue: { identifier: string; title: string },
  checks: VerifyCheck[],
  verdict: string,
  plan: VerificationPlan
): string {
  const verdictIcon = verdict === 'pass' ? '✅' : verdict === 'fail' ? '❌' : '⚠️';
  const verdictText = verdict === 'pass' ? 'VERIFIED — PASSED' : verdict === 'fail' ? 'VERIFIED — FAILED' : 'PARTIAL VERIFICATION';

  const passed = checks.filter(c => c.status === 'pass');
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');

  let c = `## ${verdictIcon} ${verdictText}\n\n`;
  c += `**${issue.identifier}** — ${issue.title}\n\n`;
  c += `**Strategy:** ${plan.reasoning}\n`;
  c += `**Results:** ${passed.length}✅ ${failed.length}❌ ${warned.length}⚠️ / ${checks.length} total\n\n`;

  if (passed.length > 0) {
    c += `### ✅ Passed\n`;
    passed.forEach(ch => { c += `- **${ch.name}** — ${ch.details}\n`; });
    c += '\n';
  }

  if (failed.length > 0) {
    c += `### ❌ Failed\n`;
    failed.forEach(ch => { c += `- **${ch.name}** — ${ch.details}\n`; });
    c += '\n';
  }

  if (warned.length > 0) {
    c += `### ⚠️ Warnings\n`;
    warned.forEach(ch => { c += `- **${ch.name}** — ${ch.details}\n`; });
    c += '\n';
  }

  c += `---\n_Verified by QA Shield 🛡️ via real browser + API testing at ${new Date().toISOString()}_`;
  return c;
}
