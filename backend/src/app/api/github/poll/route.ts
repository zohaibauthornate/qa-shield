/**
 * POST /api/github/poll
 * Polls GitHub for new commits on the staging branch across all 3 repos.
 * For each commit with a CRX-XXX reference:
 *   1. Auto-labels ticket with QA-ReCheck + moves to In Review
 *   2. Waits for staging deploy (polls version endpoint)
 *   3. Runs QA Shield verify → posts result to Linear
 *   4. PASS → Done | FAIL → Todo + Slack alert | PARTIAL → Slack alert
 *
 * Called by OpenClaw cron every 5 minutes.
 * State tracked in /tmp/qa-shield-commit-poll-state.json
 */

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { runCommitAnalysis } from '@/lib/commit-runner';
import { fileCommitFindings, type CommitFinding } from '@/lib/guardian';
import { scanEndpoint, apiLevelBenchmark } from '@/lib/scanner';
import { spawnCodexEnrich, getJobByIdentifier } from '@/lib/codex-background';
import { runVerification } from '@/lib/verify-runner';
import {
  getIssueByIdentifier,
  createIssue,
  addComment,
  addLabel,
  updateIssueState,
  WORKFLOW_STATES,
  LABELS,
} from '@/lib/linear';

// Industry performance standards (RAIL model + trading platform norms)
const PERF_THRESHOLD_MS = 200;          // anything above this needs a ticket
const PERF_CRITICAL_MS = 800;           // above this = critical severity
const COMPETITORS = [
  { name: 'pump.fun',     avgMs: 25 },
  { name: 'axiom.trade',  avgMs: 45 },
  { name: 'photon.trade', avgMs: 60 },
];

const REPOS = (process.env.GITHUB_REPOS || 'creatorfun/frontend,creatorfun/backend-persistent,creatorfun/backend-realtime').split(',');
const BRANCH = process.env.GITHUB_BRANCH || 'staging';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const STAGING_URL = process.env.STAGING_URL || 'https://dev.creator.fun';
const STATE_FILE = '/tmp/qa-shield-commit-poll-state.json';
const LOCK_FILE = '/tmp/qa-shield-poll.lock';
const TICKET_REGEX = /\b(CRX-\d+)\b/gi;

// ── Poll lock — prevents concurrent runs from double-processing commits ──
async function acquireLock(): Promise<boolean> {
  try {
    const lockData = await fs.readFile(LOCK_FILE, 'utf8').catch(() => null);
    if (lockData) {
      const { pid, startedAt } = JSON.parse(lockData);
      const ageMs = Date.now() - new Date(startedAt).getTime();
      if (ageMs < 15 * 60 * 1000) { // lock valid for 15 min max (runs can take ~5-10 min)
        console.log(`[poll] Already running (pid ${pid}, ${Math.round(ageMs/1000)}s ago) — skipping`);
        return false;
      }
      console.log(`[poll] Stale lock (${Math.round(ageMs/1000)}s) — overriding`);
    }
    await fs.writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return true;
  } catch {
    return true; // if lock check fails, proceed anyway
  }
}

async function releaseLock() {
  await fs.unlink(LOCK_FILE).catch(() => {});
}

// ── State persistence ──
interface PollState {
  lastSeenShas: Record<string, string>;
  processedTickets: Record<string, string[]>; // ticketId → list of processed commit SHAs
}

async function loadState(): Promise<PollState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    if (!raw || !raw.trim()) {
      // Empty file — do NOT treat as fresh start. Log and return safe default.
      console.warn('[poll] State file is empty — starting fresh (no commits will be re-processed after this run)');
      return { lastSeenShas: {}, processedTickets: {} };
    }
    const parsed = JSON.parse(raw);
    // Validate shape
    if (typeof parsed !== 'object' || !parsed.lastSeenShas || !parsed.processedTickets) {
      console.warn('[poll] State file corrupted — resetting');
      return { lastSeenShas: {}, processedTickets: {} };
    }
    return parsed;
  } catch (err: any) {
    console.warn('[poll] Could not load state file:', err.message, '— starting fresh');
    return { lastSeenShas: {}, processedTickets: {} };
  }
}

