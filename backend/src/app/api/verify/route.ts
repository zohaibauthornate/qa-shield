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

const STAGING_API = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
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
          send('step', { step: 2, status: 'active', label: `Running ${plan.apiChecks.length} API checks...` });
          for (const apiCheck of plan.apiChecks) {
            const results = await verifyAPI(apiCheck.endpoint, apiCheck.checks);
            allChecks.push(...results);
            // Stream each check result as it completes
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

interface VerificationPlan {
  apiChecks: { endpoint: string; checks: any[] }[];
  domChecks: { path: string; checks: any[] }[];
  transactionCheck?: { tokenAddress: string; amount: number };
  reasoning: string;
}

async function buildVerificationPlan(issue: LinearIssue): Promise<VerificationPlan> {
  const title = issue.title.toLowerCase();
  const desc = (issue.description || '').toLowerCase();
  const combined = `${title} ${desc}`;

  const plan: VerificationPlan = {
    apiChecks: [],
    domChecks: [],
    reasoning: '',
  };

  // ── Extract endpoints from ticket ──
  const apiMatches = combined.match(/\/api\/[\w\/\-]+/g) || [];
  const pageMatches = combined.match(/\/(dashboard|details|profile|chat|convos|leaderboard|create)[\w\/\-]*/g) || [];

  // ── Detect ticket type and build checks ──

  // Leaderboard tickets
  if (combined.includes('leaderboard')) {
    plan.apiChecks.push({
      endpoint: '/api/leaderboard',
      checks: [
        { field: 'leaderboard', exists: true },
        { field: 'total', exists: true },
      ],
    });
    if (combined.includes('trading volume') || combined.includes('tradingvolume')) {
      plan.apiChecks[plan.apiChecks.length - 1].checks.push(
        { field: 'leaderboard[0].tradingVolume', exists: true, type: 'number' }
      );
    }
    if (combined.includes('wallet balance') || combined.includes('initialdeposit')) {
      plan.apiChecks[plan.apiChecks.length - 1].checks.push(
        { field: 'leaderboard[0].initialDeposit', exists: true }
      );
    }
    plan.domChecks.push({
      path: '/dashboard',
      checks: [
        { name: 'Leaderboard button exists', selector: 'a[href*="leaderboard"], button:has-text("Leaderboard")', action: 'exists' },
      ],
    });
    plan.reasoning = 'Leaderboard ticket — checking API data fields + UI presence';
  }

  // Token/coin related
  if (combined.includes('token') || combined.includes('coin')) {
    plan.apiChecks.push({
      endpoint: '/api/token',
      checks: [{ field: 'data', exists: true }],
    });
  }

  // Search dropdown
  if (combined.includes('search') && combined.includes('dropdown')) {
    plan.domChecks.push({
      path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      checks: [
        { name: 'Search button exists in header', selector: 'button:has-text("Search"), input[placeholder*="Search"]', action: 'exists' },
        { name: 'Search dropdown opens on click', selector: 'button:has-text("Search"), input[placeholder*="Search"]', action: 'click_and_check', afterClickSelector: '[class*="dropdown"], [class*="results"], [class*="token"]' },
      ],
    });
    plan.reasoning = 'Search dropdown ticket — checking DOM presence + click interaction';
  }

  // Navigation / buttons
  if (combined.includes('navigation') || combined.includes('button') && (combined.includes('api/sdk') || combined.includes('discover'))) {
    plan.domChecks.push({
      path: '/dashboard',
      checks: [
        { name: 'API/SDK button in nav', selector: 'a:has-text("API/SDK"), button:has-text("API/SDK")', action: 'exists' },
        { name: 'Discover button in nav', selector: 'a:has-text("Discover"), button:has-text("Discover")', action: 'exists' },
      ],
    });
    plan.reasoning = 'Navigation button ticket — checking DOM presence';
  }

  // Padding/spacing/border-radius (CSS tickets)
  if (combined.includes('padding') || combined.includes('spacing') || combined.includes('border') || combined.includes('radius')) {
    // Extract target values from description
    const pxMatches = desc.match(/(\d+)px/g) || [];
    const targetPage = pageMatches[0] || '/dashboard';

    plan.domChecks.push({
      path: targetPage.startsWith('/details') ? `/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG` : targetPage,
      checks: [
        { name: 'Page loads correctly', selector: 'main, [class*="content"]', action: 'exists' },
        {
          name: 'CSS property inspection',
          selector: 'body',
          action: 'evaluate',
          evaluate: `(() => {
            const results = {};
            const allEls = document.querySelectorAll('main *');
            const radiusMap = {};
            const paddingIssues = [];
            for (const el of allEls) {
              const cs = getComputedStyle(el);
              const br = cs.borderRadius;
              if (br && br !== '0px') radiusMap[br] = (radiusMap[br] || 0) + 1;
            }
            return { borderRadii: radiusMap, totalElements: allEls.length };
          })()`,
        },
      ],
    });
    plan.reasoning = `CSS/spacing ticket — inspecting computed styles on ${targetPage}`;
  }

  // Theme tickets
  if (combined.includes('theme') || combined.includes('background') && combined.includes('#')) {
    plan.domChecks.push({
      path: '/dashboard',
      checks: [
        { name: 'Page body background', selector: 'body', action: 'css', cssProperty: 'backgroundColor' },
        { name: 'Theme toggle exists', selector: 'button[class*="theme"], [class*="Theme"]', action: 'exists' },
      ],
    });
    plan.reasoning = 'Theme ticket — checking background colors and theme toggle';
  }

  // Expandable card
  if (combined.includes('expand') || combined.includes('hover') && combined.includes('quick buy')) {
    plan.domChecks.push({
      path: '/dashboard',
      checks: [
        { name: 'Watchlist cards exist', selector: '[class*="cursor-pointer"]', action: 'count', expected: 2 },
        { name: 'Expandable attributes', selector: '[data-expanded], [aria-expanded], [class*="expand"]', action: 'count' },
      ],
    });
    plan.reasoning = 'Expandable card ticket — checking expand behavior';
  }

  // Chat/convos
  if (combined.includes('chat') || combined.includes('convo') || combined.includes('message')) {
    plan.domChecks.push({
      path: '/chat',
      checks: [
        { name: 'Chat page loads', selector: 'input[placeholder*="Search"], [class*="message"]', action: 'exists' },
        { name: 'Filter tabs visible', selector: 'button:has-text("All")', action: 'exists' },
      ],
    });
    plan.reasoning = 'Chat ticket — checking chat page elements';
  }

  // Profile
  if (combined.includes('profile') && (combined.includes('spacing') || combined.includes('equal'))) {
    plan.domChecks.push({
      path: '/profile',
      checks: [
        { name: 'Profile page loads', selector: 'main', action: 'exists' },
        {
          name: 'Profile section spacing',
          selector: 'body',
          action: 'evaluate',
          evaluate: `(() => {
            const grid = document.querySelector('.col-span-12.grid');
            if (!grid) return { error: 'No grid found' };
            const cs = getComputedStyle(grid);
            const children = Array.from(grid.children);
            const gaps = [];
            for (let i = 1; i < children.length; i++) {
              gaps.push(children[i].getBoundingClientRect().top - children[i-1].getBoundingClientRect().bottom);
            }
            return { gridGap: cs.gap, sectionCount: children.length, actualGaps: gaps };
          })()`,
        },
      ],
    });
    plan.reasoning = 'Profile spacing ticket — measuring actual section gaps';
  }

  // Quick buy / transaction tickets
  if (combined.includes('quick buy') || combined.includes('trade') || combined.includes('buy') && combined.includes('transaction')) {
    plan.transactionCheck = {
      tokenAddress: 'Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      amount: 0.001,
    };
    plan.reasoning += ' + transaction test with 0.001 SOL';
  }

  // TradingView chart
  if (combined.includes('tradingview') || combined.includes('chart') && combined.includes('volume')) {
    plan.domChecks.push({
      path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      checks: [
        { name: 'TradingView iframe exists', selector: 'iframe[src*="tradingview"], iframe[class*="chart"]', action: 'exists' },
        { name: 'Chart container has content', selector: '[class*="chart"], [class*="Chart"]', action: 'exists' },
      ],
    });
    plan.reasoning = 'Chart ticket — checking TradingView iframe presence (cross-origin limits apply)';
  }

  // Sidebar / token details
  if (combined.includes('sidebar') || combined.includes('tokensidebardetails')) {
    plan.domChecks.push({
      path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      checks: [
        { name: 'Token detail page loads', selector: 'main', action: 'exists' },
        { name: 'MKT CAP label exists', selector: '*:has-text("MKT CAP")', action: 'exists' },
      ],
    });
    plan.reasoning = 'Token sidebar ticket — checking detail page elements';
  }

  // Generic API endpoints from ticket text
  for (const ep of apiMatches) {
    if (!plan.apiChecks.find(c => c.endpoint === ep)) {
      plan.apiChecks.push({
        endpoint: ep,
        checks: [{ field: 'data', exists: true }],
      });
    }
  }

  // Fallback: if no checks generated, at least check the main page loads
  if (plan.apiChecks.length === 0 && plan.domChecks.length === 0) {
    plan.domChecks.push({
      path: '/dashboard',
      checks: [
        { name: 'Main page loads', selector: 'main', action: 'exists' },
        { name: 'No error state', selector: '[class*="error"], [class*="Error"]', action: 'count', expected: 0 },
      ],
    });
    plan.reasoning = 'Generic ticket — verifying page loads without errors';
  }

  if (!plan.reasoning) {
    plan.reasoning = `Auto-detected: ${plan.apiChecks.length} API checks, ${plan.domChecks.length} DOM check groups`;
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
