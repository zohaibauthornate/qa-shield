/**
 * regression-runner.ts
 * Daily regression checks for dev.creator.fun staging.
 * Runs API + DOM checks across all major feature areas.
 * Posts Slack report to #C0AKXN13UB0 and auto-files Linear tickets.
 */

import { createIssue, findSimilarIssue, WORKFLOW_STATES, LABELS } from './linear';
import { verifyAPI, verifyDOM } from './verifier';

const STAGING_API = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
const STAGING_URL = process.env.STAGING_URL || 'https://dev.creator.fun';
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.REGRESSION_SLACK_CHANNEL || 'C0AKXN13UB0';
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || 'e3694bc3-ea88-4efc-9fbc-0ddc27e42e41';

// ============ Types ============

export interface RegressionArea {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  checks: { name: string; status: string; details: string }[];
  ticketFiled?: string | null;
}

export interface RegressionReport {
  runAt: string;
  areas: RegressionArea[];
  summary: { passed: number; failed: number; warned: number; ticketsFiled: number };
  slackPosted: boolean;
}

// ============ Live token resolver ============

async function getLiveToken(): Promise<string> {
  try {
    const res = await fetch(`${STAGING_API}/api/token/list?limit=1`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const d = await res.json();
      const addr = d?.data?.[0]?.address;
      if (addr) return addr;
    }
  } catch { /* fallback */ }
  return '3XPMWxzpUuUZkMH9cGTw8bLFZsZnzdBoLfteVgu8WgQj';
}

// ============ Regression check areas ============

async function checkTokenList(): Promise<RegressionArea> {
  const checks = await verifyAPI(`${STAGING_API}/api/token/list?limit=10`, [
    { field: 'data', type: 'array' },
    { field: 'data', minLength: 1 },
    { field: 'total', exists: true },
    { field: 'data.0.address', exists: true },
    { field: 'data.0.name', exists: true },
  ]);
  return buildArea('Token List / Discovery API', checks);
}

async function checkTokenDetails(tokenAddr: string): Promise<RegressionArea> {
  const apiChecks = await verifyAPI(`${STAGING_API}/api/token?address=${tokenAddr}`, [
    { field: 'address', exists: true },
    { field: 'name', exists: true },
  ]);

  const domChecks = await verifyDOM(`/details/${tokenAddr}`, [
    { name: 'Token detail page loads', selector: 'body', action: 'exists' },
    { name: 'Chart renders', selector: 'canvas, [class*="chart"], .tradingview-widget-container', action: 'exists' },
    { name: 'Trade/buy panel visible', selector: '[class*="trade"], [class*="buy"], [class*="swap"]', action: 'exists' },
    { name: 'Token name in header', selector: 'h1, [class*="token-name"], [class*="title"]', action: 'exists' },
  ]);

  return buildArea('Token Details Page', [...apiChecks, ...domChecks.checks]);
}

async function checkDiscoveryPage(): Promise<RegressionArea> {
  const domChecks = await verifyDOM('/', [
    { name: 'Homepage loads', selector: 'body', action: 'exists' },
    { name: 'Navigation present', selector: 'nav, header, [class*="navbar"]', action: 'exists' },
    { name: 'Token cards render', selector: '[class*="token"], [class*="coin"], [class*="card"]', action: 'exists' },
  ]);
  return buildArea('Discovery / Homepage', domChecks.checks);
}

async function checkProfilePage(): Promise<RegressionArea> {
  const domChecks = await verifyDOM('/profile', [
    { name: 'Profile page loads', selector: 'body', action: 'exists' },
    { name: 'Profile card renders', selector: 'h1, [class*="profile"], [class*="username"]', action: 'exists' },
    { name: 'Rank/badge visible', selector: 'img[src*="leaderboard"], img[src*="Unranked"], img[src*="Bronze"]', action: 'exists' },
    { name: 'Wallet balance section', selector: '[class*="balance"], [class*="wallet"]', action: 'exists' },
  ]);
  return buildArea('Profile Page', domChecks.checks);
}

async function checkLeaderboard(): Promise<RegressionArea> {
  const apiChecks = await verifyAPI(`${STAGING_API}/api/leaderboard?limit=5`, [
    { field: 'data', exists: true },
  ]);
  const domChecks = await verifyDOM('/leaderboard', [
    { name: 'Leaderboard page loads', selector: 'body', action: 'exists' },
    { name: 'Rankings table/list visible', selector: 'table, [class*="rank"], [class*="leaderboard"]', action: 'exists' },
  ]);
  return buildArea('Leaderboard', [...apiChecks, ...domChecks.checks]);
}

