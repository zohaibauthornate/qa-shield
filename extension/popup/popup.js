/**
 * QA Shield — Popup Script v0.5
 * Adds Bulk Verify panel directly in the extension popup.
 */

let API_URL = 'http://localhost:3000';

// ── Load saved state ──
chrome.storage.local.get(['apiUrl', 'stats'], (data) => {
  if (data.apiUrl) {
    API_URL = data.apiUrl;
    document.getElementById('api-url-input').value = API_URL;
  }
  if (data.stats) {
    document.getElementById('scans-count').textContent = data.stats.scans || 0;
    document.getElementById('enriched-count').textContent = data.stats.enriched || 0;
    document.getElementById('issues-count').textContent = data.stats.issues || 0;
  }
  checkHealth();
});

// ── Save API URL on change ──
document.getElementById('api-url-input').addEventListener('change', (e) => {
  API_URL = e.target.value.replace(/\/$/, '');
  chrome.storage.local.set({ apiUrl: API_URL });
  checkHealth();
});

// ── Health Check ──
async function checkHealth() {
  const dot = document.getElementById('health-dot');
  const text = document.getElementById('health-text');
  try {
    const res = await fetch(`${API_URL}/api/monitor/health`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (data.healthy) {
      dot.className = 'status-dot';
      text.textContent = `All systems up (${data.avgResponseTime}ms avg)`;
    } else {
      dot.className = 'status-dot warn';
      text.textContent = 'Some endpoints degraded';
    }
  } catch {
    dot.className = 'status-dot error';
    text.textContent = 'Backend unreachable';
  }
}

function incrementStat(key) {
  chrome.storage.local.get(['stats'], (data) => {
    const stats = data.stats || { scans: 0, enriched: 0, issues: 0 };
    stats[key] = (stats[key] || 0) + 1;
    chrome.storage.local.set({ stats });
    document.getElementById(`${key}-count`).textContent = stats[key];
  });
}

// ── Security Scan ──
document.getElementById('scan-all-btn').addEventListener('click', async () => {
  const btn = document.getElementById('scan-all-btn');
  btn.querySelector('span:last-child').textContent = 'Scanning...';
  btn.disabled = true;
  try {
    const res = await fetch(`${API_URL}/api/security/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    incrementStat('scans');
    const issues = (data.summary?.failed || 0) + (data.summary?.warnings || 0);
    if (issues > 0) incrementStat('issues');
    btn.querySelector('span:last-child').textContent =
      `✅ ${data.summary?.passed || 0} pass  ⚠️ ${data.summary?.warnings || 0} warn  ❌ ${data.summary?.failed || 0} fail`;
  } catch (err) {
    btn.querySelector('span:last-child').textContent = `❌ Failed: ${err.message}`;
  }
  btn.disabled = false;
  setTimeout(() => { btn.querySelector('span:last-child').textContent = 'Run Full Security Scan'; }, 6000);
});

// ── Benchmark ──
document.getElementById('benchmark-btn').addEventListener('click', async () => {
  const btn = document.getElementById('benchmark-btn');
  btn.querySelector('span:last-child').textContent = 'Benchmarking...';
  btn.disabled = true;
  try {
    const res = await fetch(`${API_URL}/api/monitor/health?mode=benchmark`);
    const data = await res.json();
    const verdict = data.frontend?.verdict || 'unknown';
    const delta = data.frontend?.delta || 'N/A';
    btn.querySelector('span:last-child').textContent = `${verdict.toUpperCase()}: ${delta}`;
  } catch {
    btn.querySelector('span:last-child').textContent = '❌ Failed';
  }
  btn.disabled = false;
  setTimeout(() => { btn.querySelector('span:last-child').textContent = 'Performance Benchmark'; }, 6000);
});

// ── Health Button ──
document.getElementById('health-btn').addEventListener('click', checkHealth);

// ═══════════════════════════════════════════════
// BULK VERIFY PANEL
// ═══════════════════════════════════════════════

const mainView = document.getElementById('main-view');
const bulkView = document.getElementById('bulk-view');

let bulkAbortController = null;
let bulkRunning = false;

// Counters
let bsPass = 0, bsFail = 0, bsPartial = 0, bsMoved = 0, bsTotal = 0, bsDone = 0;

// ── Navigation ──
document.getElementById('bulk-verify-open-btn').addEventListener('click', () => {
  mainView.style.display = 'none';
  bulkView.style.display = 'block';
});

document.getElementById('bulk-back-btn').addEventListener('click', () => {
  if (bulkRunning) {
    if (!confirm('Verification is running. Cancel and go back?')) return;
    cancelBulk();
  }
  bulkView.style.display = 'none';
  mainView.style.display = 'block';
});

// ── Reset bulk state ──
function resetBulkState() {
  bsPass = bsFail = bsPartial = bsMoved = bsTotal = bsDone = 0;
  updateBulkSummary();
  document.getElementById('bulk-progress-fill').style.width = '0%';
  document.getElementById('bulk-status-line').textContent = 'Ready to run.';
  document.getElementById('bulk-tickets').innerHTML =
    '<div style="text-align:center;padding:20px;color:#555">Hit "Run" to fetch &amp; verify all In Review tickets</div>';
}

function updateBulkSummary() {
  document.getElementById('bs-pass').textContent = bsPass;
  document.getElementById('bs-fail').textContent = bsFail;
  document.getElementById('bs-partial').textContent = bsPartial;
  document.getElementById('bs-moved').textContent = bsMoved;
}

function updateProgress() {
  if (bsTotal === 0) return;
  const pct = Math.round((bsDone / bsTotal) * 100);
  document.getElementById('bulk-progress-fill').style.width = `${pct}%`;
}

function setStatus(msg) {
  document.getElementById('bulk-status-line').textContent = msg;
}

// ── Ticket row helpers ──
function addTicketRow(identifier, title) {
  const list = document.getElementById('bulk-tickets');

  // Clear placeholder on first add
  if (list.querySelector('[data-placeholder]')) list.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'ticket-row t-pending';
  row.id = `tr-${identifier}`;
  row.innerHTML = `
    <span class="t-icon" id="ti-${identifier}">○</span>
    <span class="t-id">${identifier}</span>
    <span class="t-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
    <span class="t-checks" id="tc-${identifier}"></span>
  `;
  list.appendChild(row);
}

function markTicketRunning(identifier) {
  const row = document.getElementById(`tr-${identifier}`);
  if (!row) return;
  row.className = 'ticket-row t-running';
  document.getElementById(`ti-${identifier}`).innerHTML = '<span class="spin">◌</span>';
}

function markTicketDone(identifier, verdict, summary, movedToDone, error) {
  const row = document.getElementById(`tr-${identifier}`);
  if (!row) return;

  const iconEl = document.getElementById(`ti-${identifier}`);
  const checksEl = document.getElementById(`tc-${identifier}`);

  if (error) {
    row.className = 'ticket-row t-error';
    iconEl.textContent = '⚠️';
    checksEl.textContent = 'err';
    return;
  }

  const icons = { pass: '✅', fail: '❌', partial: '⚠️' };
  const cls   = { pass: 't-pass', fail: 't-fail', partial: 't-partial' };
  row.className = `ticket-row ${cls[verdict] || 't-partial'}`;
  iconEl.textContent = icons[verdict] || '⚠️';

  if (summary) {
    checksEl.textContent = `${summary.passed}✓ ${summary.failed}✗`;
  }

  if (movedToDone) {
    // Add a moved-to-done badge
    const moved = document.createElement('span');
    moved.className = 't-moved';
    moved.textContent = '→ Done';
    row.appendChild(moved);
  }

  // Scroll to latest
  row.scrollIntoView({ block: 'nearest' });
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Cancel ──
function cancelBulk() {
  if (bulkAbortController) {
    bulkAbortController.abort();
    bulkAbortController = null;
  }
  bulkRunning = false;
  document.getElementById('bulk-run-btn').disabled = false;
  document.getElementById('bulk-run-btn').textContent = '▶ Run';
  setStatus('Cancelled.');
}

// ── Run bulk verify ──
document.getElementById('bulk-run-btn').addEventListener('click', async () => {
  if (bulkRunning) {
    cancelBulk();
    return;
  }

  const filter = document.getElementById('bulk-filter').value;
  const btn = document.getElementById('bulk-run-btn');

  resetBulkState();
  bulkRunning = true;
  btn.textContent = '⏹ Stop';
  btn.disabled = false;

  bulkAbortController = new AbortController();

  try {
    const res = await fetch(`${API_URL}/api/verify/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        labelFilter: filter,
        postComment: true,
        moveToDone: true,
        concurrency: 2,
      }),
      signal: bulkAbortController.signal,
    });

    if (!res.ok) {
      setStatus(`❌ Server error: ${res.status}`);
      bulkRunning = false;
      btn.textContent = '▶ Run';
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ') && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6));
            handleBulkEvent(currentEvent, data);
          } catch (e) {
            console.warn('[QA Shield] SSE parse error', e);
          }
          currentEvent = null;
        }
      }
    }

    // Stream finished
    if (bulkRunning) {
      bulkRunning = false;
      btn.textContent = '▶ Run Again';
      btn.disabled = false;
    }

  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus(`❌ Failed: ${err.message}`);
    bulkRunning = false;
    btn.textContent = '▶ Run';
    btn.disabled = false;
  }
});

