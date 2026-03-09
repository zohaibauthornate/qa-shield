/**
 * QA Shield v0.2 — Linear Content Script
 * Multi-step loading, precision enrichment, clean verification
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
      <span class="qs-version">v0.2</span>
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

  document.getElementById('qs-close-btn').addEventListener('click', () => {
    sidebar.classList.toggle('qs-collapsed');
  });

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

  document.getElementById('qs-progress-fill').style.width = '0%';

  // Start elapsed timer
  progressStart = Date.now();
  const elapsedEl = document.getElementById('qs-elapsed');
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - progressStart) / 1000);
    elapsedEl.textContent = `⏱️ ${elapsed}s elapsed`;
  }, 1000);

  // Disable buttons during operation
  setButtonsDisabled(true);
}

function updateStep(index, status) {
  const step = document.getElementById(`qs-step-${index}`);
  if (!step) return;

  step.dataset.status = status;
  const icon = step.querySelector('.qs-step-icon');

  if (status === 'active') icon.textContent = '◉';
  else if (status === 'done') icon.textContent = '✓';
  else if (status === 'error') icon.textContent = '✗';
  else icon.textContent = '○';

  // Update progress bar
  const allSteps = document.querySelectorAll('.qs-step');
  const doneCount = document.querySelectorAll('.qs-step[data-status="done"]').length;
  const activeCount = document.querySelectorAll('.qs-step[data-status="active"]').length;
  const total = allSteps.length;
  const pct = Math.round(((doneCount + activeCount * 0.5) / total) * 100);
  document.getElementById('qs-progress-fill').style.width = `${pct}%`;
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

// ============ API Calls ============

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
    // Small delay to show the step transition
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

async function verifyFix() {
  const identifier = getIssueIdentifier();
  if (!identifier) return showError('Could not detect ticket ID');

  const steps = [
    'Fetching ticket details...',
    'Running fix verification...',
    'Scanning security...',
    'Benchmarking performance...',
    'Posting results to Linear...',
  ];
  showProgress(steps);

  try {
    updateStep(0, 'active');
    await sleep(300);
    updateStep(0, 'done');

    updateStep(1, 'active');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    const res = await fetch(`${QA_SHIELD_API}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, postComment: true }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    updateStep(1, 'done');
    updateStep(2, 'done');
    updateStep(3, 'done');
    updateStep(4, 'active');
    await sleep(200);

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    updateStep(4, 'done');
    finishProgress();

    showVerificationResults(data);
  } catch (err) {
    finishProgress();
    if (err.name === 'AbortError') {
      showError('Verification timed out (>3 min). Check the Linear ticket for partial results.');
    } else {
      showError(`Verification failed: ${err.message}`);
    }
  }
}

async function runSecurityScan() {
  const identifier = getIssueIdentifier();
  const steps = ['Scanning API endpoints...', 'Analyzing results...', 'Posting to Linear...'];
  showProgress(steps);

  try {
    updateStep(0, 'active');
    const res = await fetch(`${QA_SHIELD_API}/api/security/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, postComment: true }),
    });

    updateStep(0, 'done');
    updateStep(1, 'active');
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    updateStep(1, 'done');
    updateStep(2, 'done');
    finishProgress();

    showSecurityResults(data);
  } catch (err) {
    finishProgress();
    showError(`Security scan failed: ${err.message}`);
  }
}

async function runBenchmark() {
  const steps = ['Measuring creator.fun...', 'Measuring competitors...', 'Comparing results...'];
  showProgress(steps);

  try {
    updateStep(0, 'active');
    const res = await fetch(`${QA_SHIELD_API}/api/monitor/health?mode=benchmark`);

    updateStep(0, 'done');
    updateStep(1, 'done');
    updateStep(2, 'active');
    const data = await res.json();

    updateStep(2, 'done');
    finishProgress();

    showBenchmarkResults(data);
  } catch (err) {
    finishProgress();
    showError(`Benchmark failed: ${err.message}`);
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

function showVerificationResults(data) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  progress.style.display = 'none';
  results.style.display = 'block';

  const v = data.verification;
  if (!v) {
    results.innerHTML = '<div class="qs-error">No verification data returned</div>';
    return;
  }

  const verdictIcon = v.overallVerdict === 'pass' ? '✅' : v.overallVerdict === 'fail' ? '❌' : '⚠️';
  const verdictClass = v.overallVerdict === 'pass' ? 'pass' : v.overallVerdict === 'fail' ? 'fail' : 'partial';
  const verdictText = v.overallVerdict === 'pass' ? 'VERIFICATION PASSED' : v.overallVerdict === 'fail' ? 'VERIFICATION FAILED' : 'PARTIAL VERIFICATION';

  let html = `
    <div class="qs-verdict-banner qs-verdict-${verdictClass}">
      <span class="qs-verdict-icon">${verdictIcon}</span>
      <span class="qs-verdict-label">${verdictText}</span>
    </div>
    <p class="qs-verdict-summary">${v.verdictSummary || ''}</p>
  `;

  // Fix Verification
  const fv = v.fixVerification || {};
  if (fv.stepsExecuted && fv.stepsExecuted.length > 0) {
    html += `<div class="qs-section"><h3>📋 Fix Verification</h3>`;
    fv.stepsExecuted.forEach(s => {
      const icon = s.status === 'pass' ? '✅' : s.status === 'fail' ? '❌' : s.status === 'skip' ? '⏭️' : '⚠️';
      html += `<div class="qs-test-case"><strong>${icon} ${s.name}</strong><p class="qs-hint">${s.details || ''}</p></div>`;
    });
    html += `</div>`;
  }

  // Passed
  if (fv.passed && fv.passed.length > 0) {
    html += `<div class="qs-section"><h3>✅ Passed</h3>`;
    fv.passed.forEach(p => { html += `<div class="qs-impact-item">✅ ${p}</div>`; });
    html += `</div>`;
  }

  // Failed
  if (fv.failed && fv.failed.length > 0) {
    html += `<div class="qs-section"><h3>❌ Failed</h3>`;
    fv.failed.forEach(f => {
      html += `<div class="qs-test-case" style="border-left:3px solid #ef4444;padding-left:8px">
        <strong>${f.test}</strong><p class="qs-hint" style="color:#ef4444">→ ${f.reason}</p></div>`;
    });
    html += `</div>`;
  }

  // Cannot Test
  if (fv.cannotTest && fv.cannotTest.length > 0) {
    html += `<div class="qs-section"><h3>🔒 Cannot Test</h3>`;
    fv.cannotTest.forEach(c => {
      html += `<div class="qs-impact-item">🔒 <strong>${c.area}</strong>: ${c.constraint}</div>`;
    });
    html += `</div>`;
  }

  // Sanity Checks
  const sc = v.sanityChecks;
  if (sc && sc.checks && sc.checks.length > 0) {
    html += `<div class="qs-section"><h3>🧪 Sanity Checks</h3>`;
    sc.checks.forEach(check => {
      const icon = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⚠️';
      html += `<div class="qs-impact-item">${icon} <strong>${check.name}</strong>: ${check.details}</div>`;
    });
    html += `</div>`;
  }

  // Regression Risk
  if (v.regressionRisk) {
    const riskLevel = v.regressionRisk.level || 'low';
    const riskColor = riskLevel === 'high' ? '#ef4444' : riskLevel === 'medium' ? '#eab308' : '#22c55e';
    html += `<div class="qs-section"><h3>🎯 Regression Risk: <span style="color:${riskColor}">${riskLevel.toUpperCase()}</span></h3>`;
    html += `<p class="qs-hint">${v.regressionRisk.recommendation || ''}</p></div>`;
  }

  // Security & Performance summaries (compact since separate comments exist)
  const sec = data.security?.summary || {};
  html += `<div class="qs-section qs-compact">
    <span>🔒 Security: ${sec.passed || 0}✅ ${sec.warnings || 0}⚠️ ${sec.failed || 0}❌</span>
    <span class="qs-muted"> · ⚡ Performance: ${data.benchmark?.ours?.responseTime || 'N/A'}ms</span>
  </div>`;

  // Posted comments
  if (data.postedComments && data.postedComments.length > 0) {
    html += `<div class="qs-success">✅ ${data.postedComments.length} comments posted to Linear</div>`;
  }

  results.innerHTML = html;
}

function showSecurityResults(data) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  progress.style.display = 'none';
  results.style.display = 'block';

  results.innerHTML = `
    <div class="qs-section">
      <h3>🔒 Security Scan Results</h3>
      <div class="qs-summary-grid">
        <div class="qs-summary-item"><span class="qs-big-num">${data.summary.passed}</span><span>Passed</span></div>
        <div class="qs-summary-item"><span class="qs-big-num qs-yellow">${data.summary.warnings}</span><span>Warnings</span></div>
        <div class="qs-summary-item"><span class="qs-big-num qs-red">${data.summary.failed}</span><span>Failed</span></div>
      </div>
    </div>
    ${data.results.map(r => `
      <div class="qs-section qs-scan-${r.overallStatus}">
        <h4>${r.overallStatus === 'pass' ? '✅' : r.overallStatus === 'fail' ? '❌' : '⚠️'} ${r.endpoint.split('/api')[1] || r.endpoint}</h4>
        ${r.checks.map(c => `
          <div class="qs-check-row">
            <span class="qs-check-type">${c.type}</span>
            <span class="qs-check-status qs-status-${c.status}">${c.status}</span>
            <span class="qs-check-detail">${c.details}</span>
          </div>
        `).join('')}
      </div>
    `).join('')}
  `;
}

function showBenchmarkResults(data) {
  const progress = document.getElementById('qs-progress');
  const results = document.getElementById('qs-results');
  progress.style.display = 'none';
  results.style.display = 'block';

  results.innerHTML = `
    <div class="qs-section">
      <h3>⚡ Performance Benchmark</h3>
      ${data.frontend ? `
        <div class="qs-benchmark-card qs-verdict-${data.frontend.verdict}">
          <h4>Frontend vs Competitors</h4>
          <div class="qs-verdict">${data.frontend.verdict.toUpperCase()}</div>
          <p>${data.frontend.delta}</p>
          <p>Our response: ${data.frontend.ours?.responseTime || 'N/A'}ms | TTFB: ${data.frontend.ours?.ttfb || 'N/A'}ms</p>
          ${data.frontend.competitors?.map(c => `
            <p>${c.name}: ${c.result.responseTime}ms | TTFB: ${c.result.ttfb}ms</p>
          `).join('') || ''}
        </div>
      ` : ''}
      <h4>API Endpoints</h4>
      ${data.api?.map(a => `
        <div class="qs-benchmark-row">
          <span>${a.name}</span>
          <span>${a.result.responseTime}ms</span>
          <span class="qs-status-${a.result.statusCode < 400 ? 'pass' : 'fail'}">${a.result.statusCode}</span>
        </div>
      `).join('') || '<p>No API benchmark data</p>'}
    </div>
  `;
}

// ============ Initialize ============

function init() {
  const identifier = getIssueIdentifier();
  if (identifier) {
    createSidebar();
    console.log(`[QA Shield] 🛡️ v0.2 Active on ${identifier}`);
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
