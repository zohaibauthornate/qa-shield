/**
 * AI Enrichment & Verification Engine for QA Shield v0.2
 * Precision analysis — investigate, classify, scope, test, verify
 */

import type { LinearIssue } from './linear';

// ============ Types ============

export interface TicketEnrichment {
  classification: {
    type: 'bug' | 'improvement' | 'feature' | 'refactor' | 'hotfix';
    reasoning: string;
  };
  whatWentWrong: {
    summary: string;
    rootCause: string;
    component: string;
    category: string; // logic error, missing validation, race condition, UI inconsistency, etc.
  };
  impact: {
    severity: 'critical' | 'high' | 'medium' | 'low';
    scope: string;
    affectedUsers: string;
    affectedPages: string[];
    affectedEndpoints: string[];
    financialImpact: boolean;
    securityImpact: boolean;
  };
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualBehavior: string;
  recommendedFix: {
    approach: string;
    filesLikelyInvolved: string[];
    estimatedEffort: 'small' | 'medium' | 'large';
  };
  testCases: TestCase[];
  edgeCases: EdgeCase[];
  postFixVerification: string[];
  priorityRecommendation: {
    level: 'urgent' | 'high' | 'medium' | 'low';
    reasoning: string;
  };
}

export interface TestCase {
  id: string;
  title: string;
  steps: string[];
  expected: string;
  priority: 'must' | 'should' | 'nice';
}

export interface EdgeCase {
  id: string;
  scenario: string;
  risk: 'high' | 'medium' | 'low';
  howToTest: string;
}

export interface VerificationReport {
  overallVerdict: 'pass' | 'fail' | 'partial';
  verdictSummary: string;
  fixVerification: {
    status: 'pass' | 'fail' | 'partial' | 'cannot_verify';
    summary: string;
    stepsExecuted: {
      name: string;
      status: 'pass' | 'fail' | 'skip' | 'warn';
      details: string;
    }[];
    passed: string[];
    failed: { test: string; reason: string }[];
    cannotTest: { area: string; constraint: string }[];
  };
  sanityChecks: {
    status: 'pass' | 'fail' | 'partial';
    checks: { name: string; status: 'pass' | 'fail' | 'warn'; details: string }[];
  };
  regressionRisk: {
    level: 'low' | 'medium' | 'high';
    areas: string[];
    recommendation: string;
  };
  stressTestNotes: string[];
  recommendations: string[];
}

// ============ Platform Context ============

const PLATFORM_CONTEXT = `
You are QA Shield, a senior QA automation engineer analyzing tickets for Creator.fun — a Solana-based meme coin creation & trading platform (like pump.fun / axiom.trade).

Platform Components:
- Web App: coin creation, trading, dashboards, charts, liquidity pools, leaderboards
- Wallet Extension: portfolio management, swap functionality
- Chat System: DMs and coin-based chatrooms with online presence
- Backend APIs: token data, trades, analytics, wallet interactions
- Real-time Systems: WebSocket events, live market updates, price feeds

Key Financial Flows (HIGH RISK — precision matters):
- Token creation & bonding curve pricing
- Buy/sell transactions with SOL
- PnL calculations, market cap, liquidity
- Fee claims and rewards distribution
- Holder tracking and leaderboard rankings

Tech Stack: Next.js + React + TypeScript + TailwindCSS frontend, Node.js APIs, Solana devnet
Staging: https://dev.creator.fun (frontend), https://dev.bep.creator.fun (API)
`;

// ============ Enrichment Prompt ============

