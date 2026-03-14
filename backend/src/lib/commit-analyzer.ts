/**
 * commit-analyzer.ts
 * Rule-based impact analysis for GitHub commits.
 * Maps changed files → features → targeted test cases → perf/security checks.
 * NO AI required — fully deterministic from file paths and diff content.
 */

import type { GitHubFile } from './github';

// ============ Types ============

export interface ImpactArea {
  feature: string;          // Human-readable feature name
  pages: PageCheck[];       // Browser pages to verify
  apiChecks: APICheck[];    // Endpoints to test
  perfEndpoints: string[];  // Endpoints to benchmark vs competitors
  securityEndpoints: string[]; // Endpoints to security-scan
  severity: 'critical' | 'high' | 'medium' | 'low';
  reason: string;           // Why this file triggered this area
}

export interface PageCheck {
  path: string;             // URL path e.g. "/profile"
  checks: DOMCheck[];
  description: string;
}

export interface DOMCheck {
  action: 'exists' | 'text' | 'visible' | 'hidden' | 'style' | 'count';
  selector: string;
  value?: string;
  description: string;
}

export interface APICheck {
  endpoint: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
  expectedStatus: number;
  checks: ResponseCheck[];
  description: string;
}

export interface ResponseCheck {
  field: string;
  type: 'exists' | 'notNull' | 'isArray' | 'isNumber' | 'isString' | 'isPositive' | 'equals';
  value?: unknown;
  description: string;
}

export interface CommitAnalysis {
  commitSha: string;
  commitMessage: string;
  author: string;
  repo: string;
  filesChanged: GitHubFile[];
  impactAreas: ImpactArea[];
  allPerfEndpoints: string[];
  allSecurityEndpoints: string[];
  allPages: PageCheck[];
  allApiChecks: APICheck[];
  summary: string;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
}

// ============ Impact Map — file patterns → features + checks ============

interface ImpactRule {
  patterns: RegExp[];                // File path patterns
  feature: string;
  severity: ImpactArea['severity'];
  pages: PageCheck[];
  apiChecks: APICheck[];
  perfEndpoints: string[];
  securityEndpoints: string[];
}

const STAGING_API = 'https://dev.bep.creator.fun';
const STAGING_UI = 'https://dev.creator.fun';

