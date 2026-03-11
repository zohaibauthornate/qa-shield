/**
 * POST /api/security/scan — Standalone security scan
 * Scans endpoints, posts security comment to Linear ticket,
 * checks for duplicate tickets, creates new ones with Security label if needed.
 * Returns SSE stream for progressive UI updates.
 */

import { NextRequest, NextResponse } from 'next/server';
import { scanEndpoint } from '@/lib/scanner';
import {
  getIssueByIdentifier,
  addComment,
  findSimilarIssue,
  createIssue,
  LABELS,
} from '@/lib/linear';
import { formatSecurityComment } from '@/lib/ai';

// Sprint 1 Fix: removed 5 non-existent endpoints that were causing false-pass results
// Only real, verified endpoints on dev.bep.creator.fun
const DEFAULT_ENDPOINTS = [
  '/api/token/list?limit=5',
  '/api/token/search?q=test',
  '/api/token?address=Ffyi2x1EoPPsvBkU5siaodMunHniXSfQks9SDvGz83jD',
  '/api/leaderboard',
  '/api/leaderboard/stats',
  '/api/rewards',
];

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { endpoints, baseUrl, identifier, postComment = false } = body;

  const apiBase = baseUrl || process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';
  const endpointsToScan = endpoints || DEFAULT_ENDPOINTS;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: any) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // ── Step 1: Scan endpoints ──
        send('step', { step: 0, status: 'active', label: `Scanning ${endpointsToScan.length} endpoints...` });

        const results = await Promise.all(
          endpointsToScan.map((ep: string) => scanEndpoint(`${apiBase}${ep}`))
        );

        const summary = {
          total: results.length,
          passed: results.filter(r => r.overallStatus === 'pass').length,
          warnings: results.filter(r => r.overallStatus === 'warn').length,
          failed: results.filter(r => r.overallStatus === 'fail').length,
        };

        send('step', { step: 0, status: 'done', label: `Scan: ${summary.passed}✅ ${summary.warnings}⚠️ ${summary.failed}❌` });
        send('security', { summary, results });

        // ── Step 2: Post comment to Linear ──
        send('step', { step: 1, status: 'active', label: 'Posting to Linear...' });
        if (postComment && identifier) {
          try {
            const issue = await getIssueByIdentifier(identifier);
            const secComment = formatSecurityComment(summary, results);
            await addComment(issue.id, secComment);
            send('linear_update', { type: 'security', ticket: identifier, message: 'Security comment posted' });
            send('step', { step: 1, status: 'done', label: 'Comment posted' });
          } catch (e) {
            console.error('Failed to post security comment:', e);
            send('step', { step: 1, status: 'error', label: 'Failed to post comment' });
          }
        } else {
          send('step', { step: 1, status: 'done', label: 'No ticket selected — skipped' });
        }

        // ── Step 3: Check for duplicates / create new tickets ──
        // Sprint 1 Fix: deduplicate by (check_type, endpoint_path) hash — not fuzzy title match.
        // Old approach created 10 duplicate CORS tickets (CRX-871–880). This prevents that.
        send('step', { step: 2, status: 'active', label: 'Checking for duplicate tickets...' });

        const createdTickets: any[] = [];
        const existingTickets: any[] = [];

        // Build findings list — one entry per (check_type × endpoint_path), severity critical or high only
        const criticalFindings = results
          .filter(r => r.overallStatus === 'fail')
          .flatMap(r => {
            const epPath = r.endpoint.replace(/^https?:\/\/[^/]+/, '');
            return r.checks
              .filter((c: any) => c.status === 'fail' && (c.severity === 'critical' || c.severity === 'high'))
              .map((c: any) => ({
                // Dedup key: stable identifier per finding type + endpoint path
                dedupKey: `${c.type}:${epPath.split('?')[0]}`,
                title: `[Security][${c.severity.charAt(0).toUpperCase() + c.severity.slice(1)}] ${c.type.toUpperCase()} issue on ${epPath.split('?')[0]}`,
                description: `## Security Finding\n\n**Endpoint:** \`${r.endpoint}\`\n**Check:** \`${c.type}\`\n**Severity:** ${c.severity.toUpperCase()}\n**Details:** ${c.details}\n\n---\n_Auto-created by QA Shield 🛡️_`,
                detail: c.details,
                checkType: c.type,
                endpointPath: epPath.split('?')[0],
              }));
          });

        // Sprint 1 Fix: deduplicate within this session by dedupKey first
        const seenKeys = new Set<string>();
        const uniqueFindings = criticalFindings.filter(f => {
          if (seenKeys.has(f.dedupKey)) return false;
          seenKeys.add(f.dedupKey);
          return true;
        });

        for (const finding of uniqueFindings) {
          // Search for existing ticket by check_type + endpoint_path keywords (not fuzzy title)
          const searchQuery = `${finding.checkType} ${finding.endpointPath}`;
          const existing = await findSimilarIssue(searchQuery);
          if (existing) {
            existingTickets.push({
              identifier: existing.identifier,
              title: existing.title,
              url: existing.url,
              matchedFor: finding.detail,
            });
            send('existing_ticket', {
              identifier: existing.identifier,
              title: existing.title,
              url: existing.url,
              matchedFor: finding.detail,
            });
          } else {
            try {
              const created = await createIssue({
                title: finding.title,
                description: finding.description,
                priority: 2,
                labelIds: [LABELS.SECURITY, LABELS.BUG],
              });
              createdTickets.push({
                identifier: created.identifier,
                title: created.title,
                url: created.url,
              });
              send('new_ticket', {
                identifier: created.identifier,
                title: created.title,
                url: created.url,
              });
            } catch (e) {
              console.error('Failed to create security ticket:', e);
            }
          }
        }

        send('step', { step: 2, status: 'done', label: `${createdTickets.length} new, ${existingTickets.length} existing (${uniqueFindings.length} unique findings)` });

        send('complete', {
          success: true,
          summary,
          results,
          createdTickets,
          existingTickets,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send('error', { message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// GET: Quick scan of default endpoints (non-streaming, no ticket creation)
export async function GET() {
  const apiBase = process.env.STAGING_API_URL || 'https://dev.bep.creator.fun';

  const results = await Promise.all(
    DEFAULT_ENDPOINTS.slice(0, 6).map(ep => scanEndpoint(`${apiBase}${ep}`))
  );

  return NextResponse.json({
    success: true,
    results,
    scannedAt: new Date().toISOString(),
  });
}