async function saveState(state: PollState) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Fetch recent commits from GitHub (main branch + recent feature branches with CRX refs) ──
async function fetchNewCommits(repo: string, lastSha: string | undefined) {
  const headers = { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' };
  const seen = new Set<string>();
  const result: { sha: string; message: string; author: string; branch: string }[] = [];

  // Helper to fetch commits from a specific branch
  async function fetchFromBranch(branch: string) {
    const url = `https://api.github.com/repos/${repo}/commits?sha=${branch}&per_page=20`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return;
    const commits = await res.json();
    if (!Array.isArray(commits)) return;
    for (const c of commits) {
      if (c.sha === lastSha) break;
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      const message = (c.commit?.message as string) || '';
      // Only include commits that reference a CRX ticket
      if (TICKET_REGEX.test(message)) {
        result.push({ sha: c.sha, message, author: (c.commit?.author?.name as string) || '', branch });
      }
    }
  }

  // Always check the primary branch
  await fetchFromBranch(BRANCH);

  // Also scan recent feature/fix branches for CRX commits
  try {
    const branchesRes = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=50`, { headers, signal: AbortSignal.timeout(10000) });
    if (branchesRes.ok) {
      const branches = await branchesRes.json();
      if (Array.isArray(branches)) {
        // Filter branches that look like feature/fix branches with CRX refs
        const featureBranches = branches
          .filter((b: any) => /^(fix|feat|feature|chore)\/crx-/i.test(b.name) && b.name !== BRANCH)
          .slice(0, 10); // max 10 feature branches
        await Promise.all(featureBranches.map((b: any) => fetchFromBranch(b.name)));
      }
    }
  } catch {
    // non-fatal — feature branch scan is best-effort
  }

  return result;
}

// ── Extract ticket IDs from commit messages ──
function extractTicketIds(messages: string[]): string[] {
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const m of msg.matchAll(TICKET_REGEX)) seen.add(m[1].toUpperCase());
  }
  return Array.from(seen);
}

// ── Wait for staging to reflect new commit (deploy detection) ──
async function waitForDeploy(commitSha: string, maxWaitMs = 120_000): Promise<boolean> {
  const start = Date.now();
  const shortSha = commitSha.slice(0, 7);

  // Try version/build-info endpoints — common patterns
  const versionEndpoints = [
    `${STAGING_URL}/build-info.json`,
    `${STAGING_URL}/version.json`,
    `${STAGING_URL}/api/version`,
  ];

  while (Date.now() - start < maxWaitMs) {
    for (const endpoint of versionEndpoints) {
      try {
        const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const text = await res.text();
          if (text.includes(shortSha) || text.includes(commitSha.slice(0, 12))) {
            console.log(`[poll] Deploy detected via ${endpoint} for ${shortSha}`);
            return true;
          }
        }
      } catch { /* endpoint not found */ }
    }
    // Check if staging is at least healthy
    try {
      const health = await fetch(`${STAGING_URL.replace('creator.fun', 'bep.creator.fun')}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (health.ok) {
        // No version endpoint, fall back to time-based wait
        const elapsed = Date.now() - start;
        if (elapsed >= 45_000) {
          console.log(`[poll] No version endpoint found, waited ${elapsed / 1000}s — proceeding`);
          return true;
        }
      }
    } catch { /* ok */ }
    await new Promise(r => setTimeout(r, 10_000));
  }
  console.warn(`[poll] Deploy detection timed out after ${maxWaitMs / 1000}s, proceeding anyway`);
  return false;
}

// ── Rich Slack alert ──
async function slackAlert(msg: string) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: msg }),
  }).catch(() => {});
}

