#!/usr/bin/env node
/**
 * QA Shield Browser Worker — standalone Playwright process
 * HTTP server on port 3099
 * v0.4: warm authenticated context + persistent auth state
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.BROWSER_WORKER_PORT || 3099;
const STAGING_URL = process.env.STAGING_URL || 'https://dev.creator.fun';
const PASSWORD_GATE = 'georgecfun';
const AUTH_STATE_FILE = path.join(__dirname, 'auth-state.json');
// How old auth state can be before we consider it stale (6 hours)
const AUTH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let browser = null;
let warmContext = null;
let warmPage = null;

// ── Browser singleton ──

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  return browser;
}

// ── Auth state helpers ──

function loadAuthState() {
  try {
    if (!fs.existsSync(AUTH_STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf8'));
    const age = Date.now() - (raw.savedAt || 0);
    if (age > AUTH_MAX_AGE_MS) {
      console.log('[BrowserWorker] Auth state expired, will re-auth');
      return null;
    }
    console.log(`[BrowserWorker] Loaded auth state (${Math.round(age / 60000)}m old)`);
    return raw.state;
  } catch {
    return null;
  }
}

function saveAuthState(state) {
  try {
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify({ savedAt: Date.now(), state }, null, 2));
    console.log('[BrowserWorker] Auth state saved ✅');
  } catch (e) {
    console.error('[BrowserWorker] Could not save auth state:', e.message);
  }
}

// ── Warm page — persistent authenticated context ──

async function getWarmPage() {
  if (warmPage && !warmPage.isClosed()) return warmPage;

  console.log('[BrowserWorker] Warming up authenticated page...');
  const b = await getBrowser();

  if (warmContext) {
    await warmContext.close().catch(() => {});
    warmContext = null;
    warmPage = null;
  }

  // Load saved auth state if available
  const savedState = loadAuthState();
  warmContext = await b.newContext({
    viewport: { width: 1400, height: 900 },
    ...(savedState ? { storageState: savedState } : {}),
  });
  warmPage = await warmContext.newPage();

  // Navigate to site
  await warmPage.goto(STAGING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Handle password gate
  try {
    const pwInput = await warmPage.waitForSelector('input[type="password"]', { timeout: 3000 });
    if (pwInput) {
      await pwInput.fill(PASSWORD_GATE);
      await warmPage.keyboard.press('Enter');
      await warmPage.waitForTimeout(2000);
    }
  } catch (_) {}

  // Check if we're actually logged in
  const isLoggedIn = await checkIsLoggedIn(warmPage);
  console.log(`[BrowserWorker] Auth status: ${isLoggedIn ? '✅ Logged in' : '❌ Not logged in'}`);

  if (!isLoggedIn && !savedState) {
    console.log('[BrowserWorker] ⚠️  Not authenticated. Call POST /login to authenticate.');
  }

  // If we have a session, save updated state
  if (isLoggedIn) {
    const currentState = await warmContext.storageState();
    saveAuthState(currentState);
  }

  console.log('[BrowserWorker] Warm page ready ✅');
  return warmPage;
}

async function checkIsLoggedIn(page) {
  try {
    // Check for auth indicators: no login button, has wallet address or username
    const result = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const hasLogin = /^login$/im.test(body.split('\n').map(l => l.trim()).join('\n'));
      const hasWallet = body.includes('wallet') || document.querySelector('[class*=wallet],[class*=Wallet],[class*=address]');
      const hasUsername = document.querySelector('[class*=username],[class*=UserName],[class*=user-name]');
      const hasBalance = document.querySelector('[class*=balance],[class*=Balance]');
      return { hasLogin, hasWallet: !!hasWallet, hasUsername: !!hasUsername, hasBalance: !!hasBalance };
    });
    return result.hasWallet || result.hasUsername || result.hasBalance;
  } catch {
    return false;
  }
}

// ── Reset warm context ──
async function resetWarmPage() {
  if (warmPage) await warmPage.close().catch(() => {});
  if (warmContext) await warmContext.close().catch(() => {});
  warmPage = null;
  warmContext = null;
  return getWarmPage();
}

// ── Manual login flow (opens visible browser, waits for user to login) ──
async function performLogin() {
  console.log('[BrowserWorker] Opening visible browser for manual login...');

  // Launch visible browser for login
  const loginBrowser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox'],
  });

  const ctx = await loginBrowser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

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

  console.log('[BrowserWorker] 👆 Please log in to dev.creator.fun in the browser window...');
  console.log('[BrowserWorker] Waiting for login (up to 3 minutes)...');

  // Wait for login to complete — watch for auth indicators
  let loggedIn = false;
  const deadline = Date.now() + 3 * 60 * 1000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    loggedIn = await checkIsLoggedIn(page);
    if (loggedIn) break;
  }

  if (loggedIn) {
    const state = await ctx.storageState();
    saveAuthState(state);
    console.log('[BrowserWorker] ✅ Login successful! Auth state saved.');

    // Reset warm page so it picks up new auth
    await loginBrowser.close();
    await resetWarmPage();
    return { success: true, message: 'Login successful, auth state saved' };
  } else {
    await loginBrowser.close();
    return { success: false, message: 'Login timeout — user did not authenticate within 3 minutes' };
  }
}

// ── Inject auth state manually (from external cookie export) ──
async function injectAuthState(state) {
  saveAuthState(state);
  await resetWarmPage();
  return { success: true, message: 'Auth state injected and warm page reset' };
}

// ── DOM check runner ──

async function runDOMChecks(path, checks) {
  const results = [];
  let screenshot = null;

  try {
    const page = await getWarmPage();
    const url = path.startsWith('http') ? path : `${STAGING_URL}${path}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Detect session expiry — if bounced to login, re-auth
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
      console.log('[BrowserWorker] Session expired, resetting...');
      fs.existsSync(AUTH_STATE_FILE) && fs.unlinkSync(AUTH_STATE_FILE);
      await resetWarmPage();
      const freshPage = await getWarmPage();
      await freshPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await freshPage.waitForTimeout(1500);
    }

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
    warmPage = null;
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

  } else if (req.method === 'POST' && req.url === '/login') {
    // Opens a visible browser window for manual login, saves auth state
    try {
      const result = await performLogin();
      res.writeHead(result.success ? 200 : 408, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }

  } else if (req.method === 'POST' && req.url === '/inject-auth') {
    // Accept pre-exported auth state (cookies + localStorage) and inject it
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const { state } = JSON.parse(body);
        const result = await injectAuthState(state);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });

  } else if (req.method === 'POST' && req.url === '/reset') {
    try {
      await resetWarmPage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Warm page reset' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (req.method === 'GET' && req.url === '/health') {
    const authStateExists = fs.existsSync(AUTH_STATE_FILE);
    const authAge = authStateExists
      ? Math.round((Date.now() - JSON.parse(fs.readFileSync(AUTH_STATE_FILE, 'utf8')).savedAt) / 60000)
      : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      browserReady: !!(browser && browser.isConnected()),
      warmPageReady: !!(warmPage && !warmPage.isClosed()),
      authStateSaved: authStateExists,
      authAgeMinutes: authAge,
    }));

  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[BrowserWorker] Ready on http://127.0.0.1:${PORT}`);
  console.log(`[BrowserWorker] Auth state file: ${AUTH_STATE_FILE}`);
  // Pre-warm on startup
  getWarmPage().catch(e => console.error('[BrowserWorker] Pre-warm failed:', e.message));
});

process.on('SIGTERM', async () => {
  if (warmContext) await warmContext.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
