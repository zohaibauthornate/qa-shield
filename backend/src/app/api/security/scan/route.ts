/**
 * POST /api/security/scan
 * Scans endpoints for security vulnerabilities
 */

import { NextRequest, NextResponse } from 'next/server';
import { scanEndpoint, comparativeBehnchmark } from '@/lib/scanner';

const DEFAULT_ENDPOINTS = [
  '/api/token',
  '/api/watchlist',
  '/api/user',
  '/api/chat',
  '/api/trade',
  '/api/holdings',
  '/api/leaderboard',
  '/api/rewards',
  '/api/fees',
];

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { endpoints, baseUrl } = body;

    const apiBase = baseUrl || process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
    const endpointsToScan = endpoints || DEFAULT_ENDPOINTS;

    const results = await Promise.all(
      endpointsToScan.map((ep: string) => scanEndpoint(`${apiBase}${ep}`))
    );

    const summary = {
      total: results.length,
      passed: results.filter(r => r.overallStatus === 'pass').length,
      warnings: results.filter(r => r.overallStatus === 'warn').length,
      failed: results.filter(r => r.overallStatus === 'fail').length,
    };

    return NextResponse.json({
      success: true,
      summary,
      results,
      scannedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: Quick scan of default endpoints
export async function GET() {
  const apiBase = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';

  const results = await Promise.all(
    DEFAULT_ENDPOINTS.slice(0, 5).map(ep => scanEndpoint(`${apiBase}${ep}`))
  );

  return NextResponse.json({
    success: true,
    results,
    scannedAt: new Date().toISOString(),
  });
}
