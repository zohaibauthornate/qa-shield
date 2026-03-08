/**
 * POST /api/verify
 * Full verification flow:
 * 1. AI analyzes the fix against test cases
 * 2. Runs security scan
 * 3. Runs performance benchmark
 * 4. Posts detailed report to Linear (steps, pass/fail, constraints, not-ready)
 * 5. Creates NEW Linear tickets for any issues found during verification
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssueByIdentifier, addComment, createIssue, WORKFLOW_STATES, LABELS } from '@/lib/linear';
import { buildEnrichmentPrompt, buildVerificationPrompt, type TicketEnrichment, type VerificationReport } from '@/lib/ai';
import { scanEndpoint, benchmarkEndpoint } from '@/lib/scanner';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { identifier, postComment = true } = body;

    if (!identifier) {
      return NextResponse.json({ error: 'identifier required' }, { status: 400 });
    }

    const issue = await getIssueByIdentifier(identifier);
    const stagingApi = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
    const stagingUrl = process.env.STAGING_URL || 'https://dev.creator.fun';

    // 1. Get enrichment (test cases) for this ticket
    let enrichment: TicketEnrichment | null = null;
    if (process.env.ANTHROPIC_API_KEY) {
      const enrichPrompt = buildEnrichmentPrompt(issue);
      const enrichRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          temperature: 0.3,
          system: 'You are QA Shield, an expert QA analyst. Respond ONLY with valid JSON.',
          messages: [{ role: 'user', content: enrichPrompt }],
        }),
      });
      const enrichData = await enrichRes.json();
      const content = enrichData.content?.[0]?.text || '{}';
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      enrichment = JSON.parse(jsonMatch[1].trim());
    }

    // 2. Run security scan
    const endpoints = ['/api/token', '/api/watchlist', '/api/user', '/api/chat', '/api/trade', '/api/holdings', '/api/leaderboard'];
    const securityResults = await Promise.all(
      endpoints.map(ep => scanEndpoint(`${stagingApi}${ep}`))
    );
    const secSummary = {
      total: securityResults.length,
      passed: securityResults.filter(r => r.overallStatus === 'pass').length,
      warnings: securityResults.filter(r => r.overallStatus === 'warn').length,
      failed: securityResults.filter(r => r.overallStatus === 'fail').length,
    };

    // 3. Run benchmark
    const ourPerf = await benchmarkEndpoint(stagingUrl);
    const axiomPerf = await benchmarkEndpoint('https://axiom.trade');
    const pumpPerf = await benchmarkEndpoint('https://pump.fun');

    // 4. AI Verification Analysis
    let verificationReport: VerificationReport | null = null;
    if (process.env.ANTHROPIC_API_KEY) {
      const verifyPrompt = buildVerificationPrompt(issue, enrichment, securityResults, {
        ours: ourPerf,
        axiom: axiomPerf,
        pump: pumpPerf,
      });

      const verifyRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          temperature: 0.3,
          system: 'You are QA Shield, an expert QA verification analyst. Respond ONLY with valid JSON.',
          messages: [{ role: 'user', content: verifyPrompt }],
        }),
      });
      const verifyData = await verifyRes.json();
      const vContent = verifyData.content?.[0]?.text || '{}';
      const vJsonMatch = vContent.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, vContent];
      verificationReport = JSON.parse(vJsonMatch[1].trim());
    }

    // 5. Create new Linear tickets for discovered issues
    const createdTickets: { identifier: string; title: string; url: string }[] = [];
    if (verificationReport?.newIssuesFound && verificationReport.newIssuesFound.length > 0) {
      for (const newIssue of verificationReport.newIssuesFound) {
        try {
          const created = await createIssue({
            title: newIssue.title,
            description: formatNewIssueDescription(newIssue, issue.identifier),
            priority: newIssue.priority === 'urgent' ? 1 : newIssue.priority === 'high' ? 2 : newIssue.priority === 'medium' ? 3 : 4,
            labelIds: newIssue.labels || [],
          });
          createdTickets.push(created);
        } catch (e) {
          console.error('Failed to create ticket:', e);
        }
      }
    }

    // 6. Post comprehensive report to Linear
    if (postComment) {
      const comment = formatVerificationComment(
        issue,
        enrichment,
        verificationReport,
        secSummary,
        securityResults,
        { ours: ourPerf, axiom: axiomPerf, pump: pumpPerf },
        createdTickets
      );
      await addComment(issue.id, comment);
    }

    return NextResponse.json({
      success: true,
      identifier: issue.identifier,
      verification: verificationReport,
      security: { summary: secSummary, results: securityResults },
      benchmark: {
        ours: ourPerf,
        competitors: [
          { name: 'axiom.trade', result: axiomPerf },
          { name: 'pump.fun', result: pumpPerf },
        ],
      },
      createdTickets,
      commentPosted: postComment,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Verify error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function formatNewIssueDescription(
  newIssue: { title: string; description: string; stepsToReproduce?: string[]; severity: string },
  parentIdentifier: string
): string {
  let desc = `## Bug\n\n`;
  desc += `${newIssue.description}\n\n`;
  desc += `**Discovered during:** Verification of ${parentIdentifier}\n`;
  desc += `**Severity:** ${newIssue.severity}\n\n`;

  if (newIssue.stepsToReproduce && newIssue.stepsToReproduce.length > 0) {
    desc += `## Steps to Reproduce\n\n`;
    newIssue.stepsToReproduce.forEach((step, i) => {
      desc += `${i + 1}. ${step}\n`;
    });
    desc += '\n';
  }

  desc += `---\n_Auto-created by QA Shield 🛡️ during verification of ${parentIdentifier}_`;
  return desc;
}

function formatVerificationComment(
  issue: { identifier: string; title: string },
  enrichment: TicketEnrichment | null,
  report: VerificationReport | null,
  secSummary: { total: number; passed: number; warnings: number; failed: number },
  securityResults: any[],
  benchmark: { ours: any; axiom: any; pump: any },
  createdTickets: { identifier: string; title: string; url: string }[]
): string {
  let c = `## 🛡️ QA Shield — Verification Report\n\n`;
  c += `**Ticket:** ${issue.identifier} — ${issue.title}\n`;
  c += `**Verified at:** ${new Date().toISOString()}\n\n`;

  if (report) {
    // Overall Verdict
    const verdictIcon = report.overallVerdict === 'pass' ? '✅' : report.overallVerdict === 'fail' ? '❌' : '⚠️';
    c += `### ${verdictIcon} Overall Verdict: ${report.overallVerdict.toUpperCase()}\n\n`;
    if (report.verdictSummary) c += `${report.verdictSummary}\n\n`;

    // Steps Executed
    if (report.stepsExecuted && report.stepsExecuted.length > 0) {
      c += `### 📋 Steps Executed\n\n`;
      for (const step of report.stepsExecuted) {
        const icon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : step.status === 'skip' ? '⏭️' : '⚠️';
        c += `${icon} **${step.name}**\n`;
        if (step.details) c += `  ${step.details}\n`;
        c += '\n';
      }
    }

    // What Passed
    if (report.passed && report.passed.length > 0) {
      c += `### ✅ Passed\n\n`;
      report.passed.forEach(item => {
        c += `- ${item}\n`;
      });
      c += '\n';
    }

    // What Failed
    if (report.failed && report.failed.length > 0) {
      c += `### ❌ Failed\n\n`;
      report.failed.forEach(item => {
        c += `- ${item.test}\n  **Reason:** ${item.reason}\n`;
      });
      c += '\n';
    }

    // Not Test Ready
    if (report.notTestReady && report.notTestReady.length > 0) {
      c += `### 🚧 Not Test Ready\n\n`;
      report.notTestReady.forEach(item => {
        c += `- **${item.area}**: ${item.reason}\n`;
      });
      c += '\n';
    }

    // Cannot Test (Constraints)
    if (report.cannotTest && report.cannotTest.length > 0) {
      c += `### 🔒 Cannot Test (Constraints)\n\n`;
      report.cannotTest.forEach(item => {
        c += `- **${item.area}**: ${item.constraint}\n`;
      });
      c += '\n';
    }
  }

  // Security Scan
  c += `### 🔒 Security Scan\n\n`;
  c += `✅ ${secSummary.passed} passed | ⚠️ ${secSummary.warnings} warnings | ❌ ${secSummary.failed} failed\n\n`;
  for (const r of securityResults) {
    const icon = r.overallStatus === 'pass' ? '✅' : r.overallStatus === 'fail' ? '❌' : '⚠️';
    const ep = r.endpoint.split('/api')[1] || r.endpoint;
    const failedChecks = r.checks.filter((ch: any) => ch.status !== 'pass');
    if (failedChecks.length > 0) {
      c += `${icon} \`/api${ep}\`\n`;
      failedChecks.forEach((ch: any) => {
        c += `  - [${ch.severity.toUpperCase()}] ${ch.details}\n`;
      });
    }
  }
  c += '\n';

  // Benchmark
  c += `### ⚡ Performance Benchmark\n\n`;
  c += `| Platform | Response Time | TTFB |\n`;
  c += `|----------|--------------|------|\n`;
  c += `| **creator.fun** | ${benchmark.ours.responseTime}ms | ${benchmark.ours.ttfb}ms |\n`;
  c += `| axiom.trade | ${benchmark.axiom.responseTime}ms | ${benchmark.axiom.ttfb}ms |\n`;
  c += `| pump.fun | ${benchmark.pump.responseTime}ms | ${benchmark.pump.ttfb}ms |\n\n`;

  // New Tickets Created
  if (createdTickets.length > 0) {
    c += `### 🆕 New Issues Created During Verification\n\n`;
    createdTickets.forEach(t => {
      c += `- [${t.identifier}](${t.url}) — ${t.title}\n`;
    });
    c += '\n';
  }

  c += `---\n_Generated by QA Shield 🛡️ — automated verification_`;
  return c;
}
