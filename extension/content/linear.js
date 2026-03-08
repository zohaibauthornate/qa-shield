/**
 * QA Shield — Linear Content Script
 * Injects enrichment sidebar on Linear issue pages
 */

const QA_SHIELD_API = 'http://localhost:3000';

// ============ Issue Detection ============

function getIssueIdentifier() {
  // URL pattern: /creatorfun/issue/CRX-XXX/...
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
      <button class="qs-close" id="qs-close-btn">×</button>
    </div>
    <div class="qs-content" id="qs-content">
      <div class="qs-loading" id="qs-loading">
        <div class="qs-spinner"></div>
        <p>Analyzing ticket...</p>
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

  // Event listeners
  document.getElementById('qs-close-btn').addEventListener('click', () => {
    sidebar.classList.toggle('qs-collapsed');
  });

  document.getElementById('qs-enrich-btn').addEventListener('click', enrichTicket);
  document.getElementById('qs-verify-btn').addEventListener('click', verifyFix);
  document.getElementById('qs-security-btn').addEventListener('click', runSecurityScan);
  document.getElementById('qs-benchmark-btn').addEventListener('click', runBenchmark);
}

// ============ API Calls ============

async function enrichTicket() {
  const identifier = getIssueIdentifier();
  if (!identifier) return showError('Could not detect ticket ID');

  showLoading('Enriching ticket with AI analysis...');

  try {
    const res = await fetch(`${QA_SHIELD_API}/api/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, postComment: true }),
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showEnrichmentResults(data.enrichment, data.commentPosted);
  } catch (err) {
    showError(`Enrichment failed: ${err.message}`);
  }
}

async function verifyFix() {
  const identifier = getIssueIdentifier();
  if (!identifier) return showError('Could not detect ticket ID');

  showLoading('Running full verification...\n⏱️ This takes ~30-60 seconds (AI analysis + security scan + benchmark).\nResults will be posted to Linear.');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout

    const res = await fetch(`${QA_SHIELD_API}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, postComment: true }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    // Show full verification with new issues created
    if (data.verification) {
      showFullVerificationResults(data);
    } else {
      showVerificationResults(data.security, data.benchmark, data.commentPosted);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      showError('Verification timed out (>2 min). The backend may still be processing — check the Linear ticket for results.');
    } else {
      showError(`Verification failed: ${err.message}`);
    }
  }
}

async function runSecurityScan() {
  const identifier = getIssueIdentifier();
  showLoading('Running security scan...\nResults will be posted to Linear.');

  try {
    const res = await fetch(`${QA_SHIELD_API}/api/security/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, postComment: true }),
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showSecurityResults(data);
  } catch (err) {
    showError(`Security scan failed: ${err.message}`);
  }
}

async function runBenchmark() {
  const identifier = getIssueIdentifier();
  showLoading('Running performance benchmark against competitors...\nResults will be posted to Linear.');

  try {
    const res = await fetch(`${QA_SHIELD_API}/api/monitor/health?mode=benchmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, postComment: true }),
    });

    const data = await res.json();
    showBenchmarkResults(data);
  } catch (err) {
    // Fallback to GET if POST not supported
    try {
      const res = await fetch(`${QA_SHIELD_API}/api/monitor/health?mode=benchmark`);
      const data = await res.json();
      showBenchmarkResults(data);
    } catch (err2) {
      showError(`Benchmark failed: ${err2.message}`);
    }
  }
}

// ============ Result Renderers ============

function showLoading(msg) {
  const loading = document.getElementById('qs-loading');
  const results = document.getElementById('qs-results');
  loading.style.display = 'block';
  loading.querySelector('p').textContent = msg;
  results.style.display = 'none';
}

function showError(msg) {
  const loading = document.getElementById('qs-loading');
  const results = document.getElementById('qs-results');
  loading.style.display = 'none';
  results.style.display = 'block';
  results.innerHTML = `<div class="qs-error">❌ ${msg}</div>`;
}

