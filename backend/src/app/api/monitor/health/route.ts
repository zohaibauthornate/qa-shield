/**
 * GET /api/monitor/health — Quick health check or benchmark
 * POST /api/monitor/health — Streaming benchmark with Linear comment + ticket creation
 */

import { NextRequest, NextResponse } from 'next/server';
import { benchmarkEndpoint, comparativeBehnchmark } from '@/lib/scanner';
import {
  getIssueByIdentifier,
  addComment,
  findSimilarIssue,
  createIssue,
  LABELS,
} from '@/lib/linear';
import { formatPerformanceComment } from '@/lib/ai';

const HEALTH_CHECKS = {
  api: '/api/token',
  watchlist: '/api/watchlist',
  leaderboard: '/api/leaderboard',
};

const COMPETITORS = [
  { name: 'axiom.trade', url: 'https://axiom.trade' },
  { name: 'pump.fun', url: 'https://pump.fun' },
];

// POST: Streaming benchmark with Linear integration
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { identifier, postComment = false } = body;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: any) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const stagingApi = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
        const stagingUrl = process.env.STAGING_URL || 'https://dev.creator.fun';

        // ── Step 1: Benchmark ──
        send('step', { step: 0, status: 'active', label: 'Benchmarking creator.fun...' });
        const ourPerf = await benchmarkEndpoint(stagingUrl);
        send('step', { step: 0, status: 'done', label: `creator.fun: ${ourPerf.responseTime}ms` });

        send('step', { step: 1, status: 'active', label: 'Benchmarking competitors...' });
        const axiomPerf = await benchmarkEndpoint('https://axiom.trade');
        const pumpPerf = await benchmarkEndpoint('https://pump.fun');
        send('step', { step: 1, status: 'done', label: `axiom: ${axiomPerf.responseTime}ms · pump: ${pumpPerf.responseTime}ms` });

        send('benchmark', { ours: ourPerf, axiom: axiomPerf, pump: pumpPerf });

        // ── Step 2: Post to Linear ──
        send('step', { step: 2, status: 'active', label: 'Posting to Linear...' });
        if (postComment && identifier) {
          try {
            const issue = await getIssueByIdentifier(identifier);
            const perfComment = formatPerformanceComment({ ours: ourPerf, axiom: axiomPerf, pump: pumpPerf });
            await addComment(issue.id, perfComment);
            send('linear_update', { type: 'performance', ticket: identifier, message: 'Performance comment posted' });
            send('step', { step: 2, status: 'done', label: 'Comment posted' });
          } catch (e) {
            console.error('Failed to post perf comment:', e);
            send('step', { step: 2, status: 'error', label: 'Failed to post comment' });
          }
        } else {
          send('step', { step: 2, status: 'done', label: 'No ticket selected — skipped' });
        }

        // ── Step 3: Check for perf tickets ──
        send('step', { step: 3, status: 'active', label: 'Checking for performance issues...' });

        const createdTickets: any[] = [];
        const existingTickets: any[] = [];

        // Flag if we're significantly slower than competitors
        if (ourPerf.responseTime > 0 && axiomPerf.responseTime > 0) {
          const diff = ourPerf.responseTime - axiomPerf.responseTime;
          if (diff > 500) {
            const title = `[Performance][High] Severe performance degradation compared to competitors`;
            const existing = await findSimilarIssue(title);
            if (existing) {
              existingTickets.push({
                identifier: existing.identifier,
                title: existing.title,
                url: existing.url,
                matchedFor: `${Math.round(diff)}ms slower than axiom.trade`,
              });
              send('existing_ticket', {
                identifier: existing.identifier,
                title: existing.title,
                url: existing.url,
                matchedFor: `${Math.round(diff)}ms slower than axiom.trade`,
              });
            } else {
              try {
                const created = await createIssue({
                  title,
                  description: `## Performance Degradation\n\n**creator.fun:** ${ourPerf.responseTime}ms\n**axiom.trade:** ${axiomPerf.responseTime}ms\n**pump.fun:** ${pumpPerf.responseTime}ms\n\nOur frontend is **${Math.round(diff)}ms slower** than the fastest competitor.\n\n---\n_Auto-created by QA Shield 🛡️_`,
                  priority: 2,
                  labelIds: [LABELS.BUG],
                });
                createdTickets.push(created);
                send('new_ticket', {
                  identifier: created.identifier,
                  title: created.title,
                  url: created.url,
                });
              } catch (e) {
                console.error('Failed to create perf ticket:', e);
              }
            }
          }
        }

        send('step', { step: 3, status: 'done', label: `${createdTickets.length} new, ${existingTickets.length} existing` });

        send('complete', {
          success: true,
          benchmark: { ours: ourPerf, axiom: axiomPerf, pump: pumpPerf },
          createdTickets,
          existingTickets,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send('error', { message });
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

// GET: Quick health check (non-streaming)
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') || 'quick';

  try {
    const stagingApi = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
    const stagingUrl = process.env.STAGING_URL || 'https://dev.creator.fun';

    if (mode === 'benchmark') {
      const frontendBenchmark = await comparativeBehnchmark(stagingUrl, COMPETITORS);
      const apiBenchmarks = await Promise.all(
        Object.entries(HEALTH_CHECKS).map(async ([name, path]) => ({
          name,
          result: await benchmarkEndpoint(`${stagingApi}${path}`),
        }))
      );

      return NextResponse.json({
        success: true,
        mode: 'benchmark',
        frontend: frontendBenchmark,
        api: apiBenchmarks,
        timestamp: new Date().toISOString(),
      });
    }

    const results = await Promise.all(
      Object.entries(HEALTH_CHECKS).map(async ([name, path]) => {
        const result = await benchmarkEndpoint(`${stagingApi}${path}`);
        return {
          name,
          url: `${stagingApi}${path}`,
          status: result.statusCode >= 200 && result.statusCode < 500 ? 'up' : 'down',
          responseTime: result.responseTime,
          ttfb: result.ttfb,
          statusCode: result.statusCode,
        };
      })
    );

    const allUp = results.every(r => r.status === 'up');
    const avgResponseTime = Math.round(
      results.filter(r => r.responseTime > 0).reduce((sum, r) => sum + r.responseTime, 0) /
      results.filter(r => r.responseTime > 0).length
    );

    return NextResponse.json({
      success: true,
      mode: 'quick',
      healthy: allUp,
      avgResponseTime,
      endpoints: results,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, healthy: false }, { status: 500 });
  }
}
