/**
 * QA Shield — Staging Site Content Script
 * Floating QA widget for dev.creator.fun
 */

const QA_SHIELD_API = 'http://localhost:3000';

function createWidget() {
  if (document.getElementById('qs-staging-widget')) return;

  const widget = document.createElement('div');
  widget.id = 'qs-staging-widget';
  widget.innerHTML = `
    <button class="qs-fab" id="qs-fab-btn" title="QA Shield">🛡️</button>
    <div class="qs-fab-menu" id="qs-fab-menu" style="display:none">
      <button class="qs-fab-item" id="qs-capture-btn">📸 Capture Screenshot</button>
      <button class="qs-fab-item" id="qs-errors-btn">🐛 Console Errors (0)</button>
      <button class="qs-fab-item" id="qs-scan-btn">🔒 Quick Security Scan</button>
      <button class="qs-fab-item" id="qs-health-btn">⚡ Health Check</button>
    </div>
  `;
  document.body.appendChild(widget);

  // Toggle menu
  document.getElementById('qs-fab-btn').addEventListener('click', () => {
    const menu = document.getElementById('qs-fab-menu');
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
  });

  // Capture console errors
  let errorCount = 0;
  const errors = [];
  const origError = console.error;
  console.error = (...args) => {
    errorCount++;
    errors.push({ message: args.join(' '), timestamp: new Date().toISOString() });
    document.getElementById('qs-errors-btn').textContent = `🐛 Console Errors (${errorCount})`;
    origError.apply(console, args);
  };

  // Capture uncaught errors
  window.addEventListener('error', (e) => {
    errorCount++;
    errors.push({ message: e.message, source: e.filename, line: e.lineno, timestamp: new Date().toISOString() });
    document.getElementById('qs-errors-btn').textContent = `🐛 Console Errors (${errorCount})`;
  });

  // Screenshot (visual viewport)
  document.getElementById('qs-capture-btn').addEventListener('click', () => {
    // Use chrome extension API for full screenshot
    chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, (response) => {
      if (response?.screenshot) {
        // Open in new tab
        const win = window.open();
        win.document.write(`<img src="${response.screenshot}" style="max-width:100%">`);
        win.document.title = `QA Shield Screenshot — ${window.location.pathname}`;
      }
    });
  });

  // Show errors
  document.getElementById('qs-errors-btn').addEventListener('click', () => {
    if (errors.length === 0) { alert('No console errors captured!'); return; }
    const errorText = errors.map(e => `[${e.timestamp}] ${e.message}`).join('\n\n');
    const win = window.open();
    win.document.write(`<pre style="background:#1a1a2e;color:#ef4444;padding:20px;font-size:13px">${errorText}</pre>`);
    win.document.title = 'QA Shield — Console Errors';
  });

  // Quick security scan
  document.getElementById('qs-scan-btn').addEventListener('click', async () => {
    try {
      const res = await fetch(`${QA_SHIELD_API}/api/security/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      alert(`Security Scan: ${data.summary.passed} passed, ${data.summary.warnings} warnings, ${data.summary.failed} failed`);
    } catch (err) {
      alert(`Scan failed: ${err.message}`);
    }
  });

  // Health check
  document.getElementById('qs-health-btn').addEventListener('click', async () => {
    try {
      const res = await fetch(`${QA_SHIELD_API}/api/monitor/health`);
      const data = await res.json();
      alert(`Health: ${data.healthy ? '✅ All systems up' : '❌ Issues detected'}\nAvg response: ${data.avgResponseTime}ms`);
    } catch (err) {
      alert(`Health check failed: ${err.message}`);
    }
  });

  console.log('[QA Shield] 🛡️ Staging widget active');
}

createWidget();