// Post to a specific Slack channel via Bot token (used for QA alerts)
async function slackAlertToChannel(msg: string, channel: string) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { await slackAlert(msg); return; } // fallback to webhook
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ channel, text: msg }),
  }).catch(() => {});
}

function buildSlackMsg(
  ticketId: string,
  verdict: string,
  commitSha: string,
  repo: string,
  summary: { passed: number; failed: number; warned: number },
  linearUrl?: string
): string {
  const short = commitSha.slice(0, 7);
  const repoName = repo.split('/')[1];
  const commitUrl = `https://github.com/${repo}/commit/${commitSha}`;
  const emoji = verdict === 'pass' ? '✅' : verdict === 'fail' ? '❌' : '⚠️';
  const verdictLabel = verdict.toUpperCase();
  const checks = `${summary.passed}✓ ${summary.failed}✗ ${summary.warned}⚠`;

  let msg = `${emoji} *${ticketId}* auto-verify *${verdictLabel}* — commit <${commitUrl}|\`${short}\`> on \`${repoName}/${BRANCH}\` — ${checks}`;
  if (linearUrl) msg += `\n🔗 <${linearUrl}|Open in Linear>`;
  if (verdict === 'fail') msg += `\n🔁 Ticket moved back to *Todo* — fix needs review`;
  if (verdict === 'pass') msg += `\n🎯 Ticket moved to *Done*`;
  return msg;
}

// ── Run security + performance side-scan (parallel to ticket verify) ──
async function runSideScans(
  commitSha: string,
  ticketId: string | undefined,
  filesChanged: { filename: string }[]
): Promise<CommitFinding[]> {
  const findings: CommitFinding[] = [];

  try {
    // Infer which API endpoints to check based on changed files
    const SCAN_ENDPOINTS = [
      '/api/token/list?limit=5',
      '/api/token?address=3jHkaVj9392sasDhVWivWyW8UYY3cfRCRJg3eEprDH7Q',
      '/api/leaderboard/stats',
      '/api/profile/stats/trading?wallet=7A6jxEcFDzLfVBFSJrqLz5LkJTW8aM7WjNL2jgP1gfP',
    ];
    const API_BASE = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';

    // Security + performance in parallel
    const [secResults, perfResults] = await Promise.all([
      Promise.all(SCAN_ENDPOINTS.slice(0, 2).map(ep => scanEndpoint(`${API_BASE}${ep}`))),
      apiLevelBenchmark(2), // 2 samples for speed during ticket testing
    ]);

    // Collect security findings
    for (const sec of secResults) {
      const failedChecks = sec.checks.filter(c => c.status === 'fail');
      for (const check of failedChecks) {
        const isCritical = check.severity === 'critical' || check.severity === 'high';
        findings.push({
          type: 'security',
          endpoint: sec.endpoint,
          title: `[Security] ${check.type.toUpperCase()} — ${sec.endpoint.replace(API_BASE, '')}`,
          description: `**Security issue detected alongside commit \`${commitSha.slice(0, 7)}\`**\n\n**Endpoint:** \`${sec.endpoint}\`\n**Check:** ${check.type}\n**Finding:** ${check.details}\n\n**Steps to verify:**\n1. \`curl -H "Origin: https://evil-site.example.com" ${sec.endpoint}\`\n2. Check response headers for ACAO, HSTS, X-Content-Type-Options`,
          severity: isCritical ? 'high' : 'medium',
        });
      }
    }

    // Collect performance findings
    for (const perf of perfResults) {
      if (perf.ourAvg <= PERF_THRESHOLD_MS || perf.ourAvg < 0) continue;
      const fastest = COMPETITORS.sort((a, b) => a.avgMs - b.avgMs)[0];
      const deltaPct = Math.round(((perf.ourAvg - fastest.avgMs) / fastest.avgMs) * 100);
      const severity = perf.ourAvg >= PERF_CRITICAL_MS ? 'critical' : perf.ourAvg >= 500 ? 'high' : 'medium';
      const endpointPath = perf.ourEndpoint;
      findings.push({
        type: 'performance',
        endpoint: `${API_BASE}${endpointPath}`,
        title: `[Performance] ${endpointPath} — ${perf.ourAvg}ms avg (${deltaPct}% slower than ${fastest.name})`,
        description: `**Performance issue detected alongside commit \`${commitSha.slice(0, 7)}\`**\n\n**Endpoint:** \`${endpointPath}\`\n\n| Metric | Value |\n|--------|-------|\n| Our Avg Response | ${perf.ourAvg}ms |\n| Our P95 | ${perf.ourP95}ms |\n| ${fastest.name} | ~${fastest.avgMs}ms |\n| Delta | +${deltaPct}% slower |\n| Industry Standard | <200ms (RAIL model) |\n\n**Why this matters:** Trading platforms need sub-200ms API responses. Slow endpoints reduce user trust and increase bounce rate.`,
        severity,
        ourAvgMs: perf.ourAvg,
        competitorAvgMs: fastest.avgMs,
        competitorName: fastest.name,
        deltaPct,
      });
    }
  } catch (err: any) {
    console.warn(`[poll] Side-scan error for ${ticketId || 'no-ticket'}:`, err.message);
  }

  return findings;
}