export function buildEnrichmentPrompt(issue: LinearIssue): string {
  const labels = issue.labels.nodes.map(l => l.name).join(', ');
  const existingComments = issue.comments.nodes
    .map(c => `[${c.user.name}]: ${c.body.substring(0, 300)}`)
    .join('\n');

  return `${PLATFORM_CONTEXT}

Analyze this Linear ticket and produce a precise, actionable QA analysis. Think like a senior QA engineer investigating an issue on the staging environment.

TICKET: ${issue.identifier}
TITLE: ${issue.title}
DESCRIPTION:
${issue.description || 'No description provided'}

LABELS: ${labels || 'None'}
PRIORITY: ${issue.priority} (0=none, 1=urgent, 2=high, 3=medium, 4=low)
ASSIGNEE: ${issue.assignee?.name || 'Unassigned'}
STATE: ${issue.state.name}

EXISTING COMMENTS:
${existingComments || 'None'}

Produce a JSON object with this EXACT structure:
{
  "classification": {
    "type": "bug|improvement|feature|refactor|hotfix",
    "reasoning": "Why this is classified as bug/improvement/etc — be specific"
  },
  "whatWentWrong": {
    "summary": "Clear 1-2 sentence explanation of the problem",
    "rootCause": "Technical root cause — what in the code/system is causing this",
    "component": "Which component/module is responsible",
    "category": "logic error|missing validation|race condition|UI inconsistency|missing feature|performance|data mismatch|etc"
  },
  "impact": {
    "severity": "critical|high|medium|low",
    "scope": "How widespread is this? (e.g. 'All users on token detail page', 'Only affects new coin creation')",
    "affectedUsers": "Who is affected (e.g. 'All users', 'Token creators only', 'Users with holdings')",
    "affectedPages": ["/page/routes"],
    "affectedEndpoints": ["/api/endpoints"],
    "financialImpact": true/false,
    "securityImpact": true/false
  },
  "stepsToReproduce": [
    "1. Navigate to https://dev.creator.fun/...",
    "2. Click on ...",
    "3. Observe that ..."
  ],
  "expectedBehavior": "What should happen",
  "actualBehavior": "What actually happens",
  "recommendedFix": {
    "approach": "How the dev should approach fixing this",
    "filesLikelyInvolved": ["src/components/...", "src/api/..."],
    "estimatedEffort": "small|medium|large"
  },
  "testCases": [
    {
      "id": "TC-1",
      "title": "Verify the primary fix",
      "steps": ["Step 1", "Step 2"],
      "expected": "Expected result with clear pass/fail criteria",
      "priority": "must|should|nice"
    }
  ],
  "edgeCases": [
    {
      "id": "EC-1",
      "scenario": "Edge case description",
      "risk": "high|medium|low",
      "howToTest": "How to reproduce this edge case"
    }
  ],
  "postFixVerification": [
    "After the fix lands, verify: ...",
    "Check regression in: ...",
    "Confirm no side effects on: ..."
  ],
  "priorityRecommendation": {
    "level": "urgent|high|medium|low",
    "reasoning": "Why this priority level"
  }
}

RULES:
- Be PRECISE. Don't give generic advice. Reference specific pages, components, endpoints from the ticket.
- Steps to reproduce should be exact — a QA engineer should be able to follow them on dev.creator.fun.
- Generate 3-5 test cases minimum, 2-3 edge cases.
- For UI bugs: reference specific CSS properties, component names, breakpoints.
- For API bugs: reference specific endpoints, request/response shapes.
- For financial logic: flag as critical, include precision and rounding edge cases.
- Classification matters: a "bug" is broken existing functionality. An "improvement" is enhancing existing functionality. A "feature" is new functionality.
`;
}

// ============ Verification Prompt ============