async function checkTradeHistory(tokenAddr: string): Promise<RegressionArea> {
  const checks = await verifyAPI(`${STAGING_API}/api/trade/history?tokenAddress=${tokenAddr}&limit=5`, [
    { field: 'data', exists: true },
  ]);
  return buildArea('Trade History API', checks);
}

async function checkHolders(tokenAddr: string): Promise<RegressionArea> {
  const checks = await verifyAPI(`${STAGING_API}/api/holders/${tokenAddr}`, [
    { field: 'data', exists: true },
  ]);
  return buildArea('Holders API', checks);
}

async function checkSearch(): Promise<RegressionArea> {
  const checks = await verifyAPI(`${STAGING_API}/api/token/search?q=CRX`, [
    { field: 'data', type: 'array' },
  ]);
  return buildArea('Token Search API', checks);
}

async function checkRewards(): Promise<RegressionArea> {
  const checks = await verifyAPI(`${STAGING_API}/api/rewards`, [
    { field: 'data', exists: true },
  ]);
  return buildArea('Rewards API', checks);
}

async function checkWebSocket(): Promise<RegressionArea> {
  const checks: { name: string; status: string; details: string }[] = [];
  try {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket('wss://dev.bert.creator.fun:8081/');
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
      ws.on('open', () => { clearTimeout(t); resolve(); });
      ws.on('error', (e: Error) => { clearTimeout(t); reject(e); });
    });
    checks.push({ name: 'WebSocket connects', status: 'pass', details: 'Connected to wss://dev.bert.creator.fun:8081/' });

    // Subscribe to orders topic and wait for message
    ws.send(JSON.stringify({ action: 'subscribe', data: 'orders.all' }));
    const gotMsg = await new Promise<boolean>(resolve => {
      const t = setTimeout(() => resolve(false), 5000);
      ws.on('message', () => { clearTimeout(t); resolve(true); });
    });
    checks.push({
      name: 'WebSocket delivers messages',
      status: gotMsg ? 'pass' : 'warn',
      details: gotMsg ? 'Messages received on orders.all' : 'No messages in 5s — may be quiet market',
    });
    ws.close();
  } catch (e: any) {
    checks.push({ name: 'WebSocket connects', status: 'fail', details: e.message });
  }
  return buildArea('WebSocket Real-Time Feed', checks);
}

// ============ Area builder helper ============

function buildArea(name: string, checks: { name: string; status: string; details: string }[]): RegressionArea {
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  return {
    name,
    status: hasFail ? 'fail' : hasWarn ? 'warn' : 'pass',
    checks,
  };
}

// ============ Linear ticket filer ============

async function maybeFileTicket(area: RegressionArea): Promise<string | null> {
  if (area.status === 'pass') return null;

  const failedChecks = area.checks.filter(c => c.status === 'fail');
  if (failedChecks.length === 0) return null;

  // Check for existing ticket
  const existing = await findSimilarIssue(`regression ${area.name}`).catch(() => null);
  if (existing) {
    console.log(`[Regression] Existing ticket for "${area.name}": ${existing.identifier}`);
    return null; // already filed
  }

  const severity = area.status === 'fail' ? 'HIGH' : 'MEDIUM';
  const title = `[BUG][${severity}][REGRESSION] ${area.name} failing on staging`;
  const description = `## Regression Detected — ${area.name}

**Detected by:** QA Shield Daily Regression  
**Environment:** dev.creator.fun (staging)  
**Date:** ${new Date().toISOString().slice(0, 10)}

### Failed Checks
${failedChecks.map(c => `- **${c.name}**: ${c.details}`).join('\n')}

### All Checks
${area.checks.map(c => {
    const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
    return `${icon} ${c.name}: ${c.details}`;
  }).join('\n')}

### Steps to Reproduce
1. Navigate to staging: https://dev.creator.fun
2. Check the ${area.name} feature area
3. Observe the failures listed above

*Auto-filed by QA Shield 🛡️ daily regression*`;

  try {
    const issue = await createIssue({
      title,
      description,
      priority: area.status === 'fail' ? 2 : 3,
      labelIds: [LABELS.BUG],
      stateId: WORKFLOW_STATES.TODO,
    });
    console.log(`[Regression] Filed: ${issue.identifier} — ${title}`);
    return issue.identifier;
  } catch (e: any) {
    console.error(`[Regression] Failed to file ticket: ${e.message}`);
    return null;
  }
}

