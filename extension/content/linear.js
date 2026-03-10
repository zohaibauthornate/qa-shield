/**
 * QA Shield v0.3 — Linear Content Script
 * SSE streaming for real-time updates, ticket ID tracking, security labels
 */

const QA_SHIELD_API = 'http://localhost:3000';

// ============ Issue Detection ============

function getIssueIdentifier() {
  const match = window.location.pathname.match(/\/issue\/(CRX-\d+)/);
  return match ? match[1] : null;
}

// ============ Sidebar UI ============

function createSidebar() {
  if (document.getElementById('qa-shield-sidebar')) return;

  const sidebar = document.createElement('div');
  sidebar.id = 'qa-shield-sidebar';
  sidebar.innerHTML = `
    <div class="qs-header">
      <span class="qs-logo">🛡️</span>
      <span class="qs-title">QA Shield</span>
      <span class="qs-version">v0.3</span>
      <button class="qs-close" id="qs-close-btn">×</button>
    </div>
    <div class="qs-content" id="qs-content">
      <div class="qs-welcome" id="qs-welcome">
        <p class="qs-muted">Select an action below to begin.</p>
      </div>
      <div class="qs-progress" id="qs-progress" style="display:none">
        <div class="qs-progress-bar">
          <div class="qs-progress-fill" id="qs-progress-fill"></div>
        </div>
        <div class="qs-steps" id="qs-steps"></div>
        <div class="qs-live-updates" id="qs-live-updates"></div>
        <div class="qs-elapsed" id="qs-elapsed"></div>
      </div>
      <div class="qs-results" id="qs-results" style="display:none"></div>
    </div>
    <div class="qs-actions">
      <button class="qs-btn qs-btn-primary" id="qs-enrich-btn">🔍 Enrich Ticket</button>
      <button class="qs-btn qs-btn-secondary" id="qs-verify-btn">✅ Verify Fix</button>
      <button class="qs-btn qs-btn-warn" id="qs-security-btn">🔒 Security Scan</button>
      <button class="qs-btn qs-btn-info" id="qs-benchmark-btn">⚡ Benchmark</button>
    </div>
  `;

  document.body.appendChild(sidebar);

  // Minimize/restore on close button click
  document.getElementById('qs-close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.add('qs-collapsed');
  });

  // Restore on clicking the collapsed pill
  sidebar.addEventListener('click', (e) => {
    if (sidebar.classList.contains('qs-collapsed')) {
      sidebar.classList.remove('qs-collapsed');
    }
  });

  // Drag support — move the panel by dragging the header
  makeDraggable(sidebar, sidebar.querySelector('.qs-header'));

  document.getElementById('qs-enrich-btn').addEventListener('click', enrichTicket);
  document.getElementById('qs-verify-btn').addEventListener('click', verifyFix);
  document.getElementById('qs-security-btn').addEventListener('click', runSecurityScan);
  document.getElementById('qs-benchmark-btn').addEventListener('click', runBenchmark);
}

// ============ Progress System ============

let progressTimer = null;
let progressStart = null;

function showProgress(steps) {
  const welcome = document.getElementById('qs-welcome');
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');

  welcome.style.display = 'none';
  progress.style.display = 'block';
  results.style.display = 'none';

  const stepsEl = document.getElementById('qs-steps');
  stepsEl.innerHTML = steps.map((step, i) => `
    <div class="qs-step" id="qs-step-${i}" data-status="pending">
      <span class="qs-step-icon">○</span>
      <span class="qs-step-text">${step}</span>
    </div>
  `).join('');

  // Clear live updates area
  const liveUpdates = document.getElementById('qs-live-updates');
  liveUpdates.innerHTML = '';

  document.getElementById('qs-progress-fill').style.width = '0%';

  progressStart = Date.now();
  const elapsedEl = document.getElementById('qs-elapsed');
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - progressStart) / 1000);
    elapsedEl.textContent = `⏱️ ${elapsed}s elapsed`;
  }, 1000);

  setButtonsDisabled(true);
}

