/**
 * AI Enrichment Engine for QA Shield
 * Analyzes Linear tickets and generates comprehensive QA context
 */

import type { LinearIssue } from './linear';

// ============ Types ============

export interface TicketEnrichment {
  issueType: 'ui' | 'backend' | 'api' | 'onchain' | 'mixed';
  priorityRecommendation: {
    level: 'urgent' | 'high' | 'medium' | 'low';
    score: number; // 1-4
    reasoning: string;
  };
  rootCause: {
    summary: string;
    causedBy: string; // component/module that caused the issue
    category: string; // logic error, missing validation, race condition, etc.
  };
  scope: {
    summary: string;
    affectedPages: string[];
    affectedComponents: string[];
    affectedEndpoints: string[];
  };
  impact: {
    severity: 'critical' | 'high' | 'medium' | 'low';
    userFacing: boolean;
    financialImpact: boolean;
    securityImpact: boolean;
    description: string;
  };
  testCases: TestCase[];
  edgeCases: EdgeCase[];
  impactedAreas: ImpactedArea[];
  responsiveness: ResponsivenessCheck[];
  securityChecks: SecurityCheck[];
  performanceBenchmarks: PerformanceBenchmark[];
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

export interface ImpactedArea {
  page: string;
  component: string;
  reason: string;
  checkRequired: boolean;
}

export interface ResponsivenessCheck {
  breakpoint: string;
  viewport: string;
  elementsToCheck: string[];
}

export interface SecurityCheck {
  endpoint: string;
  checkType: 'auth' | 'cors' | 'data-exposure' | 'injection' | 'rate-limit';
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface PerformanceBenchmark {
  metric: string;
  ourValue?: number;
  competitorValue?: number;
  competitor: string;
  status: 'faster' | 'slower' | 'similar' | 'untested';
  threshold: string;
}

// ============ Platform Context ============

const PLATFORM_CONTEXT = `
You are QA Shield, an AI QA analyst for Creator.fun — a Solana-based meme coin creation & trading platform (similar to pump.fun / axiom.trade).

Platform Components:
- Web App: coin creation, trading, dashboards, charts, liquidity pools
- Wallet Extension: portfolio management, swap functionality, chat
- Chat System: DMs and coin-based chatrooms
- Backend APIs: token data, trades, analytics, wallet interactions
- Real-time Systems: WebSocket events, live market updates, price feeds

Key Financial Flows (HIGH RISK):
- Token creation & bonding curve pricing
- Buy/sell transactions with SOL
- PnL calculations, market cap, liquidity
- Fee claims and rewards distribution
- Holder tracking and leaderboard rankings

Tech Stack:
- Frontend: Next.js, React, TypeScript, TailwindCSS
- Backend: Node.js APIs
- Blockchain: Solana (devnet for staging)
- Real-time: WebSocket connections

Competitors to benchmark against:
- axiom.trade — trading interface, speed, UX
- pump.fun — coin creation flow, simplicity
`;

// ============ Enrichment Engine ============

export function buildEnrichmentPrompt(issue: LinearIssue): string {
  const labels = issue.labels.nodes.map(l => l.name).join(', ');
  const existingComments = issue.comments.nodes
    .map(c => `[${c.user.name}]: ${c.body}`)
    .join('\n');

  return `${PLATFORM_CONTEXT}

Analyze this Linear ticket and produce a comprehensive QA enrichment report.

TICKET: ${issue.identifier}
TITLE: ${issue.title}
DESCRIPTION:
${issue.description || 'No description provided'}

CURRENT LABELS: ${labels || 'None'}
CURRENT PRIORITY: ${issue.priority} (0=none, 1=urgent, 2=high, 3=medium, 4=low)
ASSIGNEE: ${issue.assignee?.name || 'Unassigned'}
STATE: ${issue.state.name}

EXISTING COMMENTS:
${existingComments || 'None'}

Respond with a JSON object matching this exact structure:
{
  "issueType": "ui|backend|api|onchain|mixed",
  "priorityRecommendation": {
    "level": "urgent|high|medium|low",
    "score": 1-4,
    "reasoning": "why this priority"
  },
  "rootCause": {
    "summary": "what's wrong",
    "causedBy": "which component/module",
    "category": "logic error|missing validation|race condition|ui inconsistency|etc"
  },
  "scope": {
    "summary": "scope description",
    "affectedPages": ["list of affected pages/routes"],
    "affectedComponents": ["list of React components likely affected"],
    "affectedEndpoints": ["list of API endpoints involved"]
  },
  "impact": {
    "severity": "critical|high|medium|low",
    "userFacing": true/false,
    "financialImpact": true/false,
    "securityImpact": true/false,
    "description": "impact description"
  },
  "testCases": [
    {
      "id": "TC-1",
      "title": "test case title",
      "steps": ["step 1", "step 2"],
      "expected": "expected result",
      "priority": "must|should|nice"
    }
  ],
  "edgeCases": [
    {
      "id": "EC-1",
      "scenario": "edge case description",
      "risk": "high|medium|low",
      "howToTest": "how to reproduce"
    }
  ],
  "impactedAreas": [
    {
      "page": "page name",
      "component": "component name",
      "reason": "why this area might be affected",
      "checkRequired": true/false
    }
  ],
  "responsiveness": [
    {
      "breakpoint": "mobile|tablet|desktop",
      "viewport": "375x667|768x1024|1920x1080",
      "elementsToCheck": ["element 1", "element 2"]
    }
  ],
  "securityChecks": [
    {
      "endpoint": "/api/xxx",
      "checkType": "auth|cors|data-exposure|injection|rate-limit",
      "description": "what to check",
      "severity": "critical|high|medium|low"
    }
  ],
  "performanceBenchmarks": [
    {
      "metric": "page load time|api response|ttfb|etc",
      "competitor": "axiom.trade|pump.fun",
      "status": "untested",
      "threshold": "should be under Xms"
    }
  ]
}

Be thorough. Think like a senior QA engineer who knows this platform inside out.
Generate at least 3-5 test cases, 2-3 edge cases, and check all relevant security concerns.
For UI changes: always include responsiveness checks for mobile (375px), tablet (768px), and desktop (1920px).
For API changes: always include auth, CORS, and rate-limit security checks.
For financial logic: flag as critical, include precision and rounding edge cases.
`;
}

// ============ Format as Linear Comment ============

export function formatEnrichmentAsComment(enrichment: TicketEnrichment): string {
  let comment = `## 🛡️ QA Shield — Ticket Enrichment\n\n`;

  // Classification
  comment += `### 📋 Classification\n`;
  comment += `- **Type:** ${enrichment.issueType.toUpperCase()}\n`;
  comment += `- **Priority:** ${enrichment.priorityRecommendation.level.toUpperCase()} (${enrichment.priorityRecommendation.reasoning})\n`;
  comment += `- **Severity:** ${enrichment.impact.severity.toUpperCase()}\n`;
  comment += `- **User-facing:** ${enrichment.impact.userFacing ? '✅ Yes' : '❌ No'}\n`;
  comment += `- **Financial impact:** ${enrichment.impact.financialImpact ? '⚠️ Yes' : '❌ No'}\n`;
  comment += `- **Security impact:** ${enrichment.impact.securityImpact ? '🔴 Yes' : '❌ No'}\n\n`;

  // Root Cause
  comment += `### 🔍 Root Cause\n`;
  comment += `- **Summary:** ${enrichment.rootCause.summary}\n`;
  comment += `- **Caused by:** ${enrichment.rootCause.causedBy}\n`;
  comment += `- **Category:** ${enrichment.rootCause.category}\n\n`;

  // Scope
  comment += `### 📐 Scope & Impact\n`;
  comment += `${enrichment.scope.summary}\n\n`;
  if (enrichment.scope.affectedPages.length > 0) {
    comment += `**Affected Pages:**\n`;
    enrichment.scope.affectedPages.forEach(p => { comment += `- ${p}\n`; });
    comment += '\n';
  }
  if (enrichment.scope.affectedEndpoints.length > 0) {
    comment += `**Affected Endpoints:**\n`;
    enrichment.scope.affectedEndpoints.forEach(e => { comment += `- \`${e}\`\n`; });
    comment += '\n';
  }

  // Test Cases
  comment += `### ✅ Test Cases\n\n`;
  enrichment.testCases.forEach(tc => {
    const badge = tc.priority === 'must' ? '🔴' : tc.priority === 'should' ? '🟡' : '🟢';
    comment += `**${badge} ${tc.id}: ${tc.title}** [${tc.priority.toUpperCase()}]\n`;
    tc.steps.forEach((s, i) => { comment += `${i + 1}. ${s}\n`; });
    comment += `**Expected:** ${tc.expected}\n\n`;
  });

  // Edge Cases
  if (enrichment.edgeCases.length > 0) {
    comment += `### ⚡ Edge Cases\n\n`;
    enrichment.edgeCases.forEach(ec => {
      comment += `- **${ec.id}** [${ec.risk.toUpperCase()} risk]: ${ec.scenario}\n  → _How to test:_ ${ec.howToTest}\n`;
    });
    comment += '\n';
  }

  // Impacted Areas
  if (enrichment.impactedAreas.length > 0) {
    comment += `### 🗺️ Impacted Areas (Regression Check)\n\n`;
    enrichment.impactedAreas.forEach(ia => {
      const icon = ia.checkRequired ? '⚠️' : 'ℹ️';
      comment += `- ${icon} **${ia.page}** → \`${ia.component}\`: ${ia.reason}\n`;
    });
    comment += '\n';
  }

  // Responsiveness
  if (enrichment.responsiveness.length > 0) {
    comment += `### 📱 Responsiveness Checklist\n\n`;
    enrichment.responsiveness.forEach(r => {
      comment += `**${r.breakpoint}** (${r.viewport}):\n`;
      r.elementsToCheck.forEach(el => { comment += `- [ ] ${el}\n`; });
      comment += '\n';
    });
  }

  // Security Checks
  if (enrichment.securityChecks.length > 0) {
    comment += `### 🔒 Security Checks\n\n`;
    enrichment.securityChecks.forEach(sc => {
      const icon = sc.severity === 'critical' ? '🔴' : sc.severity === 'high' ? '🟠' : '🟡';
      comment += `- ${icon} **[${sc.checkType.toUpperCase()}]** \`${sc.endpoint}\`: ${sc.description}\n`;
    });
    comment += '\n';
  }

  // Performance Benchmarks
  if (enrichment.performanceBenchmarks.length > 0) {
    comment += `### ⚡ Performance Benchmarks\n\n`;
    comment += `| Metric | Competitor | Threshold | Status |\n`;
    comment += `|--------|-----------|-----------|--------|\n`;
    enrichment.performanceBenchmarks.forEach(pb => {
      comment += `| ${pb.metric} | ${pb.competitor} | ${pb.threshold} | ${pb.status} |\n`;
    });
    comment += '\n';
  }

  comment += `---\n_Generated by QA Shield 🛡️ — automated ticket enrichment_`;

  return comment;
}
