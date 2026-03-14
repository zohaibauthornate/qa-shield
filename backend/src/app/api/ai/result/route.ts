/**
 * PATCH /api/ai/result — Write AI task result (called by Chief QA / OpenClaw cron)
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';

const QUEUE_FILE = process.env.AI_QUEUE_FILE || '/tmp/qa-shield-ai-queue.json';

export async function PATCH(req: NextRequest) {
  try {
    const { taskId, result, error } = await req.json();
    if (!taskId) return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });

    let queue: any[] = [];
    try {
      queue = JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8'));
    } catch { queue = []; }

    const idx = queue.findIndex((t: any) => t.taskId === taskId);
    if (idx === -1) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

    queue[idx].status = error ? 'failed' : 'done';
    queue[idx].processedAt = new Date().toISOString();
    if (result) queue[idx].result = result;
    if (error) queue[idx].error = error;

    await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
    console.log(`[AI Queue] Task ${taskId.slice(0, 8)} → ${queue[idx].status}`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
