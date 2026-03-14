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
import { getTicketContext, formatGitHubContextForComment, type GitHubContext } from '@/lib/github';
import { formatVerificationComment as formatVerificationCommentShared } from '@/lib/verify-runner';
import { callCodex, isCodexAvailable } from '@/lib/codex-ai';
import { buildCodexVerifyPrompt } from '@/lib/ai';

export const maxDuration = 300;

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

        // ── Step 1b: Fetch GitHub context ──
        send('step', { step: 0, status: 'active', label: 'Fetching GitHub commit context...' });
        let githubCtx: GitHubContext | null = null;
        try {
          githubCtx = await getTicketContext(identifier);
          const ghLabel = githubCtx.hasChanges
            ? `${githubCtx.commits.length} commit(s) — ${githubCtx.allFilesChanged.length} file(s) changed`
            : 'No commits on staging yet';
          send('step', { step: 0, status: 'done', label: ghLabel });
          send('github', { context: githubCtx });
        } catch (ghErr) {
          send('step', { step: 0, status: 'done', label: 'GitHub context unavailable (skipped)' });
        }

        // ── Step 2: AI generates verification plan ──
        send('step', { step: 1, status: 'active', label: 'Building verification plan...' });
        const plan = await buildVerificationPlan(issue, githubCtx ?? undefined);
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

        // ── VERDICT RULES (functional only — security/perf never affect this) ──
        // cannot_verify: checks ran but couldn't execute (auth wall, DOM inaccessible, etc.)
        // All warn/skip with 0 pass/fail = cannot verify, not a failure
        // Only REAL functional failures (API wrong value, fix not applied) = fail
        const cannotVerifyCount = allChecks.filter(c =>
          c.status === 'warn' && (
            c.details?.includes('auth') ||
            c.details?.includes('login') ||
            c.details?.includes('not found') ||
            c.details?.includes('Browser worker') ||
            c.details?.includes('Cannot navigate')
          )
        ).length;
        const functionalFails = failed; // only hard API/data failures count

        let verdict: 'pass' | 'fail' | 'partial';
        if (total === 0 || (functionalFails === 0 && passed === 0 && warned > 0)) {
          verdict = 'partial'; // cannot verify — no hard evidence either way
        } else if (functionalFails === 0 && passed > 0) {
          verdict = 'pass';   // fix confirmed working
        } else if (functionalFails > 0 && passed === 0) {
          verdict = 'fail';   // fix definitely not working
        } else {
          verdict = 'partial'; // mixed — some pass, some fail
        }

        // ── Step 7: Post to Linear ──
        if (postComment) {
          let comment = formatRealVerificationComment(issue, allChecks, verdict, plan);
          if (githubCtx) {
            comment += '\n\n' + formatGitHubContextForComment(githubCtx);
          }
          await addComment(issue.id, comment);
          send('linear_update', { type: 'comment', ticket: identifier, message: 'Verification comment posted' });

          if (verdict === 'pass') {
            await updateIssueState(issue.id, WORKFLOW_STATES.DONE);
            send('linear_update', { type: 'status', ticket: identifier, message: `✅ ${identifier} → Done` });
          } else if (verdict === 'fail') {
            // Only move to Todo on hard functional failure — not on partial/cannot_verify
            await updateIssueState(issue.id, WORKFLOW_STATES.TODO);
            send('linear_update', { type: 'status', ticket: identifier, message: `❌ ${identifier} → Todo (fix not working)` });
          }
          // partial/cannot_verify: leave ticket in current state, just post the comment
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

async function buildVerificationPlan(issue: LinearIssue, githubCtx?: GitHubContext): Promise<VerificationPlan> {
  // AI priority: OpenAI API → Codex CLI → rule-based fallback

  // Build GitHub section for the prompt
  let githubSection = '';
  if (githubCtx?.hasChanges) {
    githubSection = `\nGITHUB CHANGES (what the developer actually changed on staging):\n`;
    githubSection += `Files changed: ${githubCtx.allFilesChanged.map(f => f.filename).join(', ')}\n`;
    githubSection += `Impacted areas: ${githubCtx.impactedAreas.join(', ')}\n`;
    // Add key diffs for precision
    const filesWithPatches = githubCtx.allFilesChanged.filter(f => f.patch).slice(0, 2);
    for (const file of filesWithPatches) {
      githubSection += `\nDiff: ${file.filename}\n${file.patch!.substring(0, 600)}\n`;
    }
    githubSection += `\nUSE THESE FILE CHANGES to generate TARGETED checks. Focus verification on what actually changed.\n`;
  } else if (githubCtx) {
    githubSection = `\nGITHUB: No commits found on staging for this ticket. Fix may not be deployed.\n`;
  }

  const systemPrompt = `QA Shield — verify fixes on dev.creator.fun (Solana meme coin platform).

STRICT SCOPE RULE: ONLY generate checks that directly verify what THIS specific ticket says was broken or fixed.
If the ticket is about liquidity showing 0, ONLY check liquidity.
If it is about a missing UI element, ONLY check that element exists and displays correctly.
NEVER run generic platform health checks unrelated to the ticket.
If nothing is testable via API or DOM, return empty arrays.

Real API endpoints (ONLY these exist):
- GET /api/token/list?limit=20 → {data:[{name,ticker,mcap:{usd,sol,baseToken},liquidity:{value,unit},volume:{usd,buys,sells},holders:{all},change1hr,change24h,ath,banner,icon,address}],total,volume1h,volume24h}
- GET /api/token/:address → single token detail
- GET /api/token/search?q=X → {data:[...]}
- GET /api/leaderboard/stats → {tv:{current},crxPrice,platformFeeRate,rewardsPercentage,platformRevenue,dollarRewardPool,totalCrxDistributed}
- GET /api/rewards → raw float number (known bug — returns raw number not JSON object)

DO NOT use: /api/holdings /api/user /api/chat/messages /api/wallet/balance /api/tokens/trending — THESE DO NOT EXIST.

Pages: /dashboard /profile /chat /leaderboard /details/[address] /create

Check type selection:
- apiChecks: API returns wrong/missing data
- domChecks: UI element missing or wrong style  
- crossChecks: UI shows wrong VALUE from API (fetch API + read DOM + compare)
- transactionCheck: buy/sell flow broken

Read developer comments AND GitHub changes to narrow scope.

Respond ONLY with JSON (no markdown):
{"reasoning":"one sentence","apiChecks":[{"endpoint":"/api/...","checks":[{"field":"...","exists":true}]}],"domChecks":[{"path":"/page","checks":[{"name":"...","selector":"...","action":"exists"}]}],"crossChecks":[{"name":"...","description":"...","apiEndpoint":"/api/...","apiField":"field.path","domPath":"/page","domSelector":"selector","domAction":"text","tolerance":0.01}],"transactionCheck":null}`;

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    const userContent = `${issue.identifier}: ${issue.title}\n${(issue.description || '').substring(0, 600)}\nLabels: ${issue.labels?.nodes?.map((l: any) => l.name).join(', ')}\nDeveloper comments: ${issue.comments?.nodes?.map((c: any) => `[${c.user?.name || 'Dev'}]: ${c.body?.substring(0, 400)}`).join('\n') || 'None'}${githubSection}`;

    let parsed: any;
    const codexAvailable = await isCodexAvailable();

    // ── For verify, we need a FAST sync response to run actual checks.
    // Priority: OpenAI API (fast) → Anthropic (fast) → Codex (slow, last resort)
    if (openaiKey) {
      // ── Fallback: OpenAI API key ──
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
      parsed = JSON.parse(completion.choices[0].message.content || '{}');
    } else if (codexAvailable) {
      // ── Codex CLI last resort (slow ~90s, but no API key needed) ──
      const codexPrompt = buildCodexVerifyPrompt(issue, githubCtx ?? undefined);
      parsed = await callCodex(codexPrompt, 120_000);
    } else {
      // ── No AI available — use rule-based fallback ──
      return buildFallbackPlan(issue);
    }

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
// buildFallbackPlan now lives in verify-runner.ts (shared with bulk verify)
// Imported and re-exported here for use in this file
import { buildFallbackPlan as buildFallbackPlanShared } from '@/lib/verify-runner';
function buildFallbackPlan(issue: LinearIssue): VerificationPlan {
  return buildFallbackPlanShared(issue);
}
// formatRealVerificationComment → now using shared formatVerificationComment from verify-runner.ts
function formatRealVerificationComment(
  issue: { identifier: string; title: string },
  checks: VerifyCheck[],
  verdict: string,
  plan: VerificationPlan
): string {
  return formatVerificationCommentShared(issue, checks, verdict, plan);
}