function updateStep(index, status, label) {
  const step = document.getElementById(`qs-step-${index}`);
  if (!step) return;

  step.dataset.status = status;
  const icon = step.querySelector('.qs-step-icon');
  const text = step.querySelector('.qs-step-text');

  if (status === 'active') icon.textContent = '◉';
  else if (status === 'done') icon.textContent = '✓';
  else if (status === 'error') icon.textContent = '✗';
  else icon.textContent = '○';

  if (label) text.textContent = label;

  // Update progress bar
  const allSteps = document.querySelectorAll('.qs-step');
  const doneCount = document.querySelectorAll('.qs-step[data-status="done"]').length;
  const activeCount = document.querySelectorAll('.qs-step[data-status="active"]').length;
  const total = allSteps.length;
  const pct = Math.round(((doneCount + activeCount * 0.5) / total) * 100);
  document.getElementById('qs-progress-fill').style.width = `${pct}%`;
}

function addLiveUpdate(html) {
  const el = document.getElementById('qs-live-updates');
  const item = document.createElement('div');
  item.className = 'qs-live-item';
  item.innerHTML = html;
  el.appendChild(item);
  el.scrollTop = el.scrollHeight;
}

function finishProgress() {
  clearInterval(progressTimer);
  document.getElementById('qs-progress-fill').style.width = '100%';
  setButtonsDisabled(false);
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll('.qs-btn').forEach(btn => {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? '0.5' : '1';
    btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
  });
}

// ============ Generic SSE Stream Consumer ============

async function consumeSSEStream(url, method, body, steps, onComplete) {
  showProgress(steps);

  const finalData = { existingTickets: [], newTickets: [], result: null };

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ') && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6));

            switch (currentEvent) {
              case 'step':
                updateStep(data.step, data.status, data.label || data.detail);
                break;
              case 'linear_update':
                addLiveUpdate(`<span class="qs-live-badge qs-live-${data.type}">📝 Linear</span> ${data.message}`);
                break;
              case 'check': {
                const icon = data.status === 'pass' ? '✅' : data.status === 'fail' ? '❌' : '⚠️';
                addLiveUpdate(`${icon} <strong>${data.name}</strong> <span class="qs-muted">${(data.details || '').substring(0, 60)}</span>`);
                break;
              }
              case 'plan':
                addLiveUpdate(`<span class="qs-live-badge qs-live-verification">📋 Plan</span> ${data.reasoning || ''}`);
                break;
              case 'existing_ticket':
                finalData.existingTickets.push(data);
                addLiveUpdate(
                  `<span class="qs-live-badge qs-live-existing">📋 Exists</span> ` +
                  `<a href="${data.url}" target="_blank" class="qs-ticket-link">${data.identifier}</a> — ${data.title}`
                );
                break;
              case 'new_ticket':
                finalData.newTickets.push(data);
                addLiveUpdate(
                  `<span class="qs-live-badge qs-live-new">🆕 Created</span> ` +
                  `<a href="${data.url}" target="_blank" class="qs-ticket-link">${data.identifier}</a> — ${data.title}`
                );
                break;
              case 'complete':
                finalData.result = data;
                break;
              case 'error':
                showError(data.message);
                break;
            }
          } catch (e) {
            console.warn('[QA Shield] SSE parse error:', e);
          }
          currentEvent = null;
        }
      }
    }

    finishProgress();

    if (finalData.result) {
      onComplete(finalData);
    } else {
      showError('No data received from server');
    }
  } catch (err) {
    finishProgress();
    showError(`Failed: ${err.message}`);
  }
}

// ============ Verify Fix (pure ticket scope — no security/perf) ============

async function verifyFix() {
  const identifier = getIssueIdentifier();
  if (!identifier) return showError('Could not detect ticket ID');

  await consumeSSEStream(
    `${QA_SHIELD_API}/api/verify`,
    'POST',
    { identifier, postComment: true },
    [
      'Fetching ticket...',
      'Building verification plan...',
      'Running API checks...',
      'Inspecting DOM...',
      'Testing transactions...',
      'Computing verdict...',
    ],
    (finalData) => {
      showVerifyFixResults(finalData.result);
    }
  );
}