export function buildVerificationPrompt(
  issue: LinearIssue,
  enrichment: TicketEnrichment | null,
  securityResults: any[],
  benchmark: ApiEndpointBenchmark[]
): string {
  const testCases = enrichment?.testCases?.map(tc =>
    `${tc.id}: ${tc.title} [${tc.priority}]\nSteps: ${tc.steps.join(' → ')}\nExpected: ${tc.expected}`
  ).join('\n\n') || 'No test cases generated';

  const secFailures = securityResults
    .filter(r => r.overallStatus !== 'pass')
    .map(r => {
      const ep = r.endpoint.split('/api')[1] || r.endpoint;
      const issues = r.checks.filter((c: any) => c.status !== 'pass')
        .map((c: any) => `[${c.type}] ${c.details}`).join('; ');
      return `/api${ep}: ${issues}`;
    }).join('\n');

  return `${PLATFORM_CONTEXT}

You are verifying whether the fix for this ticket ACTUALLY resolves the reported issue. Focus ONLY on whether the fix works — NOT on unrelated security or performance findings.

TICKET: ${issue.identifier}
TITLE: ${issue.title}
DESCRIPTION:
${issue.description || 'No description'}

STATE: ${issue.state.name}
ASSIGNEE: ${issue.assignee?.name || 'Unassigned'}

EXISTING COMMENTS:
${issue.comments.nodes.map(c => `[${c.user.name}]: ${c.body.substring(0, 300)}`).join('\n') || 'None'}

TEST CASES TO VERIFY:
${testCases}

SECURITY SCAN DATA (for separate report — do NOT use this to fail the ticket):
${secFailures || 'All endpoints passed'}

PERFORMANCE DATA (for separate report — do NOT use this to fail the ticket):
${benchmark.map(b => `- ${b.name}: Our avg ${b.ourAvg}ms | ${b.competitorResults.map(c => `${c.name}: ${c.avg}ms`).join(', ') || 'No competitor data'} | ${b.verdict}`).join('\n')}

Produce a JSON object with this EXACT structure:
{
  "overallVerdict": "pass|fail|partial",
  "verdictSummary": "1-2 sentence summary of the verification result — focused on whether THE FIX works",
  "fixVerification": {
    "status": "pass|fail|partial|cannot_verify",
    "summary": "Summary of what was verified about the fix itself",
    "stepsExecuted": [
      {
        "name": "What was checked",
        "status": "pass|fail|skip|warn",
        "details": "Evidence of what was found"
      }
    ],
    "passed": ["List of things that PASSED verification"],
    "failed": [
      {
        "test": "What failed",
        "reason": "Why it failed — actual vs expected"
      }
    ],
    "cannotTest": [
      {
        "area": "What couldn't be tested",
        "constraint": "Why (e.g., needs wallet, specific account, browser interaction)"
      }
    ]
  },
  "sanityChecks": {
    "status": "pass|fail|partial",
    "checks": [
      {
        "name": "Sanity check name (e.g., 'Page loads without errors', 'No console errors')",
        "status": "pass|fail|warn",
        "details": "What was found"
      }
    ]
  },
  "regressionRisk": {
    "level": "low|medium|high",
    "areas": ["Areas that might be affected by this change"],
    "recommendation": "What to watch for"
  },
  "stressTestNotes": [
    "Stress/load testing suggestions for this specific fix (not generic)"
  ],
  "recommendations": [
    "Specific recommendations for this ticket"
  ]
}

CRITICAL RULES:
- The overallVerdict should ONLY be based on whether THE FIX works, NOT on security or performance side-findings.
- Security issues are tracked separately — never fail a ticket because of unrelated security concerns.
- Performance differences are informational — never fail a ticket because we're slower than competitors.
- Be honest: if you cannot verify the fix without browser interaction, say "cannot_verify" — don't guess.
- Include specific evidence in your analysis, not generic statements.
`;
}

// ============ Verification-Only Prompt (no security/perf) ============

export function buildVerificationOnlyPrompt(
  issue: LinearIssue,
  enrichment: TicketEnrichment | null,
): string {
  const testCases = enrichment?.testCases?.map(tc =>
    `${tc.id}: ${tc.title} [${tc.priority}]\nSteps: ${tc.steps.join(' → ')}\nExpected: ${tc.expected}`
  ).join('\n\n') || 'No test cases generated';

  return `${PLATFORM_CONTEXT}

You are verifying whether the fix for this ticket resolves the reported issue.
Focus ONLY on the ticket scope — does the fix meet the requirements described in the ticket?

TICKET: ${issue.identifier}
TITLE: ${issue.title}
DESCRIPTION:
${issue.description || 'No description'}

STATE: ${issue.state.name}
ASSIGNEE: ${issue.assignee?.name || 'Unassigned'}

EXISTING COMMENTS:
${issue.comments.nodes.map(c => `[${c.user.name}]: ${c.body.substring(0, 300)}`).join('\n') || 'None'}

TEST CASES TO VERIFY:
${testCases}

Produce a JSON object with this EXACT structure:
{
  "overallVerdict": "pass|fail|partial",
  "verdictSummary": "1-2 sentence summary — does THE FIX meet the ticket requirements?",
  "fixVerification": {
    "status": "pass|fail|partial|cannot_verify",
    "summary": "What was verified",
    "stepsExecuted": [
      { "name": "What was checked", "status": "pass|fail|skip|warn", "details": "Evidence" }
    ],
    "passed": ["Things that passed"],
    "failed": [{ "test": "What failed", "reason": "Why" }],
    "cannotTest": [{ "area": "What couldn't be tested", "constraint": "Why" }]
  },
  "sanityChecks": {
    "status": "pass|fail|partial",
    "checks": [{ "name": "Check name", "status": "pass|fail|warn", "details": "What was found" }]
  },
  "regressionRisk": {
    "level": "low|medium|high",
    "areas": ["Areas to watch"],
    "recommendation": "What to monitor"
  },
  "recommendations": ["Specific recommendations"]
}

RULES:
- Only evaluate whether the FIX addresses the TICKET requirements. Nothing else.
- Be honest: if you cannot verify without browser/wallet interaction, say "cannot_verify".
- Include specific evidence, not generic statements.
`;
}

