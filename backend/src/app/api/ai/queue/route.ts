/**
 * POST /api/ai/queue   — Write a pending AI task to the queue
 * GET  /api/ai/queue   — List all tasks (pending + done)
 * GET  /api/ai/queue?taskId=xxx — Poll for a specific task result
 *
 * Chief QA (OpenClaw cron) reads the queue every 2 min,
 * processes tasks using Claude, writes results back here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const QUEUE_FILE = process.env.AI_QUEUE_FILE || '/tmp/qa-shield-ai-queue.json';

export type AITaskType = 'verify-plan' | 'enrich' | 'analyze-diff';
export type AITaskStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface AITask {
  taskId: string;
  type: AITaskType;
  payload: Record<string, unknown>;
  status: AITaskStatus;
  createdAt: string;
  processedAt?: string;
  result?: unknown;
  error?: string;
}

async function loadQueue(): Promise<AITask[]> {
  try {
    const raw = await fs.readFile(QUEUE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveQueue(tasks: AITask[]) {
  // Keep only last 200 tasks
  const trimmed = tasks.slice(-200);
  await fs.writeFile(QUEUE_FILE, JSON.stringify(trimmed, null, 2));
}

// POST — enqueue a new AI task
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, payload } = body;
    if (!type || !payload) return NextResponse.json({ error: 'Missing type or payload' }, { status: 400 });

    const task: AITask = {
      taskId: randomUUID(),
      type,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    const queue = await loadQueue();
    queue.push(task);
    await saveQueue(queue);

    console.log(`[AI Queue] Enqueued ${type} task ${task.taskId.slice(0, 8)}`);
    return NextResponse.json({ ok: true, taskId: task.taskId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET — poll for task result
export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get('taskId');
  const queue = await loadQueue();

  if (taskId) {
    const task = queue.find(t => t.taskId === taskId);
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    return NextResponse.json(task);
  }

  // Return all pending tasks (for Chief QA to pick up)
  const pending = queue.filter(t => t.status === 'pending');
  return NextResponse.json({ total: queue.length, pending: pending.length, tasks: pending });
}