const IMPACT_RULES: ImpactRule[] = [
  // ── Token Detail Page ──
  {
    patterns: [
      /token[._-]?detail/i,
      /\/details\//i,
      /TokenDetail/i,
      /modules\/token\/token\.controller/i,
      /api\/token\b/i,
    ],
    feature: 'Token Detail Page',
    severity: 'high',
    pages: [{
      path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      description: 'Token detail page renders correctly',
      checks: [
        { action: 'exists', selector: '[data-testid="token-price"], .token-price, h1', description: 'Token name/price visible' },
        { action: 'visible', selector: 'canvas, .tradingview-widget-container, [class*="chart"]', description: 'Chart renders' },
        { action: 'exists', selector: '[class*="buy"], [class*="trade"], button', description: 'Buy/trade button present' },
        { action: 'exists', selector: '[class*="market-cap"], [class*="marketcap"], [class*="volume"]', description: 'Market stats visible' },
      ],
    }],
    apiChecks: [{
      endpoint: `${STAGING_API}/api/token?address=Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG`,
      method: 'GET',
      expectedStatus: 200,
      description: 'Token API returns data',
      checks: [
        { field: 'address', type: 'exists', description: 'Token address present' },
        { field: 'price', type: 'isNumber', description: 'Price is a number' },
        { field: 'marketCap', type: 'isNumber', description: 'Market cap is a number' },
      ],
    }],
    perfEndpoints: [`${STAGING_API}/api/token?address=Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG`],
    securityEndpoints: [`${STAGING_API}/api/token?address=Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG`],
  },

  // ── Token List / Discover ──
  {
    patterns: [
      /token[._-]?list/i,
      /discover/i,
      /dashboard/i,
      /modules\/token\/token\.service/i,
      /api\/tokens\b/i,
    ],
    feature: 'Token List / Discover',
    severity: 'high',
    pages: [{
      path: '/',
      description: 'Discover/home page loads',
      checks: [
        { action: 'exists', selector: '[class*="token-card"], [class*="TokenCard"], [class*="coin-card"]', description: 'Token cards render' },
        { action: 'count', selector: '[class*="token-card"], [class*="TokenCard"]', description: 'Multiple tokens shown' },
        { action: 'visible', selector: 'input[placeholder*="search" i], [class*="search"]', description: 'Search bar visible' },
      ],
    }],
    apiChecks: [{
      endpoint: `${STAGING_API}/api/tokens?limit=20`,
      method: 'GET',
      expectedStatus: 200,
      description: 'Tokens list API returns data',
      checks: [
        { field: 'tokens', type: 'isArray', description: 'Tokens array returned' },
        { field: 'tokens.0.address', type: 'exists', description: 'First token has address' },
        { field: 'tokens.0.price', type: 'isNumber', description: 'First token has price' },
      ],
    }],
    perfEndpoints: [`${STAGING_API}/api/tokens?limit=20`],
    securityEndpoints: [`${STAGING_API}/api/tokens?limit=20`],
  },

  // ── Trading / Buy / Sell ──
  {
    patterns: [
      /trade/i,
      /buy/i,
      /sell/i,
      /swap/i,
      /modules\/trade/i,
      /api\/trade\b/i,
      /api\/swap\b/i,
    ],
    feature: 'Trading Flow (Buy/Sell)',
    severity: 'critical',
    pages: [{
      path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      description: 'Buy/sell UI functional',
      checks: [
        { action: 'exists', selector: '[class*="buy"], button[data-action="buy"]', description: 'Buy button present' },
        { action: 'exists', selector: '[class*="sell"], button[data-action="sell"]', description: 'Sell button present' },
        { action: 'exists', selector: 'input[placeholder*="amount" i], input[type="number"]', description: 'Amount input present' },
      ],
    }],
    apiChecks: [{
      endpoint: `${STAGING_API}/api/trade/quote`,
      method: 'POST',
      body: { tokenAddress: 'Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG', amount: 0.001, side: 'buy' },
      expectedStatus: 200,
      description: 'Trade quote API responds',
      checks: [
        { field: 'price', type: 'isNumber', description: 'Quote price returned' },
      ],
    }],
    perfEndpoints: [`${STAGING_API}/api/trade/quote`],
    securityEndpoints: [`${STAGING_API}/api/trade/quote`],
  },

  // ── User Profile / PnL / Holdings ──
  {
    patterns: [
      /profile/i,
      /pnl/i,
      /holdings/i,
      /portfolio/i,
      /modules\/profile/i,
      /api\/profile\b/i,
      /stats\/trading/i,
    ],
    feature: 'User Profile / PnL / Holdings',
    severity: 'high',
    pages: [{
      path: '/profile',
      description: 'Profile page renders correctly',
      checks: [
        { action: 'exists', selector: '[class*="pnl"], [class*="PnL"], [class*="profit"]', description: 'PnL section visible' },
        { action: 'exists', selector: '[class*="holding"], [class*="portfolio"]', description: 'Holdings section visible' },
        { action: 'visible', selector: '[class*="wallet"], [class*="balance"]', description: 'Wallet balance visible' },
      ],
    }],
    apiChecks: [
      {
        endpoint: `${STAGING_API}/api/profile/stats/trading?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP`,
        method: 'GET',
        expectedStatus: 200,
        description: 'Trading stats API returns valid data',
        checks: [
          { field: 'totalPnl', type: 'isNumber', description: 'PnL is a number' },
          { field: 'totalVolume', type: 'isNumber', description: 'Volume is a number' },
        ],
      },
      {
        endpoint: `${STAGING_API}/api/profile/holdings?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP`,
        method: 'GET',
        expectedStatus: 200,
        description: 'Holdings API returns array',
        checks: [
          { field: 'holdings', type: 'isArray', description: 'Holdings array returned' },
        ],
      },
    ],
    perfEndpoints: [
      `${STAGING_API}/api/profile/stats/trading?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP`,
    ],
    securityEndpoints: [`${STAGING_API}/api/profile/stats/trading?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP`],
  },

  // ── Leaderboard ──
  {
    patterns: [
      /leaderboard/i,
      /modules\/leaderboard/i,
      /api\/leaderboard\b/i,
    ],
    feature: 'Leaderboard',
    severity: 'medium',
    pages: [{
      path: '/leaderboard',
      description: 'Leaderboard page renders',
      checks: [
        { action: 'exists', selector: '[class*="leaderboard"], table, [class*="rank"]', description: 'Leaderboard table visible' },
        { action: 'count', selector: 'tr, [class*="leaderboard-row"]', description: 'Multiple rows rendered' },
      ],
    }],
    apiChecks: [{
      endpoint: `${STAGING_API}/api/leaderboard?limit=10`,
      method: 'GET',
      expectedStatus: 200,
      description: 'Leaderboard API returns data',
      checks: [
        { field: 'leaders', type: 'isArray', description: 'Leaders array present' },
      ],
    }],
    perfEndpoints: [`${STAGING_API}/api/leaderboard?limit=10`],
    securityEndpoints: [`${STAGING_API}/api/leaderboard?limit=10`],
  },

  // ── Wallet / Extension ──
  {
    patterns: [
      /wallet/i,
      /extension/i,
      /modules\/wallet/i,
      /api\/wallet\b/i,
    ],
    feature: 'Wallet / Balance',
    severity: 'critical',
    pages: [{
      path: '/profile',
      description: 'Wallet tab in profile',
      checks: [
        { action: 'exists', selector: '[class*="wallet-tab"], [data-tab="wallet"]', description: 'Wallet tab present' },
        { action: 'exists', selector: '[class*="balance"], [class*="sol-balance"]', description: 'SOL balance visible' },
      ],
    }],
    apiChecks: [{
      endpoint: `${STAGING_API}/api/wallet/portfolio?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP`,
      method: 'GET',
      expectedStatus: 200,
      description: 'Wallet portfolio API responds',
      checks: [
        { field: 'solBalance', type: 'isNumber', description: 'SOL balance is a number' },
      ],
    }],
    perfEndpoints: [`${STAGING_API}/api/wallet/portfolio?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP`],
    securityEndpoints: [`${STAGING_API}/api/wallet/portfolio?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP`],
  },

  // ── Chat System ──
  {
    patterns: [
      /chat/i,
      /message/i,
      /modules\/chat/i,
      /api\/chat\b/i,
    ],
    feature: 'Chat System',
    severity: 'medium',
    pages: [{
      path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      description: 'Chat panel on token detail page',
      checks: [
        { action: 'exists', selector: '[class*="chat"], [class*="messages"]', description: 'Chat panel visible' },
        { action: 'exists', selector: 'input[placeholder*="message" i], textarea', description: 'Message input present' },
      ],
    }],
    apiChecks: [],
    perfEndpoints: [],
    securityEndpoints: [`${STAGING_API}/api/chat/messages`],
  },

  // ── Token Creation ──
  {
    patterns: [
      /create/i,
      /launch/i,
      /modules\/create/i,
      /api\/create\b/i,
      /api\/launch\b/i,
    ],
    feature: 'Token Creation / Launch',
    severity: 'high',
    pages: [{
      path: '/create',
      description: 'Token creation form renders',
      checks: [
        { action: 'exists', selector: 'input[name="name"], input[placeholder*="name" i]', description: 'Token name input present' },
        { action: 'exists', selector: 'input[name="symbol"], input[placeholder*="symbol" i]', description: 'Token symbol input present' },
        { action: 'exists', selector: 'button[type="submit"], button[class*="launch"], button[class*="create"]', description: 'Launch button present' },
      ],
    }],
    apiChecks: [],
    perfEndpoints: [],
    securityEndpoints: [`${STAGING_API}/api/create`],
  },

  // ── Auth / Middleware ──
  {
    patterns: [
      /middleware/i,
      /auth/i,
      /cors/i,
      /security/i,
      /modules\/auth/i,
    ],
    feature: 'Auth / Middleware (broad impact)',
    severity: 'critical',
    pages: [
      {
        path: '/',
        description: 'Homepage loads without auth errors',
        checks: [
          { action: 'exists', selector: 'body', description: 'Page body renders' },
          { action: 'hidden', selector: '[class*="error"], [class*="500"]', description: 'No server error shown' },
        ],
      },
      {
        path: '/profile',
        description: 'Profile page auth flow',
        checks: [
          { action: 'exists', selector: '[class*="connect"], [class*="wallet"], body', description: 'Page renders (auth or connect-wallet state)' },
        ],
      },
    ],
    apiChecks: [
      {
        endpoint: `${STAGING_API}/api/tokens?limit=5`,
        method: 'GET',
        expectedStatus: 200,
        description: 'Public API still accessible after auth changes',
        checks: [
          { field: 'tokens', type: 'isArray', description: 'Public endpoint still returns data' },
        ],
      },
    ],
    perfEndpoints: [],
    securityEndpoints: [
      `${STAGING_API}/api/tokens?limit=5`,
      `${STAGING_API}/api/token?address=Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG`,
    ],
  },

  // ── Database / Prisma / Schema ──
  {
    patterns: [
      /prisma/i,
      /schema\.prisma/i,
      /migrations/i,
      /database/i,
      /db\//i,
    ],
    feature: 'Database Layer (broad impact)',
    severity: 'critical',
    pages: [{
      path: '/',
      description: 'App loads with DB changes',
      checks: [
        { action: 'exists', selector: 'body', description: 'App renders (DB not broken)' },
        { action: 'hidden', selector: '[class*="error"], [class*="crashed"]', description: 'No crash screen' },
      ],
    }],
    apiChecks: [
      {
        endpoint: `${STAGING_API}/api/tokens?limit=5`,
        method: 'GET',
        expectedStatus: 200,
        description: 'DB reads still work after schema change',
        checks: [
          { field: 'tokens', type: 'isArray', description: 'Token query still returns data' },
        ],
      },
    ],
    perfEndpoints: [`${STAGING_API}/api/tokens?limit=5`],
    securityEndpoints: [],
  },

  // ── SDK / Scale / External Libraries ──
  {
    patterns: [
      /scale/i,
      /sdk/i,
      /scalecrx/i,
      /hooks\//i,
      /useScale/i,
      /usePlatform/i,
      /calculateRequired/i,
    ],
    feature: 'SDK / Hooks / Shared Logic',
    severity: 'high',
    pages: [
      {
        path: '/',
        description: 'Homepage loads after SDK changes',
        checks: [
          { action: 'exists', selector: 'body', description: 'App renders with new SDK' },
          { action: 'hidden', selector: '[class*="error"], [class*="crashed"], [class*="500"]', description: 'No crash screen' },
        ],
      },
      {
        path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
        description: 'Token detail still works after SDK change',
        checks: [
          { action: 'exists', selector: '[class*="price"], h1, [class*="token"]', description: 'Token page renders' },
          { action: 'hidden', selector: '[class*="error"], [class*="crashed"]', description: 'No errors' },
        ],
      },
    ],
    apiChecks: [{
      endpoint: `${STAGING_API}/api/tokens?limit=5`,
      method: 'GET',
      expectedStatus: 200,
      description: 'Token API still responds after SDK change',
      checks: [
        { field: 'tokens', type: 'isArray', description: 'Tokens still returned' },
      ],
    }],
    perfEndpoints: [],
    securityEndpoints: [],
  },

  // ── Build Config / vite / tsconfig ──
  {
    patterns: [
      /vite\.config/i,
      /tsconfig/i,
      /package\.json/i,
      /package-lock/i,
      /\.env/i,
    ],
    feature: 'Build Config / Dependencies',
    severity: 'high',
    pages: [{
      path: '/',
      description: 'App still builds and loads after config change',
      checks: [
        { action: 'exists', selector: 'body', description: 'App loads' },
        { action: 'hidden', selector: '[class*="error"], [class*="500"], [class*="build-error"]', description: 'No build errors in UI' },
      ],
    }],
    apiChecks: [],
    perfEndpoints: [],
    securityEndpoints: [],
  },

  // ── Notifications / Toasts ──
  {
    patterns: [/notification/i, /toast/i],
    feature: 'Notifications / Toasts',
    severity: 'low',
    pages: [{
      path: '/',
      description: 'No broken notification UI on load',
      checks: [
        { action: 'hidden', selector: '[class*="error-toast"], [class*="crash"]', description: 'No error toasts on load' },
      ],
    }],
    apiChecks: [],
    perfEndpoints: [],
    securityEndpoints: [],
  },

  // ── Global Styles / Tailwind ──
  {
    patterns: [
      /globals\.css/i,
      /tailwind\.config/i,
      /styles\/index/i,
    ],
    feature: 'Global Styles (visual regression risk)',
    severity: 'medium',
    pages: [
      {
        path: '/',
        description: 'Homepage visual integrity',
        checks: [
          { action: 'exists', selector: 'body', description: 'Body renders' },
          { action: 'style', selector: 'body', value: 'background', description: 'Background style applied' },
        ],
      },
      {
        path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
        description: 'Token detail page visual integrity',
        checks: [
          { action: 'exists', selector: 'main, [class*="container"], [class*="layout"]', description: 'Main layout renders' },
        ],
      },
    ],
    apiChecks: [],
    perfEndpoints: [],
    securityEndpoints: [],
  },

  // ── WebSocket / Real-time ──
  {
    patterns: [
      /websocket/i,
      /socket\.io/i,
      /ws\//i,
      /realtime/i,
      /real-time/i,
      /workers\//i,
    ],
    feature: 'WebSocket / Real-time Data',
    severity: 'high',
    pages: [{
      path: '/details/Baea4r7r1XW4FUt2k8nToGM3pQtmmidzZP8BcKnQbRHG',
      description: 'Live price updates working',
      checks: [
        { action: 'exists', selector: '[class*="price"], [class*="live"]', description: 'Price display present' },
        { action: 'hidden', selector: '[class*="ws-error"], [class*="disconnected"]', description: 'No WebSocket error shown' },
      ],
    }],
    apiChecks: [],
    perfEndpoints: [],
    securityEndpoints: [],
  },
];