// ── Process a commit: unified flow ──
// 1. Check if Linear ticket exists for the commit
// 2. If YES → unified verify (code-level + live app) + side-scan security/perf in parallel
// 3. If NO ticket → still run security + performance scan, file findings if new
async function processCommit(
  ticketId: string,
  commitSha: string,
  commitMessage: string,
  author: string,
  repo: string,
  filesChanged: { filename: string; status: string; additions: number; deletions: number; patch?: string }[],
  overrideUrl?: string
) {
  const linearUrl = `https://linear.app/creatorfun/issue/${ticketId}`;
  const short = commitSha.slice(0, 7);
  const repoName = repo.split('/')[1];
  const commitUrl = overrideUrl ?? `https://github.com/${repo}/commit/${commitSha}`;

  try {
    // ── Step 1: Find or create Linear ticket ──
    let issue: any;
    let ticketCreated = false;
    try {
      issue = await getIssueByIdentifier(ticketId);
    } catch {
      issue = null;
    }

    if (!issue) {
      // Auto-create ticket from commit info
      console.log(`[poll] ${ticketId} not found — creating ticket from commit`);
      const changedFiles = filesChanged.map(f => f.filename).join(', ');
      const areas = [...new Set(filesChanged.map(f => f.filename.split('/')[0]))].join(', ');
      try {
        issue = await createIssue({
          title: `${commitMessage.slice(0, 100)}`,
          description: [
            `Auto-created by QA Shield on commit push.\n`,
            `**Commit:** [\`${short}\`](${commitUrl})`,
            `**Branch:** \`${repo}/${BRANCH}\``,
            `**Author:** ${author}`,
            `**Files changed (${filesChanged.length}):** ${changedFiles}`,
            `**Areas:** ${areas}`,
          ].join('\n'),
          stateId: WORKFLOW_STATES.IN_REVIEW,
        });
        ticketCreated = true;
        console.log(`[poll] Auto-created ticket for ${ticketId}: ${issue.id}`);
      } catch (createErr: any) {
        console.warn(`[poll] Could not create ticket for ${ticketId}: ${createErr.message}`);
        return { ticketId, verdict: 'no-ticket' };
      }
    }

    // ── Step 2: Skip Done tickets entirely ──
    const currentState = (issue as any).state?.name || '';
    if (currentState === 'Done') {
      console.log(`[poll] ${ticketId} is already Done — skipping`);
      return { ticketId, verdict: 'already-done' };
    }

    // ── Step 3: Codex enrichment (once — check existing comment to survive restarts) ──
    try {
      const existingJob = getJobByIdentifier(ticketId);
      const alreadyRunning = existingJob && ['done','running','queued'].includes(existingJob.status);
      if (!alreadyRunning) {
        const comments = (issue as any).comments?.nodes || [];
        const hasCodexComment = comments.some((c: any) =>
          c.body?.includes('Ticket Analysis (Codex)') || c.body?.includes('QA Shield — Ticket Analysis')
        );
        if (!hasCodexComment) {
          spawnCodexEnrich(ticketId, JSON.stringify(issue), JSON.stringify(null), true);
          console.log(`[poll] Codex enrichment queued for ${ticketId}`);
        } else {
          console.log(`[poll] ${ticketId} already has Codex analysis — skipping enrich`);
        }
      }
    } catch (enrichErr: any) {
      console.warn(`[poll] Enrich spawn failed: ${enrichErr.message}`);
    }

    // ── Step 4: Label QA-ReCheck + move to In Review ──
    try {
      await addLabel(issue.id, [LABELS.QA_RECHECK]);
      if (!['In Review', 'Done'].includes(currentState)) {
        await updateIssueState(issue.id, WORKFLOW_STATES.IN_REVIEW);
        console.log(`[poll] ${ticketId} → In Review + QA-ReCheck`);
      }
    } catch (labelErr: any) {
      console.warn(`[poll] Label/move failed: ${labelErr.message}`);
    }

    // ── Step 5: Wait for staging deploy; fall back to local server ──
    console.log(`[poll] Waiting for deploy (${short})...`);
    const deployed = await waitForDeploy(commitSha);
    if (!deployed) {
      console.log(`[poll] Staging not updated — falling back to local server`);
      // Ping local dev server; if unreachable, note it in the comment but continue
      const localUp = await fetch('http://localhost:5173', { signal: AbortSignal.timeout(3000) })
        .then(r => r.ok).catch(() => false);
      if (localUp) {
        console.log(`[poll] Local dev server reachable — will use for DOM checks`);
        process.env.STAGING_API_URL_OVERRIDE = 'http://localhost:5173';
      } else {
        console.log(`[poll] No local server either — code-only verify`);
        process.env.STAGING_API_URL_OVERRIDE = '';
      }
    } else {
      process.env.STAGING_API_URL_OVERRIDE = '';
    }

    // ── Step 6: Unified verify (code-level + live) + security/perf side-scan in parallel ──
    console.log(`[poll] Running unified verify + side-scan for ${ticketId}...`);
    const [verifyResult, sideFindings] = await Promise.all([
      runVerification(issue, { postComment: true, moveToDone: true }),
      runSideScans(commitSha, ticketId, filesChanged),
    ]);

    // ── Step 7: Post security + perf scan results as comment on the ticket ──
    let filedFindings: string[] = [];
    let criticalFindings: CommitFinding[] = [];
    if (sideFindings.length > 0) {
      const { filed, skipped } = await fileCommitFindings(sideFindings, commitSha, ticketId);
      filedFindings = filed;
      // Only alert on findings that were NEWLY filed — not pre-existing/already-tracked ones
      criticalFindings = sideFindings.filter(f =>
        ['critical','high'].includes(f.severity) &&
        filed.some((id: string) => f.title.includes(id.split('-')[1] || ''))
      );
      // Simpler: alert only when new tickets were actually created
      if (filed.length === 0) criticalFindings = [];
      console.log(`[poll] Side-scan: filed=${filed.length}, skipped=${skipped}`);

      // Post side-scan summary as a comment on the ticket
      const secFindings = sideFindings.filter(f => f.type === 'security');
      const perfFindings = sideFindings.filter(f => f.type === 'performance');

      const secLines = secFindings.length === 0
        ? '✅ No security issues detected'
        : secFindings.map(f => {
            const icon = f.severity === 'critical' ? '🚨' : f.severity === 'high' ? '❌' : '⚠️';
            return `${icon} **[${f.severity.toUpperCase()}]** ${f.title}`;
          }).join('\n');

      const perfLines = perfFindings.length === 0
        ? '✅ No performance regressions detected'
        : perfFindings.map(f => {
            const icon = f.severity === 'critical' ? '🚨' : f.severity === 'high' ? '❌' : '⚠️';
            return `${icon} **[${f.severity.toUpperCase()}]** ${f.title}`;
          }).join('\n');

      const newTicketsStr = filedFindings.length > 0
        ? `\n\n**New tickets filed:** ${filedFindings.join(', ')}`
        : '\n\n**No new tickets filed** (all findings already tracked)';

      const sideScanComment = [
        `## 🔍 Security & Performance Scan — Commit \`${short}\``,
        `> Automated scan run alongside verification of this commit on \`${repoName}/${BRANCH}\``,
        '',
        '### 🔒 Security',
        secLines,
        '',
        '### ⚡ Performance',
        perfLines,
        newTicketsStr,
        '',
        `*Scanned: ${new Date().toISOString()} | Commit: [${short}](${commitUrl})*`,
      ].join('\n');

      try {
        await addComment(issue.id, sideScanComment);
        console.log(`[poll] Side-scan comment posted to ${ticketId}`);
      } catch (commentErr: any) {
        console.warn(`[poll] Failed to post side-scan comment: ${commentErr.message}`);
      }
    } else {
      // Post clean scan result too
      try {
        await addComment(issue.id, [
          `## 🔍 Security & Performance Scan — Commit \`${short}\``,
          `> Automated scan run alongside verification on \`${repoName}/${BRANCH}\``,
          '',
          '### 🔒 Security',
          '✅ No security issues detected',
          '',
          '### ⚡ Performance',
          '✅ No performance regressions detected',
          '',
          `*Scanned: ${new Date().toISOString()} | Commit: [${short}](${commitUrl})*`,
        ].join('\n'));
      } catch { /* non-fatal */ }
    }

    // ── Step 8: Slack alert — ONLY for critical/high security+perf findings ──
    // Per-ticket verify results go to Linear comments only, not Slack.
    const QA_CHANNEL = process.env.REGRESSION_SLACK_CHANNEL || 'C0AKXN13UB0';
    if (criticalFindings.length > 0) {
      const critMsg = [
        `🚨 *Critical/High finding(s) — \`${repoName}\` commit \`${short}\`*`,
        criticalFindings.map(f => `• *[${f.severity.toUpperCase()}]* ${f.title}`).join('\n'),
        `🔗 <${linearUrl}|${ticketId}> | <${commitUrl}|Commit>`,
      ].join('\n');
      await slackAlertToChannel(critMsg, QA_CHANNEL);
    }

    console.log(`[poll] ${ticketId} → ${verifyResult.verdict} (${filedFindings.length} findings filed)`);
    return { ticketId, verdict: verifyResult.verdict, findingsFiled: filedFindings.length };

  } catch (err: any) {
    console.error(`[poll] Error processing ${ticketId}:`, err.message);
    await slackAlert(`🚨 QA Shield error for *${ticketId}*: ${err.message}\n<${commitUrl}|commit \`${short}\`>`);
    return { ticketId, verdict: 'error', error: err.message };
  }
}

