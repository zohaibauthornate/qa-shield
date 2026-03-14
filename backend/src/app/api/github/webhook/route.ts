/**
 * POST /api/github/webhook
 * Receives GitHub push events on the staging branch.
 * For each commit with a CRX-XXX reference, triggers QA Shield verify.
 * Passes → moves ticket to Done. Fails → moves back to Todo + notifies.
 *
 * Setup: set this URL as a GitHub webhook on the creatorfun repos
 * Payload: application/json, events: push
 * Secret: GITHUB_WEBHOOK_SECRET in .env
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { runVerification } from '@/lib/verify-runner';
import { getIssueByIdentifier, addComment, updateIssueState, WORKFLOW_STATES } from '@/lib/linear';

const WATCHED_BRANCH = process.env.GITHUB_BRANCH || 'staging';
const TICKET_REGEX = /\b(CRX-\d+)\b/gi;

// ── Signature verification ──
function verifySignature(body: string, signature: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return true; // skip if not configured
  if (!signature) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ── Extract unique CRX ticket IDs from commit messages ──
function extractTicketIds(commits: Array<{ message: string }>): string[] {
  const seen = new Set<string>();
  for (const commit of commits) {
    const matches = commit.message.matchAll(TICKET_REGEX);
    for (const match of matches) {
      seen.add(match[1].toUpperCase());
    }
  }
  return Array.from(seen);
}

// ── Slack alert helper ──
async function slackAlert(msg: string) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: msg }),
  }).catch(() => {});
}

// ── Background verify runner ──
async function runVerifyForTicket(identifier: string, commitSha: string, repo: string) {
  try {
    const issue = await getIssueByIdentifier(identifier);
    if (!issue) {
      console.log(`[webhook] ${identifier} not found in Linear — skipping`);
      return;
    }

    console.log(`[webhook] Running verify for ${identifier} (commit ${commitSha.slice(0, 7)} on ${repo})`);

    // Give staging a moment to deploy (30s grace period)
    await new Promise(r => setTimeout(r, 30_000));

    const result = await runVerification(issue, { postComment: true, moveToDone: true });

    const verdict = result.verdict;
    const emoji = verdict === 'pass' ? '✅' : verdict === 'fail' ? '❌' : '⚠️';
    const summary = `${emoji} **Commit ${commitSha.slice(0, 7)}** pushed to \`${WATCHED_BRANCH}\` — QA Shield auto-verify: **${verdict.toUpperCase()}**\n` +
      `Passed: ${result.summary.passed} | Failed: ${result.summary.failed} | Warned: ${result.summary.warned}`;

    if (verdict === 'pass' && result.movedToDone) {
      await slackAlert(`✅ ${identifier} auto-verified PASSED after commit ${commitSha.slice(0, 7)} — moved to Done`);
    } else if (verdict === 'fail') {
      // Move back to Todo
      await updateIssueState(issue.id, WORKFLOW_STATES.TODO);
      await addComment(issue.id,
        `❌ **Auto-verify FAILED** after commit \`${commitSha.slice(0, 7)}\` on \`${WATCHED_BRANCH}\`\n\n` +
        `Passed: ${result.summary.passed} | Failed: ${result.summary.failed} | Warned: ${result.summary.warned}\n\n` +
        `Ticket moved back to **Todo** — fix needs review before re-merge.`
      );
      await slackAlert(`❌ ${identifier} auto-verify FAILED after commit ${commitSha.slice(0, 7)} on ${repo} — moved back to Todo`);
    } else {
      // Partial — leave in current state, just comment was posted
      await slackAlert(`⚠️ ${identifier} auto-verify PARTIAL after commit ${commitSha.slice(0, 7)} — needs manual QA review`);
    }

    console.log(`[webhook] ${identifier} verify complete: ${verdict}`);
  } catch (err: any) {
    console.error(`[webhook] Error verifying ${identifier}:`, err.message);
    await slackAlert(`🚨 QA Shield webhook error for ${identifier}: ${err.message}`);
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-hub-signature-256');
  const event = req.headers.get('x-github-event');

  // Verify signature
  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Only handle push events
  if (event !== 'push') {
    return NextResponse.json({ ok: true, message: `Ignoring ${event} event` });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Only watch the configured branch
  const pushedBranch = payload.ref?.replace('refs/heads/', '');
  if (pushedBranch !== WATCHED_BRANCH) {
    return NextResponse.json({ ok: true, message: `Ignoring push to ${pushedBranch}` });
  }

  const commits: Array<{ id: string; message: string }> = payload.commits || [];
  const repo: string = payload.repository?.full_name || 'unknown';
  const ticketIds = extractTicketIds(commits);

  if (ticketIds.length === 0) {
    return NextResponse.json({ ok: true, message: 'No CRX ticket references found in commits' });
  }

  const latestSha: string = payload.after || commits[commits.length - 1]?.id || '';

  console.log(`[webhook] Push to ${repo}/${WATCHED_BRANCH} — tickets: ${ticketIds.join(', ')}`);

  // Fire verifications in the background (non-blocking)
  for (const ticketId of ticketIds) {
    runVerifyForTicket(ticketId, latestSha, repo).catch(console.error);
  }

  return NextResponse.json({
    ok: true,
    branch: WATCHED_BRANCH,
    repo,
    tickets: ticketIds,
    message: `Auto-verify triggered for: ${ticketIds.join(', ')}`,
  });
}

// OPTIONS for CORS preflight
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Signature-256, X-GitHub-Event',
    },
  });
}
