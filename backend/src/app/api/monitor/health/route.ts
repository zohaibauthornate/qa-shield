/**
 * GET /api/monitor/health
 * Performance monitoring & competitor benchmarking
 */

import { NextRequest, NextResponse } from 'next/server';
import { benchmarkEndpoint, comparativeBehnchmark } from '@/lib/scanner';

const HEALTH_CHECKS = {
  api: '/api/token',
  watchlist: '/api/watchlist',
  leaderboard: '/api/leaderboard',
};

const COMPETITORS = [
  { name: 'axiom.trade', url: 'https://axiom.trade' },
  { name: 'pump.fun', url: 'https://pump.fun' },
];

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') || 'quick';

  try {
    const stagingApi = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
    const stagingUrl = process.env.STAGING_URL || 'https://dev.creator.fun';

    if (mode === 'benchmark') {
      // Full comparative benchmark
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

    // Quick health check
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
