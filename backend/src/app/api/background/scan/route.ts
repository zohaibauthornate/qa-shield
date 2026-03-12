/**
 * POST /api/background/scan — Guardian background scan
 * Called by OpenClaw cron every 30 min
 * Runs security + performance scan, auto-files Linear tickets for new issues
 *
 * GET /api/background/scan — Returns current guardian state + last scan result
 */

import { NextRequest, NextResponse } from 'next/server';
import { runGuardianScan, getGuardianState, formatGuardianStatusForSlack } from '@/lib/guardian';

export const maxDuration = 120;

// POST — Trigger a guardian scan
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body OK */ }

  const {
    fileTickets = true,
    minSeverityToFile = 'high',
    returnFull = false,
  } = body as {
    fileTickets?: boolean;
    minSeverityToFile?: 'critical' | 'high' | 'medium' | 'low';
    returnFull?: boolean;
  };

  try {
    const result = await runGuardianScan({
      fileTickets: Boolean(fileTickets),
      minSeverityToFile: minSeverityToFile as 'critical' | 'high' | 'medium' | 'low',
    });

    // Send Slack alert if critical issues found or new tickets filed
    const shouldAlert =
      result.overallHealth === 'critical' ||
      result.newIssuesFiled.some(i => i.severity === 'critical' || i.severity === 'high');

    if (shouldAlert && process.env.SLACK_WEBHOOK_URL) {
      await sendSlackAlert(formatGuardianStatusForSlack(result));
    }

    // Return compact or full result
    if (returnFull) {
      return NextResponse.json({ success: true, result });
    }

    return NextResponse.json({
      success: true,
      scanId: result.scanId,
      health: result.overallHealth,
      summary: result.summary,
      durationMs: result.durationMs,
      newTicketsFiled: result.newIssuesFiled.length,
      tickets: result.newIssuesFiled,
      securityIssues: result.securityFindings.length,
      perfIssues: result.performanceFindings.length,
      skippedDuplicates: result.skippedDuplicates,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Guardian API] Scan failed:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// GET — Status endpoint: last scan state + stats
export async function GET(_req: NextRequest) {
  try {
    const state = getGuardianState();

    return NextResponse.json({
      success: true,
      lastScanAt: state.lastScanAt,
      lastCleanScanAt: state.lastCleanScanAt,
      totalScans: state.stats.totalScans,
      totalIssuesFiled: state.stats.totalIssuesFiled,
      totalCriticalFound: state.stats.totalCriticalFound,
      openFiledIssues: state.filedIssues.filter(i => !i.resolvedAt).length,
      filedIssues: state.filedIssues.slice(-20), // last 20
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// ── Slack webhook helper ──
async function sendSlackAlert(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[Guardian] Slack alert failed:', err);
  }
}
