/**
 * GET /api/monitor/health — Quick health check or benchmark
 * POST /api/monitor/health — Streaming benchmark with Linear comment + ticket creation
 */

import { NextRequest, NextResponse } from 'next/server';
import { benchmarkEndpoint, comparativeBehnchmark, apiLevelBenchmark } from '@/lib/scanner';
import type { ApiEndpointBenchmark } from '@/lib/scanner';
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
        // ── Step 1: API-Level Benchmark ──
        send('step', { step: 0, status: 'active', label: 'Benchmarking 4 API endpoints (3 samples each)...' });
        const apiBenchmarks = await apiLevelBenchmark(3);

        const slowerCount = apiBenchmarks.filter(b => b.verdict === 'slower').length;
        const totalWithComp = apiBenchmarks.filter(b => b.verdict !== 'no_competitor_data').length;
        send('step', { step: 0, status: 'done', label: `Done: ${slowerCount}/${totalWithComp} endpoints slower than competitors` });
        send('api_benchmark', { results: apiBenchmarks });

        // ── Step 2: Post to Linear ──
        send('step', { step: 1, status: 'active', label: 'Posting to Linear...' });
        if (postComment && identifier) {
          try {
            const issue = await getIssueByIdentifier(identifier);
            const perfComment = formatPerformanceComment(apiBenchmarks);
            await addComment(issue.id, perfComment);
            send('linear_update', { type: 'performance', ticket: identifier, message: 'Performance comment posted' });
            send('step', { step: 1, status: 'done', label: 'Comment posted' });
          } catch (e) {
            console.error('Failed to post perf comment:', e);
            send('step', { step: 1, status: 'error', label: 'Failed to post comment' });
          }
        } else {
          send('step', { step: 1, status: 'done', label: 'No ticket selected — skipped' });
        }

        send('complete', {
          success: true,
          apiBenchmarks,
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