// ============ Format: Enrichment Comment ============

export function formatEnrichmentAsComment(enrichment: TicketEnrichment): string {
  let c = `## 🛡️ QA Shield — Ticket Analysis\n\n`;

  // Classification banner
  const typeEmoji = enrichment.classification.type === 'bug' ? '🐛' : enrichment.classification.type === 'improvement' ? '✨' : enrichment.classification.type === 'feature' ? '🆕' : '🔧';
  c += `> ${typeEmoji} **${enrichment.classification.type.toUpperCase()}** — ${enrichment.classification.reasoning}\n\n`;

  // What Went Wrong
  c += `### 🔍 What Went Wrong\n\n`;
  c += `${enrichment.whatWentWrong.summary}\n\n`;
  c += `- **Root Cause:** ${enrichment.whatWentWrong.rootCause}\n`;
  c += `- **Component:** \`${enrichment.whatWentWrong.component}\`\n`;
  c += `- **Category:** ${enrichment.whatWentWrong.category}\n\n`;

  // Impact & Scope
  c += `### 📐 Impact & Scope\n\n`;
  c += `- **Severity:** ${enrichment.impact.severity.toUpperCase()}\n`;
  c += `- **Scope:** ${enrichment.impact.scope}\n`;
  c += `- **Affected Users:** ${enrichment.impact.affectedUsers}\n`;
  if (enrichment.impact.financialImpact) c += `- ⚠️ **Financial Impact:** Yes\n`;
  if (enrichment.impact.securityImpact) c += `- 🔴 **Security Impact:** Yes\n`;
  if (enrichment.impact.affectedPages.length > 0) {
    c += `- **Pages:** ${enrichment.impact.affectedPages.map(p => `\`${p}\``).join(', ')}\n`;
  }
  if (enrichment.impact.affectedEndpoints.length > 0) {
    c += `- **Endpoints:** ${enrichment.impact.affectedEndpoints.map(e => `\`${e}\``).join(', ')}\n`;
  }
  c += '\n';

  // Steps to Reproduce
  c += `### 🔄 Steps to Reproduce\n\n`;
  enrichment.stepsToReproduce.forEach((s, i) => { c += `${i + 1}. ${s}\n`; });
  c += `\n**Expected:** ${enrichment.expectedBehavior}\n`;
  c += `**Actual:** ${enrichment.actualBehavior}\n\n`;

  // Recommended Fix
  c += `### 🛠️ Recommended Fix\n\n`;
  c += `${enrichment.recommendedFix.approach}\n\n`;
  if (enrichment.recommendedFix.filesLikelyInvolved.length > 0) {
    c += `**Files likely involved:** ${enrichment.recommendedFix.filesLikelyInvolved.map(f => `\`${f}\``).join(', ')}\n`;
  }
  c += `**Estimated effort:** ${enrichment.recommendedFix.estimatedEffort}\n\n`;

  // Test Cases
  c += `### ✅ Test Cases\n\n`;
  enrichment.testCases.forEach(tc => {
    const badge = tc.priority === 'must' ? '🔴' : tc.priority === 'should' ? '🟡' : '🟢';
    c += `**${badge} ${tc.id}: ${tc.title}** [${tc.priority.toUpperCase()}]\n`;
    tc.steps.forEach((s, i) => { c += `${i + 1}. ${s}\n`; });
    c += `**Expected:** ${tc.expected}\n\n`;
  });

  // Edge Cases
  if (enrichment.edgeCases.length > 0) {
    c += `### ⚡ Edge Cases\n\n`;
    enrichment.edgeCases.forEach(ec => {
      c += `- **${ec.id}** [${ec.risk.toUpperCase()}]: ${ec.scenario}\n  → _Test:_ ${ec.howToTest}\n`;
    });
    c += '\n';
  }

  // Post-Fix Verification
  if (enrichment.postFixVerification.length > 0) {
    c += `### 🔎 Post-Fix Verification Checklist\n\n`;
    enrichment.postFixVerification.forEach(item => { c += `- [ ] ${item}\n`; });
    c += '\n';
  }

  c += `---\n_Generated by QA Shield 🛡️ — automated ticket analysis_`;
  return c;
}

// ============ Format: Fix Verification Comment ============

