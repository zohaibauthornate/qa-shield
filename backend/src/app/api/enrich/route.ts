/**
 * POST /api/enrich — SSE streaming ticket enrichment
 * Enriches a Linear ticket with AI analysis and posts it as a comment
 */

import { NextRequest, NextResponse } from 'next/server';
import { getIssueByIdentifier, addComment } from '@/lib/linear';
import { buildEnrichmentPrompt, buildCodexEnrichmentPrompt, formatEnrichmentAsComment, type TicketEnrichment } from '@/lib/ai';
import { getTicketContext, formatGitHubContextForComment } from '@/lib/github';
import { callCodex, isCodexAvailable } from '@/lib/codex-ai';
import { spawnCodexEnrich, getJobByIdentifier } from '@/lib/codex-background';

export const maxDuration = 300;

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

        // ── Step 0b: Fetch GitHub context ──
        send('step', { step: 0, status: 'active', label: 'Fetching GitHub commit context...' });
        let githubCtx;
        try {
          githubCtx = await getTicketContext(identifier);
          const ghLabel = githubCtx.hasChanges
            ? `${githubCtx.commits.length} commit(s) found in [${githubCtx.repos.map(r => r.split('/')[1]).join(', ')}]`
            : 'No commits on staging yet';
          send('step', { step: 0, status: 'done', label: ghLabel });
          // Send trimmed summary only — full context is large and causes stream flush issues
          send('github', { context: { hasChanges: githubCtx?.hasChanges, commitCount: githubCtx?.commits?.length ?? 0, repos: githubCtx?.repos ?? [] } });
        } catch (ghErr) {
          githubCtx = null;
          send('step', { step: 0, status: 'done', label: 'GitHub context unavailable (skipped)' });
        }

        // ── Step 1: AI analysis ──
        send('step', { step: 1, status: 'active', label: 'Analysing with AI...' });

        let enrichment: TicketEnrichment;

        const openaiKeyValid = !!process.env.OPENAI_API_KEY;
        const codexAvailable = await isCodexAvailable();

        // ── Primary: Codex CLI async (ChatGPT Plus — no API credits needed) ──
        if (codexAvailable) {
          const existingJob = getJobByIdentifier(identifier);
          if (existingJob?.status === 'running' || existingJob?.status === 'queued') {
            send('step', { step: 1, status: 'done', label: `Codex already running for ${identifier} (job ${existingJob.jobId})` });
          } else {
            const jobId = spawnCodexEnrich(
              identifier,
              JSON.stringify(issue),
              JSON.stringify(githubCtx || null),
              postComment,
            );
            send('step', { step: 1, status: 'done', label: `🚀 Codex analysis queued (job ${jobId}) — will post to Linear in ~2-3 min` });
          }
          send('step', { step: 2, status: 'done', label: postComment ? 'Comment will be posted by Codex when ready' : 'Skipped (postComment=false)' });
          send('step', { step: 3, status: 'done', label: 'Returned immediately — Codex running in background' });
          send('done', { success: true, identifier, queued: true, message: 'Codex is analyzing in background. Linear comment will appear in ~2-3 minutes.' });
          // Give stream time to flush before closing
          await new Promise(r => setTimeout(r, 200));
          controller.close();
          return;
        }

        // ── Try Chief QA AI proxy (Option B — no API key needed) ──
        const QA_BASE = `http://localhost:${process.env.PORT || 3000}`;

        if (!openaiKeyValid) {
          try {
            send('step', { step: 1, status: 'active', label: 'Routing to Chief QA AI proxy...' });
            const qRes = await fetch(`${QA_BASE}/api/ai/queue`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'enrich',
                payload: {
                  identifier: issue.identifier,
                  title: issue.title,
                  description: (issue.description || '').slice(0, 1500),
                  state: (issue as any).state?.name || '',
                  priority: (issue as any).priority || 0,
                  labels: ((issue as any).labels?.nodes || []).map((l: any) => l.name),
                  githubContext: githubCtx ? {
                    hasChanges: githubCtx.hasChanges,
                    commitCount: githubCtx.commits?.length || 0,
                    repos: githubCtx.repos,
                    files: githubCtx.allFilesChanged?.slice(0, 10).map((f: any) => f.filename) || [],
                  } : null,
                },
              }),
              signal: AbortSignal.timeout(5000),
            });

            if (qRes.ok) {
              const { taskId } = await qRes.json();
              send('step', { step: 1, status: 'active', label: `AI task queued (${taskId?.slice(0, 8)}) — waiting for Chief QA...` });

              // Poll up to 90s
              const start = Date.now();
              let aiResult: TicketEnrichment | null = null;
              while (Date.now() - start < 90_000) {
                await new Promise(r => setTimeout(r, 6000));
                const poll = await fetch(`${QA_BASE}/api/ai/queue?taskId=${taskId}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
                if (poll?.ok) {
                  const task = await poll.json();
                  if (task.status === 'done' && task.result) { aiResult = task.result; break; }
                  if (task.status === 'failed') break;
                }
              }

              if (aiResult) {
                enrichment = aiResult;
                send('step', { step: 1, status: 'done', label: `AI enrichment complete (Chief QA)` });
                // Skip the direct API block below
                goto_post_comment: {
                  let commentId: string | null = null;
                  if (postComment) {
                    send('step', { step: 2, status: 'active', label: 'Posting comment to Linear...' });
                    let commentBody = formatEnrichmentAsComment(enrichment);
                    if (githubCtx) commentBody += '\n\n' + formatGitHubContextForComment(githubCtx);
                    commentId = await addComment(issue.id, commentBody);
                    send('step', { step: 2, status: 'done', label: 'Comment posted ✅' });
                  } else {
                    send('step', { step: 2, status: 'done', label: 'Skipped (postComment=false)' });
                  }
                  send('step', { step: 3, status: 'done', label: 'Enrichment complete' });
                  send('done', { success: true, identifier, analysis: enrichment, commentId, commentPosted: !!commentId });
                  controller.close();
                  return;
                }
              } else {
                send('step', { step: 1, status: 'active', label: 'AI proxy timed out — using fallback enrichment' });
                enrichment = generateFallbackEnrichment(issue);
              }
            } else {
              enrichment = generateFallbackEnrichment(issue);
            }

            // Jump to post-comment
            let commentId2: string | null = null;
            if (postComment) {
              send('step', { step: 2, status: 'active', label: 'Posting comment to Linear...' });
              let commentBody2 = formatEnrichmentAsComment(enrichment);
              if (githubCtx) commentBody2 += '\n\n' + formatGitHubContextForComment(githubCtx);
              commentId2 = await addComment(issue.id, commentBody2);
              send('step', { step: 2, status: 'done', label: 'Comment posted ✅' });
            } else {
              send('step', { step: 2, status: 'done', label: 'Skipped (postComment=false)' });
            }
            send('step', { step: 3, status: 'done', label: 'Enrichment complete' });
            send('done', { success: true, identifier, analysis: enrichment, commentId: commentId2, commentPosted: !!commentId2 });
            controller.close();
            return;

          } catch (proxyErr: any) {
            send('step', { step: 1, status: 'active', label: `AI proxy error: ${proxyErr.message} — using fallback` });
            enrichment = generateFallbackEnrichment(issue);
            // fall through to post comment
            let cid: string | null = null;
            if (postComment) {
              send('step', { step: 2, status: 'active', label: 'Posting comment to Linear...' });
              let cb = formatEnrichmentAsComment(enrichment);
              if (githubCtx) cb += '\n\n' + formatGitHubContextForComment(githubCtx);
              cid = await addComment(issue.id, cb);
              send('step', { step: 2, status: 'done', label: 'Comment posted ✅' });
            }
            send('step', { step: 3, status: 'done', label: 'Enrichment complete (fallback)' });
            send('done', { success: true, identifier, analysis: enrichment, commentPosted: !!cid });
            controller.close();
            return;
          }
        }

        if (openaiKeyValid) {
          const prompt = buildEnrichmentPrompt(issue, githubCtx ?? undefined);
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
          let commentBody = formatEnrichmentAsComment(enrichment);
          // Append GitHub context section if available
          if (githubCtx) {
            commentBody += '\n\n' + formatGitHubContextForComment(githubCtx);
          }
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
