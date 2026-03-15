#!/usr/bin/env node
/**
 * QA Shield Browser Worker — standalone Playwright process
 * HTTP server on port 3099
 * v0.5: connects to real Chrome via CDP (OpenClaw relay on port 18800)
 *       Falls back to headless Playwright Chromium if CDP unavailable
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const PORT = parseInt(process.env.BROWSER_WORKER_PORT || '3099', 10);
const STAGING_URL = process.env.STAGING_URL || 'https://dev.creator.fun';
const PASSWORD_GATE = process.env.PASSWORD_GATE || 'georgecfun';
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL || 'zohaib@authornate.com';
const GOOGLE_PASSWORD = process.env.GOOGLE_PASSWORD || '12345Aa@';
const AUTH_STATE_FILE = '/tmp/qa-shield-browser-auth.json';

// Chrome CDP endpoint — OpenClaw browser relay
const CHROME_CDP_URL = process.env.CHROME_CDP_URL || 'http://127.0.0.1:18792';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '33cea86fede0ee1a9e08687bd34ab6d21d95a3d550a7c5f0';

let browser = null;
let usingCDP = false;
let usingPersistentCtx = false; // true when browser is actually a BrowserContext (persistent profile)

// ── Browser singleton ──

async function getBrowser() {
  // Test if existing connection still alive
  if (browser) {
    try {
      browser.contexts(); // throws if disconnected
      return browser;
    } catch {
      browser = null;
    }
  }

  // Try CDP first (real Chrome via OpenClaw relay — requires attached tab)
  // The relay uses header "auth" with a HMAC-derived token
  try {
    console.log(`[BrowserWorker] Connecting to real Chrome via CDP relay: ${CHROME_CDP_URL}`);
    // Build wsEndpoint from the relay — relay proxies to attached tab
    const relayWs = CHROME_CDP_URL.replace('http://', 'ws://');
    browser = await chromium.connectOverCDP({
      wsEndpoint: relayWs,
      headers: { 'auth': GATEWAY_TOKEN },
    });
    usingCDP = true;
    console.log('[BrowserWorker] ✅ Connected to real Chrome via relay (session + extensions available)');
    return browser;
  } catch (cdpErr) {
    console.warn(`[BrowserWorker] Relay unavailable (${cdpErr.message.slice(0, 80)}) — trying direct connect`);
    // Try direct CDP connect (works if Chrome was launched with --remote-debugging-port)
    try {
      browser = await chromium.connectOverCDP(CHROME_CDP_URL);
      usingCDP = true;
      console.log('[BrowserWorker] ✅ Connected to Chrome via direct CDP');
      return browser;
    } catch (_) {}
    console.warn('[BrowserWorker] CDP unavailable — trying Chrome user profile launch');
  }

  // Try launching Chrome with existing user profile (has Google session)
  const CHROME_USER_DATA = process.env.CHROME_USER_DATA || `${process.env.HOME}/Library/Application Support/Google/Chrome`;
  const CHROME_EXECUTABLE = process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  try {
    const { chromium: pwChromium } = require('playwright');
    browser = await pwChromium.launchPersistentContext(CHROME_USER_DATA, {
      executablePath: CHROME_EXECUTABLE,
      headless: false,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    usingCDP = false;
    usingPersistentCtx = true;
    console.log('[BrowserWorker] ✅ Launched Chrome with persistent profile (session available)');
    return browser; // this is a BrowserContext, not Browser — handle in newPage()
  } catch (profileErr) {
    console.warn(`[BrowserWorker] Persistent Chrome failed (${profileErr.message}) — falling back to headless`);
  }

  // Fallback: headless Playwright Chromium
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  usingCDP = false;
  console.log('[BrowserWorker] ✅ Headless Chromium launched (no extensions)');
  return browser;
}

// ── Page factory ──
// When using CDP: opens a new tab in real Chrome (inherits session/cookies)
// When using headless: creates a new context + page

async function newPage() {
  const b = await getBrowser();

  if (usingCDP) {
    // Use first existing context (shares Chrome session) or create one
    const contexts = b.contexts();
    const ctx = contexts.length > 0 ? contexts[0] : await b.newContext();
    const page = await ctx.newPage();
    return { page, ctx: null }; // ctx managed by Chrome
  } else if (usingPersistentCtx) {
    // Persistent Chrome profile — b IS the BrowserContext
    const page = await b.newPage();
    return { page, ctx: null }; // session already loaded from user profile
  } else {
    // Headless fallback — use saved auth state if available, otherwise log in
    const hasAuthState = fs.existsSync(AUTH_STATE_FILE);
    const ctxOptions = {
      viewport: { width: 1400, height: 900 },
      ...(hasAuthState ? { storageState: AUTH_STATE_FILE } : {}),
    };
    const ctx = await b.newContext(ctxOptions);
    const page = await ctx.newPage();

    // Handle password gate
    await page.goto(STAGING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    try {
      const pwInput = await page.waitForSelector('input[type="password"]', { timeout: 3000 });
      if (pwInput) {
        await pwInput.fill(PASSWORD_GATE);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
      }
    } catch (_) {}

    // If not logged in, attempt Google login and save state
    if (!hasAuthState) {
      try {
        const connectBtn = await page.$('button:has-text("Connect"), a:has-text("Login"), button:has-text("Login")');
        if (connectBtn) {
          await connectBtn.click();
          await page.waitForTimeout(1000);
        }
        const googleBtn = await page.$('button:has-text("Google"), [aria-label*="Google" i], img[alt*="Google" i]');
        if (googleBtn) {
          await googleBtn.click();
          // Wait for Google OAuth popup/redirect
          await page.waitForTimeout(2000);
          // Fill email
          const emailInput = await page.waitForSelector('input[type="email"]', { timeout: 8000 }).catch(() => null);
          if (emailInput) {
            await emailInput.fill(GOOGLE_EMAIL);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1500);
            const passInput = await page.waitForSelector('input[type="password"]', { timeout: 8000 }).catch(() => null);
            if (passInput) {
              await passInput.fill(GOOGLE_PASSWORD);
              await page.keyboard.press('Enter');
              await page.waitForTimeout(3000);
            }
          }
          // Save auth state for reuse
          await ctx.storageState({ path: AUTH_STATE_FILE });
          console.log('[BrowserWorker] ✅ Google login complete — auth state saved');
        }
      } catch (loginErr) {
        console.warn('[BrowserWorker] Google login attempt failed:', loginErr.message);
      }
    }

    return { page, ctx };
  }
}

// ── DOM check runner ──

async function runDOMChecks(path, checks) {
  const results = [];
  let screenshot = null;
  let ctx = null;
  let page = null;

  try {
    ({ page, ctx } = await newPage());

    const url = path.startsWith('http') ? path : `${STAGING_URL}${path}`;
    console.log(`[BrowserWorker] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    for (const check of checks) {
      try {
        const r = await executeCheck(page, check);
        results.push(r);
      } catch (e) {
        results.push({ name: check.name || check.selector || check.action, status: 'fail', details: e.message });
      }
    }

    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    screenshot = buf.toString('base64');

  } catch (e) {
    console.error(`[BrowserWorker] DOM check error: ${e.message}`);
    results.push({ name: `Navigate to ${path}`, status: 'fail', details: e.message });
    browser = null; // Force reconnect next time
  } finally {
    // Close page (and ctx if headless) but leave Chrome browser running
    if (page) await page.close().catch(() => {});
    if (ctx) await ctx.close().catch(() => {});
  }

  return { results, screenshot };
}

// ── Check executor ──

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
    case 'hidden': {
      const el = await page.$(check.selector);
      if (!el) return { name, status: 'pass', details: 'Element absent (hidden)' };
      const vis = await el.isVisible();
      return { name, status: !vis ? 'pass' : 'fail', details: !vis ? 'Hidden ✅' : 'Still visible ❌' };
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
    case 'screenshot': {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      return { name, status: 'pass', details: 'Screenshot captured', screenshot: buf.toString('base64') };
    }
    default:
      return { name, status: 'skip', details: `Unknown action: ${check.action}` };
  }
}

// ── Screenshot endpoint ──

async function takeScreenshot(path) {
  const url = path.startsWith('http') ? path : `${STAGING_URL}${path}`;
  const { page, ctx } = await newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000);
    const buf = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
    return buf.toString('base64');
  } finally {
    await page.close().catch(() => {});
    if (ctx) await ctx.close().catch(() => {});
  }
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') {
    let browserOk = false;
    try { if (browser) { browser.contexts(); browserOk = true; } } catch {}
    return send(200, {
      ok: true,
      mode: usingCDP ? 'chrome-cdp' : 'headless',
      cdpUrl: CHROME_CDP_URL,
      browserConnected: browserOk,
      stagingUrl: STAGING_URL,
      port: PORT,
    });
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        if (req.url === '/dom') {
          const { path, checks } = data;
          if (!path || !checks) return send(400, { error: 'path and checks required' });
          const result = await runDOMChecks(path, checks);
          return send(200, result);
        }

        if (req.url === '/screenshot') {
          const { path } = data;
          if (!path) return send(400, { error: 'path required' });
          const screenshot = await takeScreenshot(path);
          return send(200, { screenshot });
        }

        if (req.url === '/reset') {
          browser = null;
          await getBrowser(); // reconnect
          return send(200, { ok: true, message: 'Browser reconnected' });
        }

        return send(404, { error: 'Unknown endpoint' });
      } catch (e) {
        console.error(`[BrowserWorker] Request error: ${e.message}`);
        return send(500, { error: e.message, results: [] });
      }
    });
    return;
  }

  send(404, { error: 'Not found' });
});

// ── Startup ──

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`[BrowserWorker] v0.5 ready on http://127.0.0.1:${PORT}`);
  console.log(`[BrowserWorker] CDP target: ${CHROME_CDP_URL}`);
  console.log(`[BrowserWorker] Staging URL: ${STAGING_URL}`);
  // Pre-connect on startup
  try {
    await getBrowser();
  } catch (e) {
    console.warn(`[BrowserWorker] Pre-connect failed: ${e.message}`);
  }
});

process.on('SIGTERM', async () => {
  if (browser && !usingCDP) await browser.close().catch(() => {});
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[BrowserWorker] Uncaught:', err.message);
  // Don't crash — reset browser and continue
  browser = null;
});