function handleBulkEvent(event, data) {
  switch (event) {

    case 'status': {
      setStatus(data.message || '');
      if (data.phase === 'starting' && data.tickets) {
        bsTotal = data.total || data.tickets.length;
        // Pre-populate ticket rows
        document.getElementById('bulk-tickets').innerHTML = '';
        for (const t of data.tickets) {
          addTicketRow(t.identifier, t.title);
        }
        setStatus(`${bsTotal} ticket${bsTotal !== 1 ? 's' : ''} found — verifying...`);
      }
      break;
    }

    case 'ticket_start': {
      markTicketRunning(data.identifier);
      setStatus(`Verifying ${data.identifier} (${data.index}/${data.total})...`);
      break;
    }

    case 'ticket_done': {
      bsDone++;
      if (data.verdict === 'pass') bsPass++;
      else if (data.verdict === 'fail') bsFail++;
      else bsPartial++;
      if (data.movedToDone) bsMoved++;

      markTicketDone(data.identifier, data.verdict, data.summary, data.movedToDone, data.error);
      updateBulkSummary();
      updateProgress();
      break;
    }

    case 'complete': {
      const s = data.summary || {};
      setStatus(`Done! ✅ ${s.passed || 0} passed  ❌ ${s.failed || 0} failed  ⚠️ ${s.partial || 0} partial  → ${s.movedToDone || 0} moved to Done`);
      document.getElementById('bulk-progress-fill').style.width = '100%';
      bulkRunning = false;
      document.getElementById('bulk-run-btn').textContent = '▶ Run Again';
      document.getElementById('bulk-run-btn').disabled = false;
      // Update global issues stat
      if (s.failed > 0) incrementStat('issues');
      break;
    }

    case 'error': {
      setStatus(`❌ Error: ${data.message}`);
      bulkRunning = false;
      document.getElementById('bulk-run-btn').textContent = '▶ Run';
      document.getElementById('bulk-run-btn').disabled = false;
      break;
    }
  }
}