function showEnrichmentResults(enrichment, commentPosted) {
  const loading = document.getElementById('qs-loading');
  const results = document.getElementById('qs-results');
  loading.style.display = 'none';
  results.style.display = 'block';

  const severityColors = { critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e' };
  const sevColor = severityColors[enrichment.impact.severity] || '#666';

  results.innerHTML = `
    <div class="qs-section">
      <h3>📋 Classification</h3>
      <div class="qs-tags">
        <span class="qs-tag">${enrichment.issueType.toUpperCase()}</span>
        <span class="qs-tag" style="background:${sevColor}">${enrichment.impact.severity.toUpperCase()}</span>
        <span class="qs-tag">${enrichment.priorityRecommendation.level.toUpperCase()}</span>
      </div>
      ${enrichment.impact.financialImpact ? '<div class="qs-alert">⚠️ Financial Impact</div>' : ''}
      ${enrichment.impact.securityImpact ? '<div class="qs-alert qs-alert-danger">🔴 Security Impact</div>' : ''}
    </div>

    <div class="qs-section">
      <h3>🔍 Root Cause</h3>
      <p><strong>Caused by:</strong> ${enrichment.rootCause.causedBy}</p>
      <p>${enrichment.rootCause.summary}</p>
    </div>

    <div class="qs-section">
      <h3>✅ Test Cases (${enrichment.testCases.length})</h3>
      ${enrichment.testCases.map(tc => `
        <div class="qs-test-case">
          <div class="qs-tc-header">
            <span class="qs-tc-badge qs-tc-${tc.priority}">${tc.priority.toUpperCase()}</span>
            <strong>${tc.id}: ${tc.title}</strong>
          </div>
          <ol class="qs-tc-steps">
            ${tc.steps.map(s => `<li>${s}</li>`).join('')}
          </ol>
          <div class="qs-tc-expected">Expected: ${tc.expected}</div>
        </div>
      `).join('')}
    </div>

    <div class="qs-section">
      <h3>⚡ Edge Cases (${enrichment.edgeCases.length})</h3>
      ${enrichment.edgeCases.map(ec => `
        <div class="qs-edge-case">
          <span class="qs-tag qs-tag-${ec.risk}">${ec.risk}</span>
          <strong>${ec.scenario}</strong>
          <p class="qs-hint">→ ${ec.howToTest}</p>
        </div>
      `).join('')}
    </div>

    <div class="qs-section">
      <h3>🗺️ Impacted Areas</h3>
      ${enrichment.impactedAreas.map(ia => `
        <div class="qs-impact-item ${ia.checkRequired ? 'qs-check-required' : ''}">
          ${ia.checkRequired ? '⚠️' : 'ℹ️'} <strong>${ia.page}</strong> → ${ia.component}: ${ia.reason}
        </div>
      `).join('') || '<p class="qs-muted">No additional areas identified</p>'}
    </div>

    ${commentPosted ? '<div class="qs-success">✅ Enrichment posted to Linear ticket</div>' : ''}
  `;
}

function showVerificationResults(security, benchmark, commentPosted) {
  const loading = document.getElementById('qs-loading');
  const results = document.getElementById('qs-results');
  loading.style.display = 'none';
  results.style.display = 'block';

  const secSummary = security?.summary || { passed: 0, warnings: 0, failed: 0 };
  const competitors = benchmark?.competitors || [];

  results.innerHTML = `
    <div class="qs-section">
      <h3>✅ Verification Report</h3>
      <div class="qs-summary-grid">
        <div class="qs-summary-item">
          <span class="qs-big-num">${secSummary.passed}</span>
          <span>Security ✅</span>
        </div>
        <div class="qs-summary-item">
          <span class="qs-big-num qs-yellow">${secSummary.warnings}</span>
          <span>Warnings</span>
        </div>
        <div class="qs-summary-item">
          <span class="qs-big-num ${secSummary.failed > 0 ? 'qs-red' : ''}">${secSummary.failed}</span>
          <span>Security ❌</span>
        </div>
      </div>
    </div>

    <div class="qs-section">
      <h3>🔒 Security Scan</h3>
      ${(security?.results || []).map(r => {
        const failedChecks = r.checks.filter(c => c.status !== 'pass');
        if (failedChecks.length === 0) return '';
        return `
          <div class="qs-scan-result qs-scan-${r.overallStatus}">
            <strong>${r.endpoint.split('/api')[1] ? '/api' + r.endpoint.split('/api')[1] : r.endpoint}</strong>
            ${failedChecks.map(c => `
              <div class="qs-check-detail">⚠️ [${c.type}] ${c.details}</div>
            `).join('')}
          </div>
        `;
      }).join('') || '<p>No security issues found</p>'}
    </div>

    <div class="qs-section">
      <h3>⚡ Performance vs Competitors</h3>
      <div class="qs-benchmark-row">
        <span><strong>creator.fun</strong></span>
        <span>${benchmark?.ours?.responseTime || 'N/A'}ms</span>
      </div>
      ${competitors.map(c => `
        <div class="qs-benchmark-row">
          <span>${c.name}</span>
          <span>${c.result?.responseTime || 'N/A'}ms</span>
        </div>
      `).join('')}
    </div>

    ${commentPosted ? '<div class="qs-success">✅ Full report posted to Linear ticket</div>' : ''}
  `;
}

function showFullVerificationResults(data) {
  const loading = document.getElementById('qs-loading');
  const results = document.getElementById('qs-results');
  loading.style.display = 'none';
  results.style.display = 'block';

  const v = data.verification;
  const sec = data.security?.summary || {};
  const verdictIcon = v.overallVerdict === 'pass' ? '✅' : v.overallVerdict === 'fail' ? '❌' : '⚠️';
  const verdictColor = v.overallVerdict === 'pass' ? '#22c55e' : v.overallVerdict === 'fail' ? '#ef4444' : '#eab308';

  let html = `
    <div class="qs-section">
      <h3 style="color:${verdictColor}">${verdictIcon} Verdict: ${v.overallVerdict.toUpperCase()}</h3>
      <p>${v.verdictSummary || ''}</p>
      <div class="qs-summary-grid">
        <div class="qs-summary-item">
          <span class="qs-big-num">${(v.passed || []).length}</span>
          <span>Passed</span>
        </div>
        <div class="qs-summary-item">
          <span class="qs-big-num qs-red">${(v.failed || []).length}</span>
          <span>Failed</span>
        </div>
        <div class="qs-summary-item">
          <span class="qs-big-num">${(v.newIssuesFound || []).length}</span>
          <span>New Issues</span>
        </div>
      </div>
    </div>`;

  // Steps Executed
  if (v.stepsExecuted && v.stepsExecuted.length > 0) {
    html += `<div class="qs-section"><h3>📋 Steps Executed</h3>`;
    v.stepsExecuted.forEach(s => {
      const icon = s.status === 'pass' ? '✅' : s.status === 'fail' ? '❌' : s.status === 'skip' ? '⏭️' : '⚠️';
      html += `<div class="qs-test-case"><strong>${icon} ${s.name}</strong><p class="qs-hint">${s.details || ''}</p></div>`;
    });
    html += `</div>`;
  }

  // Passed
  if (v.passed && v.passed.length > 0) {
    html += `<div class="qs-section"><h3>✅ Passed</h3>`;
    v.passed.forEach(p => { html += `<div class="qs-impact-item">✅ ${p}</div>`; });
    html += `</div>`;
  }

  // Failed
  if (v.failed && v.failed.length > 0) {
    html += `<div class="qs-section"><h3>❌ Failed</h3>`;
    v.failed.forEach(f => {
      html += `<div class="qs-test-case" style="border-left:3px solid #ef4444;padding-left:8px">
        <strong>${f.test}</strong><p class="qs-hint" style="color:#ef4444">→ ${f.reason}</p></div>`;
    });
    html += `</div>`;
  }

  // Not Test Ready
  if (v.notTestReady && v.notTestReady.length > 0) {
    html += `<div class="qs-section"><h3>🚧 Not Test Ready</h3>`;
    v.notTestReady.forEach(n => {
      html += `<div class="qs-impact-item">🚧 <strong>${n.area}</strong>: ${n.reason}</div>`;
    });
    html += `</div>`;
  }

  // Cannot Test
  if (v.cannotTest && v.cannotTest.length > 0) {
    html += `<div class="qs-section"><h3>🔒 Cannot Test (Constraints)</h3>`;
    v.cannotTest.forEach(c => {
      html += `<div class="qs-impact-item">🔒 <strong>${c.area}</strong>: ${c.constraint}</div>`;
    });
    html += `</div>`;
  }

  // Security Summary
  html += `<div class="qs-section"><h3>🔒 Security: ${sec.passed || 0}✅ ${sec.warnings || 0}⚠️ ${sec.failed || 0}❌</h3></div>`;

  // Benchmark
  if (data.benchmark) {
    html += `<div class="qs-section"><h3>⚡ Performance</h3>
      <div class="qs-benchmark-row"><span><strong>creator.fun</strong></span><span>${data.benchmark.ours?.responseTime || 'N/A'}ms</span></div>`;
    (data.benchmark.competitors || []).forEach(c => {
      html += `<div class="qs-benchmark-row"><span>${c.name}</span><span>${c.result?.responseTime || 'N/A'}ms</span></div>`;
    });
    html += `</div>`;
  }

  // New Tickets Created
  if (data.createdTickets && data.createdTickets.length > 0) {
    html += `<div class="qs-section"><h3>🆕 New Tickets Created</h3>`;
    data.createdTickets.forEach(t => {
      html += `<div class="qs-impact-item qs-check-required">🎫 <a href="${t.url}" target="_blank" style="color:#6366f1">${t.identifier}</a> — ${t.title}</div>`;
    });
    html += `</div>`;
  }

  html += `${data.commentPosted ? '<div class="qs-success">✅ Full report posted to Linear ticket</div>' : ''}`;

  results.innerHTML = html;
}

function showSecurityResults(data) {
  const loading = document.getElementById('qs-loading');
  const results = document.getElementById('qs-results');
  loading.style.display = 'none';
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
  const loading = document.getElementById('qs-loading');
  const results = document.getElementById('qs-results');
  loading.style.display = 'none';
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
    console.log(`[QA Shield] 🛡️ Active on ${identifier}`);
  }
}

// Watch for SPA navigation
let lastUrl = window.location.href;
new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    const existing = document.getElementById('qa-shield-sidebar');
    if (existing) existing.remove();
    init();
  }
}).observe(document.body, { childList: true, subtree: true });

init();