export function formatFixVerificationComment(
  issue: { identifier: string; title: string },
  report: VerificationReport
): string {
  const verdictIcon = report.overallVerdict === 'pass' ? '✅' : report.overallVerdict === 'fail' ? '❌' : '⚠️';
  const verdictText = report.overallVerdict === 'pass' ? 'VERIFICATION PASSED' : report.overallVerdict === 'fail' ? 'VERIFICATION FAILED' : 'PARTIAL VERIFICATION';

  let c = `## ${verdictIcon} ${verdictText}\n\n`;
  c += `**Ticket:** ${issue.identifier} — ${issue.title}\n`;
  c += `${report.verdictSummary}\n\n`;

  // Fix Verification Details
  const fv = report.fixVerification;
  c += `### 📋 Fix Verification\n\n`;

  if (fv.stepsExecuted.length > 0) {
    fv.stepsExecuted.forEach(step => {
      const icon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : step.status === 'skip' ? '⏭️' : '⚠️';
      c += `${icon} **${step.name}**\n`;
      if (step.details) c += `   ${step.details}\n`;
      c += '\n';
    });
  }

  // What Passed
  if (fv.passed.length > 0) {
    c += `**Passed:**\n`;
    fv.passed.forEach(item => { c += `- ✅ ${item}\n`; });
    c += '\n';
  }

  // What Failed
  if (fv.failed.length > 0) {
    c += `**Failed:**\n`;
    fv.failed.forEach(item => {
      c += `- ❌ **${item.test}**\n  Reason: ${item.reason}\n`;
    });
    c += '\n';
  }

  // Cannot Test
  if (fv.cannotTest.length > 0) {
    c += `**Cannot Test:**\n`;
    fv.cannotTest.forEach(item => {
      c += `- 🔒 **${item.area}**: ${item.constraint}\n`;
    });
    c += '\n';
  }

  // Sanity Checks
  const sc = report.sanityChecks;
  if (sc.checks.length > 0) {
    c += `### 🧪 Sanity Checks\n\n`;
    sc.checks.forEach(check => {
      const icon = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⚠️';
      c += `${icon} **${check.name}**: ${check.details}\n`;
    });
    c += '\n';
  }

  // Regression Risk
  c += `### 🎯 Regression Risk: ${report.regressionRisk.level.toUpperCase()}\n\n`;
  if (report.regressionRisk.areas.length > 0) {
    c += `Areas to watch: ${report.regressionRisk.areas.join(', ')}\n`;
  }
  c += `${report.regressionRisk.recommendation}\n\n`;

  // Recommendations
  if (report.recommendations.length > 0) {
    c += `### 💡 Recommendations\n\n`;
    report.recommendations.forEach(r => { c += `- ${r}\n`; });
    c += '\n';
  }

  c += `---\n_Verified by QA Shield 🛡️ at ${new Date().toISOString()}_`;
  return c;
}

// ============ Format: Security Assessment Comment ============

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_BADGE: Record<string, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '🟢 LOW',
};

export function formatSecurityComment(
  secSummary: { passed: number; warnings: number; failed: number },
  securityResults: any[]
): string {
  let c = `## 🔒 Security Assessment\n\n`;
  c += `✅ ${secSummary.passed} passed · ⚠️ ${secSummary.warnings} warnings · ❌ ${secSummary.failed} failed\n\n`;

  // Collect all non-pass findings, tag with endpoint, sort by severity
  const allFindings: { severity: string; type: string; details: string; endpoint: string; status: string }[] = [];

  for (const r of securityResults) {
    for (const ch of r.checks) {
      if (ch.status !== 'pass') {
        const ep = r.endpoint.replace(/^https?:\/\/[^/]+/, '');
        allFindings.push({ severity: ch.severity || 'low', type: ch.type, details: ch.details, endpoint: ep, status: ch.status });
      }
    }
  }

  allFindings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4));

  if (allFindings.length > 0) {
    for (const f of allFindings) {
      const badge = SEVERITY_BADGE[f.severity] || `🟢 ${f.severity.toUpperCase()}`;
      const icon = f.status === 'fail' ? '❌' : '⚠️';
      c += `${icon} **${badge}** — \`${f.endpoint}\`\n`;
      c += `  - **${f.type}:** ${f.details}\n\n`;
    }
  } else {
    c += `All scanned endpoints passed security checks.\n\n`;
  }

  c += `> ℹ️ Security findings are tracked separately and do not affect ticket verification.\n\n`;
  c += `---\n_Scanned by QA Shield 🛡️ at ${new Date().toISOString()}_`;
  return c;
}

// ============ Format: Performance Assessment Comment ============