// ============ Security Scan (standalone) ============

async function runSecurityScan() {
  const identifier = getIssueIdentifier();

  await consumeSSEStream(
    `${QA_SHIELD_API}/api/security/scan`,
    'POST',
    { identifier, postComment: !!identifier },
    [
      'Scanning API endpoints...',
      'Posting to Linear...',
      'Checking for duplicate tickets...',
    ],
    (finalData) => {
      showSecurityResults(finalData.result, finalData.existingTickets, finalData.newTickets);
    }
  );
}

// ============ Performance Benchmark (standalone) ============

async function runBenchmark() {
  const identifier = getIssueIdentifier();

  await consumeSSEStream(
    `${QA_SHIELD_API}/api/monitor/health`,
    'POST',
    { identifier, postComment: !!identifier },
    [
      'Benchmarking creator.fun...',
      'Benchmarking competitors...',
      'Posting to Linear...',
      'Checking for performance issues...',
    ],
    (finalData) => {
      showBenchmarkResults(finalData.result, finalData.existingTickets, finalData.newTickets);
    }
  );
}

// ============ Enrich Ticket (non-streaming) ============

async function enrichTicket() {
  const identifier = getIssueIdentifier();
  if (!identifier) return showError('Could not detect ticket ID');

  const steps = [
    'Fetching ticket details...',
    'Analyzing issue context...',
    'Generating QA report...',
    'Posting to Linear...',
  ];
  showProgress(steps);

  try {
    updateStep(0, 'active');
    await sleep(300);
    updateStep(0, 'done');

    updateStep(1, 'active');
    const res = await fetch(`${QA_SHIELD_API}/api/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, postComment: true }),
    });

    updateStep(1, 'done');
    updateStep(2, 'active');
    await sleep(200);

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    updateStep(2, 'done');
    updateStep(3, 'active');
    await sleep(200);
    updateStep(3, 'done');
    finishProgress();

    showEnrichmentResults(data.enrichment, data.commentPosted);
  } catch (err) {
    finishProgress();
    showError(`Enrichment failed: ${err.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ Result Renderers ============

function showError(msg) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  const welcome = document.getElementById('qs-welcome');
  progress.style.display = 'none';
  welcome.style.display = 'none';
  results.style.display = 'block';
  results.innerHTML = `<div class="qs-error">❌ ${msg}</div>`;
}

function showEnrichmentResults(enrichment, commentPosted) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  progress.style.display = 'none';
  results.style.display = 'block';

  const e = enrichment;
  const sevColors = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' };
  const typeEmojis = { bug: '🐛', improvement: '✨', feature: '🆕', refactor: '🔧', hotfix: '🚨' };

  results.innerHTML = `
    <div class="qs-section">
      <div class="qs-verdict-banner qs-verdict-${e.classification?.type || 'bug'}">
        <span class="qs-verdict-icon">${typeEmojis[e.classification?.type] || '📋'}</span>
        <span class="qs-verdict-label">${(e.classification?.type || 'UNKNOWN').toUpperCase()}</span>
        <span class="qs-tag" style="background:${sevColors[e.impact?.severity] || '#666'}">${(e.impact?.severity || 'unknown').toUpperCase()}</span>
      </div>
      <p class="qs-classification-reason">${e.classification?.reasoning || ''}</p>
    </div>

    <div class="qs-section">
      <h3>🔍 What Went Wrong</h3>
      <p>${e.whatWentWrong?.summary || 'N/A'}</p>
      <div class="qs-detail-grid">
        <div class="qs-detail-item"><span class="qs-detail-label">Root Cause</span><span>${e.whatWentWrong?.rootCause || 'N/A'}</span></div>
        <div class="qs-detail-item"><span class="qs-detail-label">Component</span><span class="qs-code">${e.whatWentWrong?.component || 'N/A'}</span></div>
        <div class="qs-detail-item"><span class="qs-detail-label">Category</span><span>${e.whatWentWrong?.category || 'N/A'}</span></div>
      </div>
    </div>

    <div class="qs-section">
      <h3>📐 Impact & Scope</h3>
      <p>${e.impact?.scope || 'N/A'}</p>
      <p class="qs-muted">Affected: ${e.impact?.affectedUsers || 'Unknown'}</p>
      ${e.impact?.financialImpact ? '<div class="qs-alert">⚠️ Financial Impact</div>' : ''}
      ${e.impact?.securityImpact ? '<div class="qs-alert qs-alert-danger">🔴 Security Impact</div>' : ''}
    </div>

    <div class="qs-section">
      <h3>🔄 Steps to Reproduce</h3>
      <ol class="qs-tc-steps">
        ${(e.stepsToReproduce || []).map(s => `<li>${s}</li>`).join('')}
      </ol>
      <div class="qs-expected-actual">
        <div><strong>Expected:</strong> ${e.expectedBehavior || 'N/A'}</div>
        <div><strong>Actual:</strong> ${e.actualBehavior || 'N/A'}</div>
      </div>
    </div>

    <div class="qs-section">
      <h3>🛠️ Recommended Fix</h3>
      <p>${e.recommendedFix?.approach || 'N/A'}</p>
      ${(e.recommendedFix?.filesLikelyInvolved || []).length > 0 ? `<p class="qs-muted">Files: ${e.recommendedFix.filesLikelyInvolved.map(f => `<code>${f}</code>`).join(', ')}</p>` : ''}
      <p class="qs-muted">Effort: ${e.recommendedFix?.estimatedEffort || 'unknown'}</p>
    </div>

    <div class="qs-section">
      <h3>✅ Test Cases (${(e.testCases || []).length})</h3>
      ${(e.testCases || []).map(tc => `
        <div class="qs-test-case">
          <div class="qs-tc-header">
            <span class="qs-tc-badge qs-tc-${tc.priority || 'should'}">${(tc.priority || 'should').toUpperCase()}</span>
            <strong>${tc.id || ''}: ${tc.title || ''}</strong>
          </div>
          <ol class="qs-tc-steps">${(tc.steps || []).map(s => `<li>${s}</li>`).join('')}</ol>
          <div class="qs-tc-expected">Expected: ${tc.expected || 'N/A'}</div>
        </div>
      `).join('')}
    </div>

    <div class="qs-section">
      <h3>⚡ Edge Cases (${(e.edgeCases || []).length})</h3>
      ${(e.edgeCases || []).map(ec => `
        <div class="qs-edge-case">
          <span class="qs-tag qs-tag-${ec.risk || 'medium'}">${(ec.risk || 'medium').toUpperCase()}</span>
          <strong>${ec.scenario || ''}</strong>
          <p class="qs-hint">→ ${ec.howToTest || ''}</p>
        </div>
      `).join('')}
    </div>

    ${(e.postFixVerification || []).length > 0 ? `
    <div class="qs-section">
      <h3>🔎 Post-Fix Checklist</h3>
      ${e.postFixVerification.map(item => `<div class="qs-impact-item">☐ ${item}</div>`).join('')}
    </div>` : ''}

    ${commentPosted ? '<div class="qs-success">✅ Analysis posted to Linear ticket</div>' : ''}
  `;
}

// ── Verify Fix Results (real browser + API testing) ──

function showVerifyFixResults(data) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  progress.style.display = 'none';
  results.style.display = 'block';

  if (!data) {
    results.innerHTML = '<div class="qs-error">No verification data returned</div>';
    return;
  }

  const verdict = data.verdict || 'partial';
  const verdictIcon = verdict === 'pass' ? '✅' : verdict === 'fail' ? '❌' : '⚠️';
  const verdictClass = verdict === 'pass' ? 'pass' : verdict === 'fail' ? 'fail' : 'partial';
  const verdictText = verdict === 'pass' ? 'PASSED → Done' : verdict === 'fail' ? 'FAILED' : 'PARTIAL';
  const s = data.summary || {};

  let html = `
    <div class="qs-verdict-banner qs-verdict-${verdictClass}">
      <span class="qs-verdict-icon">${verdictIcon}</span>
      <span class="qs-verdict-label">${verdictText}</span>
    </div>
    <div class="qs-summary-grid" style="margin:8px 0">
      <div class="qs-summary-item"><span class="qs-big-num">${s.passed || 0}</span><span>Passed</span></div>
      <div class="qs-summary-item"><span class="qs-big-num qs-red">${s.failed || 0}</span><span>Failed</span></div>
      <div class="qs-summary-item"><span class="qs-big-num qs-yellow">${s.warned || 0}</span><span>Warn</span></div>
    </div>
  `;

  if (data.movedToDone) {
    html += `<div class="qs-success" style="margin-bottom:12px">✅ <strong>${data.identifier}</strong> moved to Done</div>`;
  }

  // Group checks by status
  const checks = data.checks || [];
  const passed = checks.filter(c => c.status === 'pass');
  const failed = checks.filter(c => c.status === 'fail');
  const warned = checks.filter(c => c.status === 'warn');

  if (failed.length > 0) {
    html += `<div class="qs-section"><h3>❌ Failed (${failed.length})</h3>`;
    failed.forEach(c => {
      html += `<div class="qs-test-case" style="border-left:3px solid #ef4444;padding-left:8px">
        <strong>${c.name}</strong><p class="qs-hint" style="color:#ef4444">${c.details || ''}</p></div>`;
    });
    html += `</div>`;
  }

  if (passed.length > 0) {
    html += `<div class="qs-section"><h3>✅ Passed (${passed.length})</h3>`;
    passed.forEach(c => {
      html += `<div class="qs-impact-item">✅ <strong>${c.name}</strong> — ${(c.details || '').substring(0, 80)}</div>`;
    });
    html += `</div>`;
  }

  if (warned.length > 0) {
    html += `<div class="qs-section"><h3>⚠️ Warnings (${warned.length})</h3>`;
    warned.forEach(c => {
      html += `<div class="qs-impact-item">⚠️ <strong>${c.name}</strong> — ${c.details || ''}</div>`;
    });
    html += `</div>`;
  }

  html += `<div class="qs-success">✅ Real verification posted to Linear (browser + API)</div>`;
  results.innerHTML = html;
}

// ── Security Results (with ticket tracking) ──

function showSecurityResults(data, existingTickets, newTickets) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  progress.style.display = 'none';
  results.style.display = 'block';

  const s = data.summary || {};
  let html = `
    <div class="qs-section">
      <h3>🔒 Security Scan Results</h3>
      <div class="qs-summary-grid">
        <div class="qs-summary-item"><span class="qs-big-num">${s.passed || 0}</span><span>Passed</span></div>
        <div class="qs-summary-item"><span class="qs-big-num qs-yellow">${s.warnings || 0}</span><span>Warnings</span></div>
        <div class="qs-summary-item"><span class="qs-big-num qs-red">${s.failed || 0}</span><span>Failed</span></div>
      </div>
    </div>
  `;

  if (data.results) {
    data.results.forEach(r => {
      const icon = r.overallStatus === 'pass' ? '✅' : r.overallStatus === 'fail' ? '❌' : '⚠️';
      const ep = r.endpoint.split('/api')[1] || r.endpoint;
      html += `<div class="qs-section qs-scan-${r.overallStatus}"><h4>${icon} /api${ep}</h4>`;
      r.checks.forEach(c => {
        html += `<div class="qs-check-row">
          <span class="qs-check-type">${c.type}</span>
          <span class="qs-check-status qs-status-${c.status}">${c.status}</span>
          <span class="qs-check-detail">${c.details}</span>
        </div>`;
      });
      html += `</div>`;
    });
  }

  html += renderTicketSection(existingTickets, newTickets, '🔒 Security');
  html += `<div class="qs-success">✅ Security comment posted to Linear</div>`;
  results.innerHTML = html;
}