// ============ Core Analyzer ============

export function analyzeCommit(
  commitSha: string,
  commitMessage: string,
  author: string,
  repo: string,
  filesChanged: GitHubFile[]
): CommitAnalysis {
  const triggeredAreas: ImpactArea[] = [];
  const seenFeatures = new Set<string>();

  for (const file of filesChanged) {
    for (const rule of IMPACT_RULES) {
      if (seenFeatures.has(rule.feature)) continue;

      const matches = rule.patterns.some(p => p.test(file.filename));
      if (matches) {
        seenFeatures.add(rule.feature);
        triggeredAreas.push({
          feature: rule.feature,
          pages: rule.pages,
          apiChecks: rule.apiChecks,
          perfEndpoints: rule.perfEndpoints,
          securityEndpoints: rule.securityEndpoints,
          severity: rule.severity,
          reason: `${file.filename} (${file.status}: +${file.additions}/-${file.deletions})`,
        });
      }
    }
  }

  // Deduplicate pages and checks
  const pageMap = new Map<string, PageCheck>();
  const apiCheckMap = new Map<string, APICheck>();
  const perfSet = new Set<string>();
  const secSet = new Set<string>();

  for (const area of triggeredAreas) {
    for (const page of area.pages) {
      if (!pageMap.has(page.path)) pageMap.set(page.path, page);
    }
    for (const check of area.apiChecks) {
      if (!apiCheckMap.has(check.endpoint)) apiCheckMap.set(check.endpoint, check);
    }
    area.perfEndpoints.forEach(e => perfSet.add(e));
    area.securityEndpoints.forEach(e => secSet.add(e));
  }

  const riskLevel = triggeredAreas.some(a => a.severity === 'critical') ? 'critical'
    : triggeredAreas.some(a => a.severity === 'high') ? 'high'
    : triggeredAreas.some(a => a.severity === 'medium') ? 'medium' : 'low';

  const summary = buildAnalysisSummary(commitSha, commitMessage, filesChanged, triggeredAreas);

  return {
    commitSha,
    commitMessage,
    author,
    repo,
    filesChanged,
    impactAreas: triggeredAreas,
    allPerfEndpoints: Array.from(perfSet),
    allSecurityEndpoints: Array.from(secSet),
    allPages: Array.from(pageMap.values()),
    allApiChecks: Array.from(apiCheckMap.values()),
    summary,
    riskLevel,
  };
}