import type { ApiEndpointBenchmark, RegressionResult, PayloadResult } from './scanner';

// Sprint 2: updated to include regression + payload data in comment
export function formatPerformanceComment(
  benchmarks: ApiEndpointBenchmark[],
  regressions?: RegressionResult[],
  payloads?: PayloadResult[]
): string {
  let c = `## ⚡ API Performance Benchmark\n\n`;
  c += `| Endpoint | Our Avg | Our P95 | Competitor | Their Avg | Delta | Verdict |\n`;
  c += `|----------|---------|---------|------------|-----------|-------|---------|\n`;

  for (const b of benchmarks) {
    const ourAvgStr = b.ourAvg >= 0 ? `${b.ourAvg}ms` : 'N/A';
    const ourP95Str = b.ourP95 >= 0 ? `${b.ourP95}ms` : 'N/A';

    const fastest = b.competitorResults
      .filter(c => c.avg >= 0)
      .sort((a, b) => a.avg - b.avg)[0];

    const compName = fastest ? fastest.name : '—';
    const compAvgStr = fastest ? `${fastest.avg}ms` : '—';
    const deltaStr = b.verdict === 'no_competitor_data' ? '—' : `${b.deltaMs >= 0 ? '+' : ''}${b.deltaMs}ms`;

    let verdictStr = '✅';
    if (b.verdict === 'slower') verdictStr = '⚠️ Slower';
    else if (b.verdict === 'faster') verdictStr = '🚀 Faster';
    else if (b.verdict === 'similar') verdictStr = '✅ Similar';
    else verdictStr = '✅ No baseline';

    c += `| ${b.name} | ${ourAvgStr} | ${ourP95Str} | ${compName} | ${compAvgStr} | ${deltaStr} | ${verdictStr} |\n`;
  }

  c += `\n_(3 samples per endpoint)_\n\n`;

  const slowerCount = benchmarks.filter(b => b.verdict === 'slower').length;
  const totalWithComp = benchmarks.filter(b => b.verdict !== 'no_competitor_data').length;

  if (slowerCount > 0) {
    c += `⚠️ **${slowerCount} of ${totalWithComp}** endpoints are slower than competitors.\n\n`;
  } else if (totalWithComp > 0) {
    c += `✅ All endpoints performing competitively.\n\n`;
  }

  // Sprint 2: Regression section
  if (regressions && regressions.some(r => r.verdict !== 'new')) {
    const regressed = regressions.filter(r => r.verdict === 'regressed');
    const improved = regressions.filter(r => r.verdict === 'improved');

    c += `### Regression vs Last Run\n\n`;
    c += `| Endpoint | Previous | Current | Change |\n`;
    c += `|----------|----------|---------|--------|\n`;
    for (const r of regressions.filter(r => r.verdict !== 'new')) {
      const icon = r.verdict === 'regressed' ? '⚠️' : r.verdict === 'improved' ? '🚀' : '✅';
      const change = `${r.deltaMs >= 0 ? '+' : ''}${r.deltaMs}ms (${r.deltaPct >= 0 ? '+' : ''}${r.deltaPct}%)`;
      c += `| ${r.endpoint} | ${r.previousAvg}ms | ${r.currentAvg}ms | ${icon} ${change} |\n`;
    }

    if (regressed.length > 0) {
      c += `\n⚠️ **${regressed.length}** endpoint(s) regressed >20% vs last run.\n`;
    }
    if (improved.length > 0) {
      c += `\n🚀 **${improved.length}** endpoint(s) improved >20% vs last run.\n`;
    }
    c += '\n';
  }

  // Sprint 2: Payload section
  if (payloads && payloads.length > 0) {
    c += `### Payload Sizes\n\n`;
    c += `| Endpoint | Size | Gzipped |\n`;
    c += `|----------|------|---------|\n`;
    for (const p of payloads) {
      const gzip = p.isGzipped ? '✅ Yes' : '❌ No';
      c += `| \`${p.endpoint}\` | ${p.sizeKb} | ${gzip} |\n`;
    }
    const unzipped = payloads.filter(p => !p.isGzipped && p.sizeBytes > 0);
    if (unzipped.length > 0) {
      c += `\n⚠️ ${unzipped.length} endpoint(s) not gzip-compressed.\n`;
    }
    c += '\n';
  }

  c += `> ℹ️ Performance data is informational and does not affect ticket verification.\n\n`;
  c += `---\n_Benchmarked by QA Shield 🛡️ at ${new Date().toISOString()}_`;
  return c;
}