export async function POST(req: NextRequest) {
  // ── Prevent concurrent runs ──
  const locked = await acquireLock();
  if (!locked) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'Already running' });
  }

  try {
  const state = await loadState();
  const results: any[] = [];
  let newCommitsFound = 0;

  // ── Poll open PRs across all repos ──
  for (const repo of REPOS) {
    try {
      const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=20`, {
        headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!prRes.ok) continue;
      const prs = await prRes.json();
      if (!Array.isArray(prs)) continue;

      for (const pr of prs) {
        const headSha = pr.head?.sha;
        const prKey = `pr:${repo}:${pr.number}`;
        if (!headSha || state.processedTickets[prKey]) continue;

        const ticketIds = extractTicketIds([pr.title, pr.body || '']);
        if (ticketIds.length === 0) continue;

        // Mark PR as seen
        state.processedTickets[prKey] = headSha;
        await saveState(state);

        // Get changed files from PR
        let filesChanged: any[] = [];
        try {
          const filesRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}/files`, {
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
            signal: AbortSignal.timeout(15000),
          });
          if (filesRes.ok) {
            const files = await filesRes.json();
            filesChanged = (files || []).map((f: any) => ({ filename: f.filename, status: f.status, additions: f.additions || 0, deletions: f.deletions || 0, patch: f.patch || '' }));
          }
        } catch { /* non-fatal */ }

        console.log(`[poll] PR #${pr.number} in ${repo}: ${ticketIds.join(', ')}`);
        newCommitsFound++;

        for (const ticketId of ticketIds) {
          const result = await processCommit(
            ticketId, headSha,
            `PR #${pr.number}: ${pr.title}`,
            pr.user?.login || 'unknown',
            repo, filesChanged,
            `https://github.com/${repo}/pull/${pr.number}`
          );
          results.push(result);
        }
      }
    } catch (prErr: any) {
      console.warn(`[poll] PR scan failed for ${repo}: ${prErr.message}`);
    }
  }

  for (const repo of REPOS) {
    const lastSha = state.lastSeenShas[repo];
    const newCommits = await fetchNewCommits(repo, lastSha);
    if (newCommits.length === 0) continue;

    newCommitsFound += newCommits.length;
    console.log(`[poll] ${repo}: ${newCommits.length} new commit(s) on ${BRANCH}`);

    // Update last seen SHA
    state.lastSeenShas[repo] = newCommits[0].sha;

    // Process each new commit — extract ticket IDs and fetch file diffs
    for (const commit of newCommits) {
      const ticketIds = extractTicketIds([commit.message]);
      if (ticketIds.length === 0) continue;

      // Fetch file diffs for this commit
      let filesChanged: any[] = [];
      try {
        const diffRes = await fetch(`https://api.github.com/repos/${repo}/commits/${commit.sha}`, {
          headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
          signal: AbortSignal.timeout(15000),
        });
        if (diffRes.ok) {
          const detail = await diffRes.json();
          filesChanged = (detail.files || []).map((f: any) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions || 0,
            deletions: f.deletions || 0,
            patch: f.patch ? f.patch.slice(0, 2000) : undefined,
          }));
        }
      } catch (e) {
        console.warn(`[poll] Could not fetch diff for ${commit.sha.slice(0, 7)}:`, e);
      }

      for (const ticketId of ticketIds) {
        const processedShas = state.processedTickets[ticketId] || [];
        if (processedShas.includes(commit.sha)) {
          console.log(`[poll] ${ticketId}/${commit.sha.slice(0, 7)} already processed — skipping`);
          continue;
        }
        // ⚠️ CRITICAL: Mark SHA as processed and persist BEFORE running analysis.
        // If the run crashes mid-way, the state is already saved and we won't re-process on next poll.
        state.processedTickets[ticketId] = [...processedShas, commit.sha].slice(-50); // keep last 50 SHAs per ticket
        await saveState(state); // persist immediately — do not wait until end of all processing
        console.log(`[poll] ${ticketId}/${commit.sha.slice(0, 7)} marked as processed — running analysis`);
        const result = await processCommit(ticketId, commit.sha, commit.message, commit.author, repo, filesChanged);
        results.push({ repo, ...result });
      }
    }
  }

  await saveState(state);
  await releaseLock();

  return NextResponse.json({
    ok: true,
    newCommits: newCommitsFound,
    verified: results.length,
    results,
    timestamp: new Date().toISOString(),
  });
  } catch (err: any) {
    await releaseLock();
    console.error('[poll] Fatal error:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET() {
  const state = await loadState();
  return NextResponse.json({
    ok: true,
    repos: REPOS,
    branch: BRANCH,
    lastSeenShas: state.lastSeenShas,
    processedTickets: Object.keys(state.processedTickets).length,
    processedShaCount: Object.values(state.processedTickets).flat().length,
    stagingUrl: STAGING_URL,
  });
}
