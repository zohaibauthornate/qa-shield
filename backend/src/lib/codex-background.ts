/**
 * Codex Background Runner
 * Spawns Codex as a fully detached process so enrich/verify can return immediately.
 * Codex runs async, posts comment to Linear when done, updates job status file.
 *
 * Job state file: /tmp/qa-shield-codex-jobs.json
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const JOBS_FILE = '/tmp/qa-shield-codex-jobs.json';
const RUNNER_SCRIPT = path.join(process.cwd(), 'src/lib/codex-runner-process.mjs');

export interface CodexJob {
  jobId: string;
  identifier: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  startedAt: string;
  completedAt?: string;
  commentPosted?: boolean;
  error?: string;
}

function readJobs(): Record<string, CodexJob> {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJob(job: CodexJob) {
  const jobs = readJobs();
  jobs[job.jobId] = job;
  // Keep only last 50 jobs
  const keys = Object.keys(jobs);
  if (keys.length > 50) {
    const oldest = keys.sort((a, b) => jobs[a].startedAt.localeCompare(jobs[b].startedAt)).slice(0, keys.length - 50);
    oldest.forEach(k => delete jobs[k]);
  }
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

export function getJob(jobId: string): CodexJob | null {
  return readJobs()[jobId] || null;
}

export function getJobByIdentifier(identifier: string): CodexJob | null {
  const jobs = readJobs();
  return Object.values(jobs)
    .filter(j => j.identifier === identifier)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] || null;
}

/**
 * Spawn Codex enrichment as a detached background process.
 * Returns jobId immediately.
 */
export function spawnCodexEnrich(
  identifier: string,
  issueJson: string,
  githubCtxJson: string,
  postComment: boolean,
): string {
  const jobId = crypto.randomUUID().slice(0, 8);

  const job: CodexJob = {
    jobId,
    identifier,
    status: 'queued',
    startedAt: new Date().toISOString(),
  };
  writeJob(job);

  // Spawn runner as detached child — it will outlive this request
  const env = {
    ...process.env,
    QA_CODEX_JOB_ID: jobId,
    QA_CODEX_IDENTIFIER: identifier,
    QA_CODEX_ISSUE: issueJson,
    QA_CODEX_GITHUB: githubCtxJson,
    QA_CODEX_POST_COMMENT: postComment ? '1' : '0',
    HOME: process.env.HOME || '/Users/zohaibmac-mini',
  };

  const child = spawn('node', [RUNNER_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref(); // let parent process exit without waiting

  return jobId;
}
