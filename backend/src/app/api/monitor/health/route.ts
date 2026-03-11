/**
 * GET /api/monitor/health — Quick health check
 * POST /api/monitor/health — Full benchmark: API timing + payload + regression + WS + report
 * Sprint 2: added payload tracking, regression analysis, WebSocket benchmark, report engine
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  benchmarkEndpoint,
  comparativeBehnchmark,
  apiLevelBenchmark,
  measurePayload,
  benchmarkWebSocket,
  compareToBaseline,
  saveBaseline,
  generateMarkdownReport,
  saveReport,
} from '@/lib/scanner';
import type { ApiEndpointBenchmark, QAShieldReport } from '@/lib/scanner';
import {
  getIssueByIdentifier,
  addComment,
  findSimilarIssue,
  createIssue,
  LABELS,
} from '@/lib/linear';
import { formatPerformanceComment } from '@/lib/ai';

const HEALTH_CHECKS = {
  api: '/api/token/list?limit=5',
  leaderboard: '/api/leaderboard',
  rewards: '/api/rewards',
};

const PAYLOAD_ENDPOINTS = [
  '/api/token/list?limit=20',
  '/api/token/search?q=test',
  '/api/token?address=Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD',
  '/api/leaderboard/stats',
];

// POST: Full streaming benchmark with all Sprint 2 features
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { identifier, postComment = false } = body;

  const encoder = new TextEncoder();
  const runStart = Date.now();
  const runId = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: any) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const apiBase = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';

        // ── Step 1: API-Level Benchmark ──
        send('step', { step: 0, status: 'active', label: 'Benchmarking 4 API endpoints vs pump.fun + axiom...' });
        const apiBenchmarks = await apiLevelBenchmark(3);
        const slowerCount = apiBenchmarks.filter(b => b.verdict === 'slower').length;
        const totalWithComp = apiBenchmarks.filter(b => b.verdict !== 'no_competitor_data').length;
        send('step', { step: 0, status: 'done', label: `Benchmark done: ${slowerCount}/${totalWithComp} slower than competitors` });
        send('api_benchmark', { results: apiBenchmarks });

        // ── Step 2: Payload Size Analysis ──
        send('step', { step: 1, status: 'active', label: 'Measuring payload sizes...' });
        const payloads = await Promise.all(
          PAYLOAD_ENDPOINTS.map(ep => measurePayload(`${apiBase}${ep}`))
        );
        send('step', { step: 1, status: 'done', label: `Payload sizes: ${payloads.map(p => p.sizeKb).join(', ')}` });
        send('payloads', { results: payloads });

        // ── Step 3: Regression Analysis ──
        send('step', { step: 2, status: 'active', label: 'Comparing to baseline...' });
        const regressions = compareToBaseline(apiBenchmarks);
        const regressedCount = regressions.filter(r => r.verdict === 'regressed').length;
        const improvedCount = regressions.filter(r => r.verdict === 'improved').length;
        // Save current run as new baseline
        saveBaseline(apiBenchmarks);
        const regLabel = regressions.every(r => r.verdict === 'new')
          ? 'First run — baseline saved'
          : `${regressedCount} regressed, ${improvedCount} improved`;
        send('step', { step: 2, status: regressedCount > 0 ? 'warn' : 'done', label: `Regression: ${regLabel}` });
        send('regression', { results: regressions });

        // ── Step 4: WebSocket Benchmark ──
        send('step', { step: 3, status: 'active', label: 'Testing WebSocket connection...' });
        const wsResult = await benchmarkWebSocket();
        const wsLabel = wsResult.status === 'not_configured'
          ? 'WS not configured (set STAGING_WS_URL)'
          : wsResult.status === 'connected'
          ? `WS connected in ${wsResult.connectMs}ms, first msg ${wsResult.firstMessageMs}ms`
          : `WS ${wsResult.status}: ${wsResult.error}`;
        send('step', { step: 3, status: wsResult.status === 'connected' ? 'done' : 'warn', label: wsLabel });
        send('websocket', { result: wsResult });

        // ── Step 5: Post to Linear ──
        send('step', { step: 4, status: 'active', label: 'Posting to Linear...' });
        if (postComment && identifier) {
          try {
            const issue = await getIssueByIdentifier(identifier);
            const perfComment = formatPerformanceComment(apiBenchmarks, regressions, payloads);
            await addComment(issue.id, perfComment);
            send('linear_update', { type: 'performance', ticket: identifier, message: 'Performance comment posted' });
            send('step', { step: 4, status: 'done', label: 'Linear comment posted' });
          } catch (e) {
            console.error('Failed to post perf comment:', e);
            send('step', { step: 4, status: 'error', label: 'Failed to post comment' });
          }
        } else {
          send('step', { step: 4, status: 'done', label: 'No ticket selected — skipped' });
        }

        // ── Step 6: Generate Report ──
        send('step', { step: 5, status: 'active', label: 'Generating QA Shield report...' });
        const report: QAShieldReport = {
          runId,
          timestamp: new Date().toISOString(),
          target: apiBase,
          securitySummary: { passed: 0, warnings: 0, failed: 0, total: 0 }, // filled by security scan, not here
          benchmarkSummary: { slower: slowerCount, total: totalWithComp },
          regressions,
          wsResult,
          payloads,
          newTickets: [],
          existingTickets: [],
          durationMs: Date.now() - runStart,
        };
        const reportContent = generateMarkdownReport(report);
        const reportPath = saveReport(report, reportContent);
        send('step', { step: 5, status: 'done', label: `Report saved: ${reportPath ? reportPath.split('/').pop() : 'in-memory'}` });
        send('report', { runId, content: reportContent, path: reportPath });

        send('complete', {
          success: true,
          apiBenchmarks,
          payloads,
          regressions,
          wsResult,
          runId,
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
      const apiBenchmarks = await apiLevelBenchmark(3);
      return NextResponse.json({
        success: true,
        mode: 'benchmark',
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
