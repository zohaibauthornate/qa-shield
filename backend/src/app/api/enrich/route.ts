/**
 * POST /api/enrich — SSE streaming ticket enrichment
 * Enriches a Linear ticket with AI analysis and posts it as a comment
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssueByIdentifier, addComment } from '@/lib/linear';
import { buildEnrichmentPrompt, formatEnrichmentAsComment, type TicketEnrichment } from '@/lib/ai';

export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { identifier, postComment = true } = body;

  if (!identifier) {
    return NextResponse.json({ error: 'identifier required (e.g. CRX-829)' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // ── Step 0: Fetch ticket ──
        send('step', { step: 0, status: 'active', label: 'Fetching ticket...' });
        const issue = await getIssueByIdentifier(identifier);
        if (!issue) throw new Error(`Issue ${identifier} not found`);
        send('step', { step: 0, status: 'done', label: issue.title.substring(0, 60) });

        // ── Step 1: AI analysis ──
        send('step', { step: 1, status: 'active', label: 'Analysing with AI...' });

        let enrichment: TicketEnrichment;

        if (process.env.ANTHROPIC_API_KEY) {
          const prompt = buildEnrichmentPrompt(issue);
          const res = await fetch('https://api.anthropic.com/v1/messages', {
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
              system: 'You are QA Shield, a senior QA automation engineer. Respond ONLY with valid JSON matching the exact structure requested. No markdown wrapping, no explanation — just the JSON object.',
              messages: [{ role: 'user', content: prompt }],
            }),
          });

          const aiResponse = await res.json();
          if (aiResponse.error) throw new Error(aiResponse.error.message);

          const content = aiResponse.content?.[0]?.text || '{}';
          const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
          enrichment = JSON.parse(jsonMatch[1].trim());

        } else if (process.env.OPENAI_API_KEY) {
          const prompt = buildEnrichmentPrompt(issue);
          const { default: OpenAI } = await import('openai');
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              { role: 'system', content: 'You are QA Shield, a senior QA automation engineer. Respond ONLY with valid JSON.' },
              { role: 'user', content: prompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          });
          enrichment = JSON.parse(completion.choices[0].message.content || '{}');

        } else {
          enrichment = generateFallbackEnrichment(issue);
        }

        send('step', { step: 1, status: 'done', label: `Classified as: ${enrichment.classification?.type || 'unknown'}` });

        // ── Step 2: Post comment ──
        let commentId: string | null = null;
        if (postComment) {
          send('step', { step: 2, status: 'active', label: 'Posting comment to Linear...' });
          const commentBody = formatEnrichmentAsComment(enrichment);
          commentId = await addComment(issue.id, commentBody);
          send('step', { step: 2, status: 'done', label: 'Comment posted ✅' });
        } else {
          send('step', { step: 2, status: 'done', label: 'Skipped (postComment=false)' });
        }

        // ── Step 3: Done ──
        send('step', { step: 3, status: 'done', label: 'Enrichment complete' });
        send('result', {
          success: true,
          identifier: issue.identifier,
          enrichment,
          commentId,
          commentPosted: postComment && !!commentId,
        });

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('Enrich SSE error:', message);
        send('error', { error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// GET: Quick lookup
export async function GET(req: NextRequest) {
  const identifier = req.nextUrl.searchParams.get('identifier');
  if (!identifier) {
    return NextResponse.json({ error: 'identifier query param required' }, { status: 400 });
  }

  try {
    const issue = await getIssueByIdentifier(identifier);
    return NextResponse.json({ success: true, issue });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function generateFallbackEnrichment(issue: { title: string; description: string; labels: { nodes: { name: string }[] } }): TicketEnrichment {
  const isUI = issue.labels.nodes.some(l => l.name === 'Frontend') || /ui|css|style|layout|responsive/i.test(issue.title);
  const isBackend = issue.labels.nodes.some(l => l.name === 'Backend') || /api|endpoint|server|database/i.test(issue.title);
  const isBug = issue.labels.nodes.some(l => l.name === 'Bug') || /bug|fix|broken|error|crash/i.test(issue.title);

  return {
    classification: {
      type: isBug ? 'bug' : 'improvement',
      reasoning: 'Auto-classified based on labels and title keywords (no AI available)',
    },
    whatWentWrong: {
      summary: issue.title,
      rootCause: 'Requires manual investigation',
      component: 'Unknown — needs investigation',
      category: isBug ? 'bug' : 'improvement',
    },
    impact: {
      severity: isBug ? 'high' : 'medium',
      scope: 'Requires investigation',
      affectedUsers: 'Unknown',
      affectedPages: ['Requires investigation'],
      affectedEndpoints: isBackend ? ['Requires investigation'] : [],
      financialImpact: /pnl|price|trade|buy|sell|fee|reward/i.test(issue.title + (issue.description || '')),
      securityImpact: /auth|cors|security|token|wallet/i.test(issue.title + (issue.description || '')),
    },
    stepsToReproduce: [
      '1. Navigate to the affected area on dev.creator.fun',
      '2. Follow the ticket description',
      '3. Observe the issue',
    ],
    expectedBehavior: 'As described in the ticket',
    actualBehavior: issue.title,
    recommendedFix: {
      approach: 'Requires investigation',
      filesLikelyInvolved: [],
      estimatedEffort: 'medium',
    },
    testCases: [
      {
        id: 'TC-1',
        title: 'Verify the fix resolves the reported issue',
        steps: ['Navigate to affected area', 'Reproduce original steps', 'Verify fix'],
        expected: 'Issue is resolved',
        priority: 'must',
      },
    ],
    edgeCases: [
      {
        id: 'EC-1',
        scenario: 'Test with different user states',
        risk: 'medium',
        howToTest: 'Try as logged-out, new user, and existing user',
      },
    ],
    postFixVerification: ['Verify the fix on dev.creator.fun', 'Check for regressions in related areas'],
    priorityRecommendation: {
      level: isBug ? 'high' : 'medium',
      reasoning: 'Auto-classified — needs AI for precise assessment',
    },
  };
}