// ── Benchmark Results (with ticket tracking) ──

function showBenchmarkResults(data, existingTickets, newTickets) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  progress.style.display = 'none';
  results.style.display = 'block';

  const b = data.benchmark || {};
  let html = `
    <div class="qs-section">
      <h3>⚡ Performance Benchmark</h3>
      <div class="qs-benchmark-card">
        <div class="qs-benchmark-row"><strong>Platform</strong><strong>Response</strong><strong>TTFB</strong></div>
        <div class="qs-benchmark-row">
          <span>🟢 creator.fun</span>
          <span>${b.ours?.responseTime || 'N/A'}ms</span>
          <span>${b.ours?.ttfb || 'N/A'}ms</span>
        </div>
        <div class="qs-benchmark-row">
          <span>axiom.trade</span>
          <span>${b.axiom?.responseTime || 'N/A'}ms</span>
          <span>${b.axiom?.ttfb || 'N/A'}ms</span>
        </div>
        <div class="qs-benchmark-row">
          <span>pump.fun</span>
          <span>${b.pump?.responseTime || 'N/A'}ms</span>
          <span>${b.pump?.ttfb || 'N/A'}ms</span>
        </div>
      </div>
    </div>
  `;

  html += renderTicketSection(existingTickets, newTickets, '⚡ Performance');
  html += `<div class="qs-success">✅ Performance comment posted to Linear</div>`;
  results.innerHTML = html;
}

