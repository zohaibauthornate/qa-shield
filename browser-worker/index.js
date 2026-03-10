#!/usr/bin/env node
/**
 * QA Shield Browser Worker — standalone Playwright process
 * Receives jobs via stdin (JSON), outputs results via stdout (JSON)
 * Run as: node browser-worker/index.js
 * Communicate via HTTP on port 3099
 */

const { chromium } = require('playwright');
const http = require('http');

const PORT = process.env.BROWSER_WORKER_PORT || 3099;
const STAGING_URL = process.env.STAGING_URL || 'https://dev.creator.fun';
const PASSWORD_GATE = 'georgecfun';

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}

async function getAuthedPage() {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  await page.goto(STAGING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Handle password gate
  try {
    const pwInput = await page.waitForSelector('input[type="password"]', { timeout: 3000 });
    if (pwInput) {
      await pwInput.fill(PASSWORD_GATE);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
    }
  } catch (_) {}

  return page;
}

async function runDOMChecks(path, checks) {
  const results = [];
  let screenshot = null;
  let page = null;

  try {
    page = await getAuthedPage();
    const url = path.startsWith('http') ? path : `${STAGING_URL}${path}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500); // Let JS render dynamic content

    for (const check of checks) {
      try {
        const r = await executeCheck(page, check);
        results.push(r);
      } catch (e) {
        results.push({ name: check.name || check.selector, status: 'fail', details: e.message });
      }
    }

    const buf = await page.screenshot({ type: 'jpeg', quality: 50 });
    screenshot = buf.toString('base64');

  } catch (e) {
    results.push({ name: `Navigate to ${path}`, status: 'fail', details: e.message });
  } finally {
    if (page) {
      const ctx = page.context();
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  }

  return { results, screenshot };
}

async function executeCheck(page, check) {
  const name = check.name || `${check.action || 'exists'}: ${check.selector}`;

  switch (check.action || 'exists') {
    case 'exists': {
      const el = await page.$(check.selector);
      return { name, status: el ? 'pass' : 'fail', details: el ? 'Element found' : 'NOT found' };
    }
    case 'visible': {
      const el = await page.$(check.selector);
      if (!el) return { name, status: 'fail', details: 'Element not found' };
      const vis = await el.isVisible();
      return { name, status: vis ? 'pass' : 'fail', details: vis ? 'Visible' : 'NOT visible' };
    }
    case 'text': {
      const el = await page.$(check.selector);
      if (!el) return { name, status: 'fail', details: 'Element not found' };
      const text = (await el.textContent())?.trim() || '';
      if (!check.expected) return { name, status: text.length > 0 ? 'pass' : 'fail', details: `"${text.substring(0, 100)}"` };
      const ok = text.toLowerCase().includes(String(check.expected).toLowerCase());
      return { name, status: ok ? 'pass' : 'fail', details: `Got: "${text.substring(0, 80)}" / Expected: "${check.expected}"` };
    }
    case 'count': {
      const els = await page.$$(check.selector);
      const count = els.length;
      const exp = Number(check.expected);
      return { name, status: (isNaN(exp) ? count > 0 : count >= exp) ? 'pass' : 'fail', details: `Found ${count}${isNaN(exp) ? '' : ` (need ≥${exp})`}` };
    }
    case 'css': {
      const el = await page.$(check.selector);
      if (!el) return { name, status: 'fail', details: 'Element not found' };
      const val = await el.evaluate((n, p) => getComputedStyle(n)[p], check.cssProperty);
      return { name, status: String(val) === String(check.expected) ? 'pass' : 'fail', details: `${check.cssProperty}: ${val} (want: ${check.expected})` };
    }
    case 'click_and_check': {
      const el = await page.$(check.selector);
      if (!el) return { name, status: 'fail', details: 'Click target not found' };
      await el.click();
      await page.waitForTimeout(1500);
      if (check.afterClickSelector) {
        const after = await page.$(check.afterClickSelector);
        return { name, status: after ? 'pass' : 'fail', details: after ? `"${check.afterClickSelector}" appeared` : `"${check.afterClickSelector}" NOT found` };
      }
      return { name, status: 'pass', details: 'Clicked successfully' };
    }
    case 'evaluate': {
      if (!check.evaluate) return { name, status: 'skip', details: 'No expression' };
      const result = await page.evaluate(check.evaluate);
      return { name, status: result ? 'pass' : 'fail', details: JSON.stringify(result).substring(0, 200) };
    }
    default:
      return { name, status: 'skip', details: `Unknown: ${check.action}` };
  }
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/dom') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { path, checks } = JSON.parse(body);
        const result = await runDOMChecks(path, checks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, results: [] }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, browserReady: !!(browser && browser.isConnected()) }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[BrowserWorker] Ready on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