// ============ Slack reporter ============

async function postSlackReport(report: RegressionReport): Promise<boolean> {
  if (!SLACK_TOKEN) {
    console.warn('[Regression] No SLACK_BOT_TOKEN — skipping Slack post');
    return false;
  }

  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Karachi' });
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' });

  const areaLines = report.areas.map(a => {
    const icon = a.status === 'pass' ? '✅' : a.status === 'warn' ? '⚠️' : '❌';
    const failCount = a.checks.filter(c => c.status === 'fail').length;
    const detail = a.status === 'fail'
      ? ` — ${failCount} check(s) failing`
      : a.status === 'warn' ? ' — degraded' : '';
    const ticket = a.ticketFiled ? ` → <https://linear.app/creatorfun/issue/${a.ticketFiled}|${a.ticketFiled}>` : '';
    return `${icon} *${a.name}*${detail}${ticket}`;
  }).join('\n');

  const newTicketsLine = report.summary.ticketsFiled > 0
    ? `\n📋 *${report.summary.ticketsFiled} new ticket(s) filed*`
    : '\n📋 No new tickets — all issues already tracked';

  const text = `🛡️ *Daily Staging Regression — ${date}* (${time} PKT)
━━━━━━━━━━━━━━━━━━━━━
${areaLines}
━━━━━━━━━━━━━━━━━━━━━
✅ ${report.summary.passed} passing  ❌ ${report.summary.failed} failing  ⚠️ ${report.summary.warned} degraded${newTicketsLine}`;

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text, unfurl_links: false }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await res.json() as any;
    if (d.ok) {
      console.log(`[Regression] Slack report posted to ${SLACK_CHANNEL}`);
      return true;
    }
    console.error('[Regression] Slack error:', d.error);
    return false;
  } catch (e: any) {
    console.error('[Regression] Slack post failed:', e.message);
    return false;
  }
}

// ============ Main runner ============

export async function runDailyRegression(): Promise<RegressionReport> {
  console.log('[Regression] Starting daily regression scan...');
  const runAt = new Date().toISOString();

  // Get a live token address first
  const tokenAddr = await getLiveToken();
  console.log(`[Regression] Using token: ${tokenAddr}`);

  // Run all area checks in parallel (except DOM checks which share browser)
  const [
    tokenListArea,
    searchArea,
    rewardsArea,
    tradeHistoryArea,
    holdersArea,
    wsArea,
  ] = await Promise.all([
    checkTokenList(),
    checkSearch(),
    checkRewards(),
    checkTradeHistory(tokenAddr),
    checkHolders(tokenAddr),
    checkWebSocket(),
  ]);

  // DOM checks sequential (browser worker handles one page at a time cleanly)
  const discoveryArea = await checkDiscoveryPage();
  const tokenDetailsArea = await checkTokenDetails(tokenAddr);
  const profileArea = await checkProfilePage();
  const leaderboardArea = await checkLeaderboard();

  const areas: RegressionArea[] = [
    discoveryArea,
    tokenListArea,
    tokenDetailsArea,
    profileArea,
    leaderboardArea,
    searchArea,
    tradeHistoryArea,
    holdersArea,
    rewardsArea,
    wsArea,
  ];

  // File Linear tickets for failures (sequential to avoid rate limits)
  for (const area of areas) {
    if (area.status !== 'pass') {
      area.ticketFiled = await maybeFileTicket(area);
    }
  }

  const summary = {
    passed: areas.filter(a => a.status === 'pass').length,
    failed: areas.filter(a => a.status === 'fail').length,
    warned: areas.filter(a => a.status === 'warn').length,
    ticketsFiled: areas.filter(a => a.ticketFiled).length,
  };

  console.log(`[Regression] Complete — ✅${summary.passed} ❌${summary.failed} ⚠️${summary.warned} 📋${summary.ticketsFiled} tickets`);

  const report: RegressionReport = { runAt, areas, summary, slackPosted: false };
  report.slackPosted = await postSlackReport(report);

  return report;
}
