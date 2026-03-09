/**
 * POST /api/verify
 * Full verification flow — acts like a senior QA automation engineer:
 * 1. AI analyzes the fix against test cases (PASS/FAIL verdict)
 * 2. Runs security scan (separate assessment)
 * 3. Runs performance benchmark (separate assessment)
 * 4. Posts SEPARATE comments on Linear for each aspect
 * 5. Checks for duplicates before creating any new tickets
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssueByIdentifier, addComment, findSimilarIssue, createIssue, LABELS } from '@/lib/linear';
import {
  buildEnrichmentPrompt,
  buildVerificationPrompt,
  formatFixVerificationComment,
  formatSecurityComment,
  formatPerformanceComment,
  type TicketEnrichment,
  type VerificationReport,
} from '@/lib/ai';
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

    // ── Step 1: Get enrichment (test cases) ──
    let enrichment: TicketEnrichment | null = null;
    const aiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

    if (aiKey) {
      try {
        const enrichPrompt = buildEnrichmentPrompt(issue);

        if (process.env.ANTHROPIC_API_KEY) {
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
              temperature: 0.2,
              system: 'You are QA Shield, a senior QA automation engineer. Respond ONLY with valid JSON.',
              messages: [{ role: 'user', content: enrichPrompt }],
            }),
          });
          const enrichData = await enrichRes.json();
          const content = enrichData.content?.[0]?.text || '{}';
          const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
          enrichment = JSON.parse(jsonMatch[1].trim());
        } else if (process.env.OPENAI_API_KEY) {
          const { default: OpenAI } = await import('openai');
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: 'You are QA Shield, a senior QA automation engineer. Respond ONLY with valid JSON.' },
              { role: 'user', content: enrichPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          });
          enrichment = JSON.parse(completion.choices[0].message.content || '{}');
        }
      } catch (e) {
        console.error('Enrichment step failed:', e);
      }
    }

    // ── Step 2: Security scan ──
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

    // ── Step 3: Performance benchmark ──
    const ourPerf = await benchmarkEndpoint(stagingUrl);
    const axiomPerf = await benchmarkEndpoint('https://axiom.trade');
    const pumpPerf = await benchmarkEndpoint('https://pump.fun');

    // ── Step 4: AI Verification Analysis ──
    let verificationReport: VerificationReport | null = null;
    if (aiKey) {
      try {
        const verifyPrompt = buildVerificationPrompt(issue, enrichment, securityResults, {
          ours: ourPerf,
          axiom: axiomPerf,
          pump: pumpPerf,
        });

        if (process.env.ANTHROPIC_API_KEY) {
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
              temperature: 0.2,
              system: 'You are QA Shield, a senior QA verification analyst. Respond ONLY with valid JSON.',
              messages: [{ role: 'user', content: verifyPrompt }],
            }),
          });
          const verifyData = await verifyRes.json();
          const vContent = verifyData.content?.[0]?.text || '{}';
          const vJsonMatch = vContent.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, vContent];
          verificationReport = JSON.parse(vJsonMatch[1].trim());
        } else if (process.env.OPENAI_API_KEY) {
          const { default: OpenAI } = await import('openai');
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: 'You are QA Shield, a senior QA verification analyst. Respond ONLY with valid JSON.' },
              { role: 'user', content: verifyPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          });
          verificationReport = JSON.parse(completion.choices[0].message.content || '{}');
        }
      } catch (e) {
        console.error('Verification step failed:', e);
      }
    }

    // ── Step 5: Post SEPARATE comments to Linear ──
    const postedComments: string[] = [];

    if (postComment) {
      // Comment 1: Fix Verification (the main verdict)
      if (verificationReport) {
        const fixComment = formatFixVerificationComment(issue, verificationReport);
        await addComment(issue.id, fixComment);
        postedComments.push('fix_verification');
      }

      // Comment 2: Security Assessment (separate, informational)
      if (secSummary.failed > 0 || secSummary.warnings > 0) {
        const secComment = formatSecurityComment(secSummary, securityResults);
        await addComment(issue.id, secComment);
        postedComments.push('security_assessment');
      }

      // Comment 3: Performance Assessment (separate, informational)
      const perfComment = formatPerformanceComment({
        ours: ourPerf,
        axiom: axiomPerf,
        pump: pumpPerf,
      });
      await addComment(issue.id, perfComment);
      postedComments.push('performance_assessment');
    }

    // ── Step 6: Create new tickets ONLY if no duplicates exist ──
    // NOTE: We no longer auto-create security tickets from verification.
    // Only create tickets for actual NEW bugs found during fix verification.
    const createdTickets: { identifier: string; title: string; url: string }[] = [];
    const skippedDuplicates: string[] = [];

    // Only look at verification failures that are actual new bugs (not security side-findings)
    if (verificationReport?.fixVerification.failed && verificationReport.fixVerification.failed.length > 0) {
      for (const failure of verificationReport.fixVerification.failed) {
        const title = `[Bug] ${failure.test}`;

        // Check for duplicates first
        const existing = await findSimilarIssue(title);
        if (existing) {
          skippedDuplicates.push(`"${title}" — already tracked as ${existing.identifier}`);
          continue;
        }

        try {
          const created = await createIssue({
            title,
            description: `## Bug Found During Verification\n\n**Discovered during:** Verification of ${issue.identifier}\n**Failure:** ${failure.reason}\n\n---\n_Auto-created by QA Shield 🛡️_`,
            priority: 2,
            labelIds: [LABELS.BUG],
          });
          createdTickets.push(created);
        } catch (e) {
          console.error('Failed to create ticket:', e);
        }
      }
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
      skippedDuplicates,
      postedComments,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Verify error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
