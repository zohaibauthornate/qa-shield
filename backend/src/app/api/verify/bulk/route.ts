/**
 * POST /api/verify/bulk
 * Fetches ALL tickets in the "In Review" column and runs the full verification
 * pipeline on each one — posting a comment and (if passed) moving to Done.
 *
 * Streams SSE events so the UI can show live progress per ticket.
 *
 * Body params:
 *   labelFilter?  : "qa-recheck" | "all"  (default: "all")
 *   postComment?  : boolean               (default: true)
 *   moveToDone?   : boolean               (default: true)
 *   concurrency?  : number                (default: 2 — parallel ticket verifications)
 */

import { NextRequest } from 'next/server';
import { getInReviewTickets, LABELS, type LinearIssue } from '@/lib/linear';
import { runVerification, type VerifyTicketResult } from '@/lib/verify-runner';

export const maxDuration = 300; // 5 min max for bulk runs

export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const {
    labelFilter = 'all',   // "qa-recheck" | "all"
    postComment = true,
    moveToDone = true,
    concurrency = 2,
  } = body;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: any) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // ── Step 1: Fetch In Review tickets ──
        send('status', { phase: 'fetching', message: 'Fetching In Review tickets from Linear...' });

        let tickets: LinearIssue[] = await getInReviewTickets(100);

        // Optional label filter — only QA-ReCheck labelled tickets
        if (labelFilter === 'qa-recheck') {
          tickets = tickets.filter(t =>
            t.labels?.nodes?.some(l => l.id === LABELS.QA_RECHECK || l.name.toLowerCase().includes('recheck'))
          );
        }

        if (tickets.length === 0) {
          send('status', { phase: 'done', message: 'No In Review tickets found.' });
          send('complete', { success: true, total: 0, results: [] });
          controller.close();
          return;
        }

        send('status', {
          phase: 'starting',
          message: `Found ${tickets.length} ticket(s) in In Review${labelFilter === 'qa-recheck' ? ' (QA-ReCheck only)' : ''}. Starting verification...`,
          total: tickets.length,
          tickets: tickets.map(t => ({ identifier: t.identifier, title: t.title })),
        });

        // ── Step 2: Process tickets with concurrency control ──
        const results: VerifyTicketResult[] = [];
        let completed = 0;

        // Chunk tickets into batches of `concurrency`
        for (let i = 0; i < tickets.length; i += concurrency) {
          const batch = tickets.slice(i, i + concurrency);

          // Notify start of each ticket in this batch
          for (const ticket of batch) {
            send('ticket_start', {
              identifier: ticket.identifier,
              title: ticket.title,
              index: i + batch.indexOf(ticket) + 1,
              total: tickets.length,
            });
          }

          // Run batch in parallel
          const batchResults = await Promise.all(
            batch.map(ticket =>
              runVerification(ticket, { postComment, moveToDone })
                .then(result => {
                  completed++;
                  send('ticket_done', {
                    identifier: result.identifier,
                    title: result.title,
                    verdict: result.verdict,
                    summary: result.summary,
                    movedToDone: result.movedToDone,
                    commentPosted: result.commentPosted,
                    error: result.error,
                    progress: { completed, total: tickets.length },
                  });
                  return result;
                })
                .catch(err => {
                  completed++;
                  const errResult: VerifyTicketResult = {
                    identifier: ticket.identifier,
                    title: ticket.title,
                    verdict: 'fail',
                    checks: [],
                    summary: { passed: 0, failed: 0, warned: 0, total: 0 },
                    movedToDone: false,
                    commentPosted: false,
                    error: err.message,
                  };
                  send('ticket_done', { ...errResult, progress: { completed, total: tickets.length } });
                  return errResult;
                })
            )
          );

          results.push(...batchResults);
        }

        // ── Step 3: Final summary ──
        const totalPassed   = results.filter(r => r.verdict === 'pass').length;
        const totalFailed   = results.filter(r => r.verdict === 'fail').length;
        const totalPartial  = results.filter(r => r.verdict === 'partial').length;
        const totalErrors   = results.filter(r => r.error).length;
        const totalMoved    = results.filter(r => r.movedToDone).length;

        send('complete', {
          success: true,
          total: tickets.length,
          summary: {
            passed: totalPassed,
            failed: totalFailed,
            partial: totalPartial,
            errors: totalErrors,
            movedToDone: totalMoved,
          },
          results: results.map(r => ({
            identifier: r.identifier,
            title: r.title,
            verdict: r.verdict,
            movedToDone: r.movedToDone,
            commentPosted: r.commentPosted,
            checks: r.summary,
            error: r.error,
          })),
        });

      } catch (err: any) {
        send('error', { message: err.message });
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

// ── OPTIONS pre-flight for CORS ──
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