function buildAnalysisSummary(
  sha: string,
  message: string,
  files: GitHubFile[],
  areas: ImpactArea[]
): string {
  if (areas.length === 0) {
    return `Commit \`${sha.slice(0, 7)}\` — no mapped impact areas found for ${files.length} changed file(s). Manual review recommended.`;
  }
  const criticalFeatures = areas.filter(a => a.severity === 'critical').map(a => a.feature);
  const allFeatures = areas.map(a => a.feature).join(', ');
  const criticalNote = criticalFeatures.length > 0 ? ` ⚠️ Critical: ${criticalFeatures.join(', ')}` : '';
  return `Commit \`${sha.slice(0, 7)}\` — "${message.slice(0, 60)}" | ${files.length} files → ${areas.length} impact area(s): ${allFeatures}${criticalNote}`;
}

// ============ Report Formatter ============

export function formatCommitAnalysisComment(
  analysis: CommitAnalysis,
  apiResults: Array<{ endpoint: string; status: number; ok: boolean; issues: string[] }>,
  domResults: Array<{ path: string; passed: number; failed: number; checks: Array<{ description: string; passed: boolean; error?: string }> }>,
  perfResults: Array<{ endpoint: string; ourMs: number; fastestCompMs?: number; deltaPct?: number }>,
  secResults: Array<{ endpoint: string; issues: string[] }>
): string {
  const short = analysis.commitSha.slice(0, 7);
  const repoName = analysis.repo.split('/')[1];
  const commitUrl = `https://github.com/${analysis.repo}/commit/${analysis.commitSha}`;

  const riskEmoji = { critical: '🚨', high: '⚠️', medium: '📊', low: '✅' }[analysis.riskLevel];

  // Overall verdict
  const totalFailed = domResults.reduce((s, r) => s + r.failed, 0);
  const totalPassed = domResults.reduce((s, r) => s + r.passed, 0);
  const apiFailed = apiResults.filter(r => !r.ok).length;
  const overallPass = totalFailed === 0 && apiFailed === 0;
  const verdictEmoji = overallPass ? '✅' : '❌';

  let out = `## ${verdictEmoji} Commit Auto-Analysis — \`${short}\`

> **${analysis.commitMessage.slice(0, 80)}**
> Author: ${analysis.author} | Repo: [\`${repoName}\`](${commitUrl}) | Risk: ${riskEmoji} ${analysis.riskLevel.toUpperCase()}

---

### 📁 Changed Files (${analysis.filesChanged.length})
${analysis.filesChanged.map(f => `- \`${f.filename}\` — ${f.status} (+${f.additions}/-${f.deletions})`).join('\n')}

