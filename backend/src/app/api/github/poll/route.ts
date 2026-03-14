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
import {
  getIssueByIdentifier,
  addComment,
  addLabel,
  updateIssueState,
  WORKFLOW_STATES,
  LABELS,
} from '@/lib/linear';

const REPOS = (process.env.GITHUB_REPOS || 'creatorfun/frontend,creatorfun/backend-persistent,creatorfun/backend-realtime').split(',');
const BRANCH = process.env.GITHUB_BRANCH || 'staging';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const STAGING_URL = process.env.STAGING_URL || 'https://dev.creator.fun';
const STATE_FILE = '/tmp/qa-shield-commit-poll-state.json';
const TICKET_REGEX = /\b(CRX-\d+)\b/gi;

// ── State persistence ──
interface PollState {
  lastSeenShas: Record<string, string>;
  processedTickets: Record<string, string[]>; // ticketId → list of processed commit SHAs
}

async function loadState(): Promise<PollState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lastSeenShas: {}, processedTickets: {} };
  }
}

async function saveState(state: PollState) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Fetch recent commits from GitHub ──
async function fetchNewCommits(repo: string, lastSha: string | undefined) {
  const url = `https://api.github.com/repos/${repo}/commits?sha=${BRANCH}&per_page=20`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const commits = await res.json();
  if (!Array.isArray(commits)) return [];
  const result = [];
  for (const c of commits) {
    if (c.sha === lastSha) break;
    result.push({ sha: c.sha as string, message: (c.commit?.message as string) || '', author: (c.commit?.author?.name as string) || '' });
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

// ── Process a commit: analyze diff → run targeted checks → post to Linear ──
async function processCommit(
  ticketId: string,
  commitSha: string,
  commitMessage: string,
  author: string,
  repo: string,
  filesChanged: { filename: string; status: string; additions: number; deletions: number; patch?: string }[]
) {
  const linearUrl = `https://linear.app/creatorfun/issue/${ticketId}`;
  try {
    const issue = await getIssueByIdentifier(ticketId);
    if (!issue) {
      console.log(`[poll] ${ticketId} not found in Linear — skipping`);
      return { ticketId, verdict: 'skipped', error: 'Not found in Linear' };
    }

    // Auto-label QA-ReCheck + move to In Review
    try {
      await addLabel(issue.id, [LABELS.QA_RECHECK]);
      const currentState = (issue as any).state?.name || '';
      if (!['In Review', 'Done'].includes(currentState)) {
        await updateIssueState(issue.id, WORKFLOW_STATES.IN_REVIEW);
        console.log(`[poll] ${ticketId} → In Review + QA-ReCheck label`);
      }
    } catch (labelErr: any) {
      console.warn(`[poll] Label/move failed for ${ticketId}: ${labelErr.message}`);
    }

    // Wait for deploy
    console.log(`[poll] Waiting for deploy (${commitSha.slice(0, 7)})...`);
    await waitForDeploy(commitSha);

    // Run commit analysis — maps files → targeted checks → runs everything
    console.log(`[poll] Running commit analysis for ${ticketId} (${filesChanged.length} files)...`);
    const result = await runCommitAnalysis(
      commitSha,
      commitMessage,
      author,
      repo,
      filesChanged as any,
      ticketId,           // posts comment + moves state automatically
      issue.title,        // passed to AI for better test case generation
      issue.description || undefined
    );

    // Slack alert
    const short = commitSha.slice(0, 7);
    const repoName = repo.split('/')[1];
    const commitUrl = `https://github.com/${repo}/commit/${commitSha}`;
    const verdictEmoji = result.verdict === 'pass' ? '✅' : result.verdict === 'fail' ? '❌' : '⚠️';
    const areasSummary = result.analysis.impactAreas.map(a => a.feature).slice(0, 3).join(', ');
    const slackMsg = [
      `${verdictEmoji} *${ticketId}* commit-analysis *${result.verdict.toUpperCase()}*`,
      `Commit: <${commitUrl}|\`${short}\`> on \`${repoName}/${BRANCH}\``,
      `Impact: ${result.analysis.impactAreas.length} area(s) — ${areasSummary || 'none detected'}`,
      `Checks: ${result.domResults.reduce((s, r) => s + r.passed, 0)}✓ DOM, ${result.apiResults.filter(r => r.ok).length}✓ API`,
      `🔗 <${linearUrl}|View in Linear>`,
    ].join('\n');
    await slackAlert(slackMsg);

    console.log(`[poll] ${ticketId} → ${result.verdict} (${result.analysis.impactAreas.length} areas, ${result.analysis.allPages.length} pages)`);
    return { ticketId, verdict: result.verdict, linearUrl, impactAreas: result.analysis.impactAreas.length };

  } catch (err: any) {
    console.error(`[poll] Error processing ${ticketId}:`, err.message);
    await slackAlert(`🚨 QA Shield commit-analysis error for *${ticketId}*: ${err.message}`);
    return { ticketId, verdict: 'error', error: err.message };
  }
}

export async function POST(req: NextRequest) {
  const state = await loadState();
  const results: any[] = [];
  let newCommitsFound = 0;

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
        state.processedTickets[ticketId] = [...processedShas, commit.sha].slice(-20); // keep last 20 SHAs per ticket
        const result = await processCommit(ticketId, commit.sha, commit.message, commit.author, repo, filesChanged);
        results.push({ repo, ...result });
      }
    }
  }

  await saveState(state);

  return NextResponse.json({
    ok: true,
    newCommits: newCommitsFound,
    verified: results.length,
    results,
    timestamp: new Date().toISOString(),
  });
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
