/**
 * POST /api/regression/daily
 * Triggers daily regression scan, posts Slack report, files Linear tickets.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runDailyRegression } from '@/lib/regression-runner';

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const report = await runDailyRegression();
    return NextResponse.json({
      success: true,
      summary: report.summary,
      slackPosted: report.slackPosted,
      areas: report.areas.map(a => ({
        name: a.name,
        status: a.status,
        failedChecks: a.checks.filter(c => c.status === 'fail').length,
        totalChecks: a.checks.length,
        ticketFiled: a.ticketFiled || null,
      })),
    });
  } catch (err: any) {
    console.error('[/api/regression/daily]', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'POST /api/regression/daily' });
}