### 🎯 Impact Areas (${analysis.impactAreas.length})
${analysis.impactAreas.map(a => `- **${a.feature}** \`${a.severity}\` — triggered by: ${a.reason}`).join('\n')}

---
`;

  // DOM results
  if (domResults.length > 0) {
    out += `### 🖥️ UI Checks (Browser)\n`;
    for (const r of domResults) {
      const pageEmoji = r.failed === 0 ? '✅' : '❌';
      out += `**${pageEmoji} \`${r.path}\`** — ${r.passed} passed, ${r.failed} failed\n`;
      const failures = r.checks.filter(c => !c.passed);
      for (const f of failures) {
        out += `  - ❌ ${f.description}${f.error ? `: ${f.error}` : ''}\n`;
      }
    }
    out += '\n';
  }

  // API results
  if (apiResults.length > 0) {
    out += `### 🔌 API Checks\n`;
    for (const r of apiResults) {
      const ep = r.endpoint.replace('https://dev.bep.creator.fun', '');
      const emoji = r.ok ? '✅' : '❌';
      out += `- ${emoji} \`${ep}\` — HTTP ${r.status}`;
      if (r.issues.length > 0) out += ` — ${r.issues.join(', ')}`;
      out += '\n';
    }
    out += '\n';
  }

  // Performance results
  if (perfResults.length > 0) {
    out += `### ⚡ Performance Spot-Check\n`;
    out += `| Endpoint | Our Latency | Fastest Competitor | Delta |\n|----------|-------------|-------------------|-------|\n`;
    for (const r of perfResults) {
      const ep = r.endpoint.replace('https://dev.bep.creator.fun', '');
      const delta = r.deltaPct !== undefined ? `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%` : 'N/A';
      const fastComp = r.fastestCompMs !== undefined ? `${r.fastestCompMs}ms` : 'N/A';
      const perfEmoji = r.deltaPct !== undefined && r.deltaPct > 200 ? '🔴' : r.deltaPct !== undefined && r.deltaPct > 50 ? '🟡' : '🟢';
      out += `| \`${ep}\` | ${r.ourMs}ms | ${fastComp} | ${perfEmoji} ${delta} |\n`;
    }
    out += '\n';
  }

  // Security results
  if (secResults.length > 0) {
    const issues = secResults.flatMap(r => r.issues);
    const secEmoji = issues.length === 0 ? '✅' : '⚠️';
    out += `### 🔒 Security Spot-Check\n${secEmoji} ${issues.length === 0 ? 'No new issues detected' : `${issues.length} issue(s) found`}\n`;
    for (const issue of issues) out += `- ⚠️ ${issue}\n`;
    out += '\n';
  }

  out += `---\n*QA Shield commit analysis 🛡️ | [View commit](${commitUrl})*`;
  return out;
}