// ── Shared: Render ticket tracking section ──

function renderTicketSection(existingTickets, newTickets, label) {
  if (!existingTickets?.length && !newTickets?.length) return '';

  let html = `<div class="qs-section"><h3>🎫 ${label} Tickets</h3>`;

  if (existingTickets?.length > 0) {
    html += `<div class="qs-ticket-group"><h4>📋 Already Reported</h4>`;
    existingTickets.forEach(t => {
      html += `
        <div class="qs-ticket-row qs-ticket-existing">
          <a href="${t.url}" target="_blank" class="qs-ticket-id">${t.identifier}</a>
          <span class="qs-ticket-title">${t.title}</span>
          <span class="qs-ticket-match">↳ ${t.matchedFor || ''}</span>
        </div>`;
    });
    html += `</div>`;
  }

  if (newTickets?.length > 0) {
    html += `<div class="qs-ticket-group"><h4>🆕 Newly Created</h4>`;
    newTickets.forEach(t => {
      html += `
        <div class="qs-ticket-row qs-ticket-new">
          <a href="${t.url}" target="_blank" class="qs-ticket-id">${t.identifier}</a>
          <span class="qs-ticket-title">${t.title}</span>
          <span class="qs-ticket-label">${label.includes('Security') ? '🔒 Security' : '⚡ Performance'}</span>
        </div>`;
    });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ============ Drag Support (GPU-accelerated) ============

function makeDraggable(element, handle) {
  let startX, startY, origX, origY, raf;
  let moved = false;

  // Use transform for GPU-accelerated movement
  element.style.willChange = 'transform';

  handle.addEventListener('mousedown', (e) => {
    if (element.classList.contains('qs-collapsed')) return;
    if (e.target.closest('.qs-close')) return;

    moved = false;
    startX = e.clientX;
    startY = e.clientY;

    const rect = element.getBoundingClientRect();
    origX = rect.left;
    origY = rect.top;

    // Switch to absolute positioning on first drag
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.left = origX + 'px';
    element.style.top = origY + 'px';

    handle.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  function onMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      element.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    });
  }

  function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    cancelAnimationFrame(raf);
    handle.style.cursor = 'grab';

    if (moved) {
      // Bake the transform into left/top
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newX = Math.max(0, Math.min(origX + dx, window.innerWidth - 100));
      const newY = Math.max(0, Math.min(origY + dy, window.innerHeight - 60));
      element.style.left = newX + 'px';
      element.style.top = newY + 'px';
      element.style.transform = '';
    }
  }
}

// ============ Initialize ============

function init() {
  const identifier = getIssueIdentifier();
  if (identifier) {
    createSidebar();
    console.log(`[QA Shield] 🛡️ v0.3 Active on ${identifier}`);
  }
}

let lastUrl = window.location.href;
new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    const existing = document.getElementById('qa-shield-sidebar');
    if (existing) existing.remove();
    clearInterval(progressTimer);
    init();
  }
}).observe(document.body, { childList: true, subtree: true });

init();
