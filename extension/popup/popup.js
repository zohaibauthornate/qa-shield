/**
 * QA Shield — Popup Script
 */

let API_URL = 'http://localhost:3000';

// Load saved API URL
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

// Save API URL on change
document.getElementById('api-url-input').addEventListener('change', (e) => {
  API_URL = e.target.value;
  chrome.storage.local.set({ apiUrl: API_URL });
  checkHealth();
});

// Health Check
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

// Increment stat
function incrementStat(key) {
  chrome.storage.local.get(['stats'], (data) => {
    const stats = data.stats || { scans: 0, enriched: 0, issues: 0 };
    stats[key] = (stats[key] || 0) + 1;
    chrome.storage.local.set({ stats });
    document.getElementById(`${key}-count`).textContent = stats[key];
  });
}

// Security Scan
document.getElementById('scan-all-btn').addEventListener('click', async () => {
  const btn = document.getElementById('scan-all-btn');
  btn.querySelector('span:last-child').textContent = 'Scanning...';

  try {
    const res = await fetch(`${API_URL}/api/security/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    incrementStat('scans');

    const issues = data.summary.failed + data.summary.warnings;
    if (issues > 0) incrementStat('issues');

    btn.querySelector('span:last-child').textContent =
      `✅ ${data.summary.passed} pass, ⚠️ ${data.summary.warnings} warn, ❌ ${data.summary.failed} fail`;
  } catch (err) {
    btn.querySelector('span:last-child').textContent = `❌ Failed: ${err.message}`;
  }

  setTimeout(() => {
    btn.querySelector('span:last-child').textContent = 'Run Full Security Scan';
  }, 5000);
});

// Benchmark
document.getElementById('benchmark-btn').addEventListener('click', async () => {
  const btn = document.getElementById('benchmark-btn');
  btn.querySelector('span:last-child').textContent = 'Benchmarking...';

  try {
    const res = await fetch(`${API_URL}/api/monitor/health?mode=benchmark`);
    const data = await res.json();

    const verdict = data.frontend?.verdict || 'unknown';
    const delta = data.frontend?.delta || 'N/A';
    btn.querySelector('span:last-child').textContent = `${verdict.toUpperCase()}: ${delta}`;
  } catch (err) {
    btn.querySelector('span:last-child').textContent = `❌ Failed`;
  }

  setTimeout(() => {
    btn.querySelector('span:last-child').textContent = 'Performance Benchmark';
  }, 5000);
});

// Health Button
document.getElementById('health-btn').addEventListener('click', checkHealth);
