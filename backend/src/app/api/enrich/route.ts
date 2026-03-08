/**
 * POST /api/enrich
 * Enriches a Linear ticket with AI-generated QA context
 * Also posts the enrichment as a comment on the Linear ticket
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssueByIdentifier, addComment } from '@/lib/linear';
import { buildEnrichmentPrompt, formatEnrichmentAsComment, type TicketEnrichment } from '@/lib/ai';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { identifier, postComment = true } = body;

    if (!identifier) {
      return NextResponse.json({ error: 'identifier required (e.g. CRX-829)' }, { status: 400 });
    }

    // 1. Fetch ticket from Linear
    const issue = await getIssueByIdentifier(identifier);
    if (!issue) {
      return NextResponse.json({ error: `Issue ${identifier} not found` }, { status: 404 });
    }

    // 2. Build AI prompt and get enrichment
    const prompt = buildEnrichmentPrompt(issue);

    // Call OpenAI (or any LLM)
    let enrichment: TicketEnrichment;

    if (process.env.OPENAI_API_KEY) {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are QA Shield, an expert QA analyst. Respond ONLY with valid JSON.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      enrichment = JSON.parse(completion.choices[0].message.content || '{}');
    } else {
      // Fallback: generate a structured template without AI
      enrichment = generateFallbackEnrichment(issue);
    }

    // 3. Post enrichment as Linear comment
    let commentId: string | null = null;
    if (postComment) {
      const commentBody = formatEnrichmentAsComment(enrichment);
      commentId = await addComment(issue.id, commentBody);
    }

    return NextResponse.json({
      success: true,
      identifier: issue.identifier,
      enrichment,
      commentId,
      commentPosted: postComment,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Enrich error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: Quick lookup for extension
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
  const isBug = issue.labels.nodes.some(l => l.name === 'Bug');

  return {
    issueType: isUI && isBackend ? 'mixed' : isUI ? 'ui' : isBackend ? 'backend' : 'mixed',
    priorityRecommendation: {
      level: isBug ? 'high' : 'medium',
      score: isBug ? 2 : 3,
      reasoning: 'Auto-classified based on labels and title keywords',
    },
    rootCause: {
      summary: `Issue identified in: ${issue.title}`,
      causedBy: 'Requires investigation',
      category: isBug ? 'bug' : 'improvement',
    },
    scope: {
      summary: issue.description?.slice(0, 200) || issue.title,
      affectedPages: ['Requires investigation'],
      affectedComponents: ['Requires investigation'],
      affectedEndpoints: isBackend ? ['Requires investigation'] : [],
    },
    impact: {
      severity: isBug ? 'high' : 'medium',
      userFacing: isUI,
      financialImpact: /pnl|price|trade|buy|sell|fee|reward/i.test(issue.title + issue.description),
      securityImpact: /auth|cors|security|token|wallet/i.test(issue.title + issue.description),
      description: 'Impact assessment requires manual review',
    },
    testCases: [
      {
        id: 'TC-1',
        title: 'Verify the fix resolves the reported issue',
        steps: ['Navigate to the affected area', 'Reproduce the original issue steps', 'Verify the fix is applied'],
        expected: 'Issue is resolved as described in the ticket',
        priority: 'must',
      },
    ],
    edgeCases: [
      {
        id: 'EC-1',
        scenario: 'Test with different user roles and states',
        risk: 'medium',
        howToTest: 'Try as logged-out user, new user, and existing user',
      },
    ],
    impactedAreas: [],
    responsiveness: isUI ? [
      { breakpoint: 'mobile', viewport: '375x667', elementsToCheck: ['Main content area', 'Navigation', 'Buttons'] },
      { breakpoint: 'tablet', viewport: '768x1024', elementsToCheck: ['Layout grid', 'Sidebar', 'Tables'] },
      { breakpoint: 'desktop', viewport: '1920x1080', elementsToCheck: ['Full layout', 'Charts', 'Data tables'] },
    ] : [],
    securityChecks: isBackend ? [
      { endpoint: 'TBD', checkType: 'auth', description: 'Verify endpoint requires authentication', severity: 'high' },
      { endpoint: 'TBD', checkType: 'cors', description: 'Verify CORS policy is properly configured', severity: 'high' },
    ] : [],
    performanceBenchmarks: [
      { metric: 'Page load time', competitor: 'axiom.trade', status: 'untested', threshold: 'Should be under 2000ms' },
      { metric: 'API response time', competitor: 'pump.fun', status: 'untested', threshold: 'Should be under 500ms' },
    ],
  };
}
