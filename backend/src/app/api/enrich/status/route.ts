/**
 * GET /api/enrich/status?jobId=xxx  — check Codex background job status
 * GET /api/enrich/status?identifier=CRX-900 — check by ticket
 */

import { NextRequest, NextResponse } from 'next/server';
import { getJob, getJobByIdentifier } from '@/lib/codex-background';

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId');
  const identifier = req.nextUrl.searchParams.get('identifier');

  if (!jobId && !identifier) {
    return NextResponse.json({ error: 'jobId or identifier required' }, { status: 400 });
  }

  const job = jobId ? getJob(jobId) : getJobByIdentifier(identifier!);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json({ job });
}
