import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identify, scope } from '../lib/links.mjs';
import { collect, SourceError, ensureAuthenticatedSession, classify24Response, classify24LoginText, classifyAdmicroLoginText, sourceProfileDirectory } from '../lib/connectors.mjs';
import { authCircuit, tripAuthCircuit } from '../lib/source-session.mjs';

const link = () => {
  const value = identify({ name: 'Fixture 24h', url: 'https://khachhang.24h.com.vn/ocm/lineitem/index/?c_statistic_from_date=01-09-2026&c_statistic_to_date=01-09-2026' });
  value.id = 'fixture-24h'; value.scope = scope(value); return value;
};

function fixtureBrowser({ probeFailures = 0 } = {}) {
  const contexts = [];
  let activeCount = 0;
  let maxOpen = 0;
  let remainingProbeFailures = probeFailures;
  return {
    contexts,
    async launchPersistentContext(profile) {
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const page = {
        current: 'about:blank',
        url() { return this.current; },
        async goto(url) { this.current = String(url); },
        async evaluate(fn) {
          if (!String(fn).includes('fetch(')) return false;
          if (remainingProbeFailures > 0) {
            remainingProbeFailures--;
            return { failure: { status: 401, contentType: 'application/json' } };
          }
          return { payload: { data: [{ c_date: '01-09-2026', c_sum_impressions: 1 }] } };
        },
        async close() {}
      };
      const context = { pages: () => [page], async close() { if (!context.closed) { context.closed = true; page.closed = true; activeCount--; } } };
      activeCount++; maxOpen = Math.max(maxOpen, activeCount);
      contexts.push({ profile, page, context });
      return context;
    },
    get maxOpen() { return maxOpen; }
  };
}

function fixtureAdapter(read) {
  return { '24h': { read } };
}

function completePeriod() {
  return { total: { impressions: 10, clicks: 2, spend: 3, engagement: null, viewers: null, ctr: 20 }, details: [] };
}

function loginFixturePage(outcome, { preflight = 'ok', navigation = true, deniedResponses = 0 } = {}) {
  let current = 'https://khachhang.24h.com.vn/ocm/user/login?login=1';
  let remainingDeniedResponses = deniedResponses;
  const pageState = { fills: 0 };
  const routes = new Map();
  const listeners = new Map();
  const response = preflight === 'downgrade'
    ? { status: () => 302, headers: () => ({ location: 'http://khachhang.24h.com.vn/ocm/ajax/user/dologin.php' }), url: () => current }
    : { status: () => 200, headers: () => ({}), url: () => current };
  const frame = { name: () => 'frm_submit', locator: () => ({ innerText: async () => '' }) };
  const node = { getAttribute: () => 'http://khachhang.24h.com.vn/ocm/ajax/user/dologin.php', setAttribute() {} };
  const locator = selector => ({
    count: async () => selector === 'input' ? 2 : 1,
    innerText: async () => selector === 'body' ? (outcome === 'wrong' ? 'Sai mật khẩu' : outcome === 'otp' ? 'Mã OTP' : 'Đã gửi biểu mẫu') : '',
    fill: async () => { pageState.fills++; },
    evaluate: async callback => {
      const source = String(callback);
      if (source.includes('setAttribute')) return 'https://khachhang.24h.com.vn/ocm/ajax/user/dologin.php';
      if (source.includes('HTMLFormElement')) return (current = 'https://khachhang.24h.com.vn/report', undefined);
      return undefined;
    },
    evaluateAll: async () => false
  });
  return {
    url: () => current,
    async goto(url) { current = String(url); },
    locator,
    frames: () => [frame],
    mainFrame: () => frame,
    async waitForEvent() { return navigation ? frame : null; },
    request: { fetch: async () => response },
    async route(pattern, handler) { routes.set(pattern, handler); },
    async unroute(pattern) { routes.delete(pattern); },
    on(event, handler) { listeners.set(event, handler); },
    off(event, handler) { if (listeners.get(event) === handler) listeners.delete(event); },
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes('fetch(')) {
        if (remainingDeniedResponses > 0) {
          remainingDeniedResponses--;
          return { failure: { status: 200, contentType: 'text/html', html: true, accessDenied: true } };
        }
        return { payload: { data: [{ c_date: '01-09-2026', c_sum_impressions: 1 }] } };
      }
      if (source.includes('password') || source.includes('location.pathname')) return outcome === 'success' ? false : true;
      return false;
    },
    _state: () => pageState
  };
}

function accessDeniedProbePage({ succeedAfterLogin = false, deniedResponses = succeedAfterLogin ? 1 : Infinity, status = 200 } = {}) {
  let probes = 0;
  return {
    url: () => 'https://khachhang.24h.com.vn/report',
    async goto() {},
    async evaluate(fn) {
      if (!String(fn).includes('fetch(')) return false;
      probes++;
      if (probes <= deniedResponses) return { failure: { status, contentType: 'text/html', html: true, accessDenied: true } };
      return { payload: { data: [{ c_date: '01-09-2026', c_sum_impressions: 1 }] } };
    }
  };
}

test('collect keeps a valid session on active profile and does not invoke login', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-collector-valid-'));
  const profile = sourceProfileDirectory(directory, '24h');
  mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, 'marker'), 'active');
  const browser = fixtureBrowser(); let loginCalls = 0;
  const result = await collect(link(), { directory, job: {}, browser, adapterMap: fixtureAdapter(async () => completePeriod()), ensureSession: async (page, source, options) => { await ensureAuthenticatedSession(page, source, { ...options, probe: true }); if (options.login) loginCalls++; } });
  assert.equal(result.complete, true);
  assert.equal(loginCalls, 0);
  assert.equal(readFileSync(join(profile, 'marker'), 'utf8'), 'active');
});

test('collect recovers one mid-read expiry and records the bounded recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-collector-recovery-'));
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  let reads = 0; let recoveries = 0;
  try {
    const job = {};
    const result = await collect(link(), { directory, job, browser: fixtureBrowser(), adapterMap: fixtureAdapter(async () => {
      reads++;
      if (reads === 1) throw new SourceError('expired', 'auth_required');
      return completePeriod();
    }), ensureSession: async (_page, _link, options) => { if (options.force) recoveries++; } });
    assert.equal(result.complete, true);
    assert.equal(recoveries, 1);
    assert.equal(job.authRecoveryAttempts, 1);
    assert.equal(job.retries, 1);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('collect recovers one mid-read ambiguous 24h denial and then succeeds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-collector-ambiguous-read-'));
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  let reads = 0; let recoveries = 0;
  try {
    const job = {};
    const result = await collect(link(), { directory, job, browser: fixtureBrowser(), adapterMap: fixtureAdapter(async () => {
      reads++;
      if (reads === 1) {
        const error = new SourceError('session response was ambiguous', 'access_denied');
        error.ambiguousSession = true;
        throw error;
      }
      return completePeriod();
    }), ensureSession: async (_page, _link, options) => { if (options.force) recoveries++; } });
    assert.equal(result.complete, true);
    assert.equal(reads, 2);
    assert.equal(recoveries, 1);
    assert.equal(job.authRecoveryAttempts, 1);
    assert.equal(job.retries, 1);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('standalone collect promotes only the verified candidate under its lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-collector-candidate-'));
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  try {
    const profile = sourceProfileDirectory(directory, '24h');
    mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, 'marker'), 'active');
    const job = {};
    await collect(link(), { directory, job, login: true, browser: fixtureBrowser(), adapterMap: fixtureAdapter(async () => completePeriod()), ensureSession: async () => {} });
    assert.equal(job.promoteCandidate, true);
    assert.equal(existsSync(join(profile, 'marker')), false);
    assert.equal(existsSync(`${profile}.pending`), false);
    assert.ok(readdirSync(join(directory, 'sessions')).some(name => name.startsWith('24h.previous-')));
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('AJAX probe auth expiry promotes the verified candidate even without a login form', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-collector-ajax-expiry-'));
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  try {
    const profile = sourceProfileDirectory(directory, '24h');
    mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, 'marker'), 'active');
    let probes = 0;
    const job = {};
    await collect(link(), { directory, job, browser: fixtureBrowser(), adapterMap: fixtureAdapter(async () => completePeriod()), ensureSession: async () => {
      probes++;
      if (probes === 1) throw new SourceError('probe expired', 'auth_required');
    } });
    assert.equal(probes, 2);
    assert.equal(job.promoteCandidate, true);
    assert.equal(existsSync(join(profile, 'marker')), false);
    assert.equal(existsSync(`${profile}.pending`), false);
    assert.ok(readdirSync(join(directory, 'sessions')).some(name => name.startsWith('24h.previous-')));
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('real coordinator stages before login when protected AJAX probe expires', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-collector-real-ajax-expiry-'));
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  process.env.SOURCE_24H_USERNAME = 'fixture-user';
  process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  try {
    const profile = sourceProfileDirectory(directory, '24h');
    mkdirSync(profile, { recursive: true }); writeFileSync(join(profile, 'marker'), 'active');
    const browser = fixtureBrowser({ probeFailures: 1 });
    let loginProfile = '';
    const job = {};
    await collect(link(), {
      directory, job, browser,
      loginHandler: async page => { loginProfile = browser.contexts.at(-1).profile; page.current = 'https://khachhang.24h.com.vn/report'; },
      adapterMap: fixtureAdapter(async () => completePeriod())
    });
    assert.equal(loginProfile, `${profile}.pending`);
    assert.equal(job.promoteCandidate, true);
    assert.equal(existsSync(join(profile, 'marker')), false);
    assert.ok(readdirSync(join(directory, 'sessions')).some(name => name.startsWith('24h.previous-')));
  } finally {
    if (previous.enabled == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous.enabled;
    if (previous.username == null) delete process.env.SOURCE_24H_USERNAME; else process.env.SOURCE_24H_USERNAME = previous.username;
    if (previous.password == null) delete process.env.SOURCE_24H_PASSWORD; else process.env.SOURCE_24H_PASSWORD = previous.password;
  }
});

test('probe-driven candidate login passes the replacement page to the handler', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-collector-page-handoff-'));
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  const browser = fixtureBrowser({ probeFailures: 1 });
  let receivedPage;
  let receivedPageClosed;
  try {
    await collect(link(), {
      directory,
      browser,
      loginHandler: async page => {
        receivedPage = page;
        receivedPageClosed = page.closed;
        page.current = 'https://khachhang.24h.com.vn/report';
      },
      adapterMap: fixtureAdapter(async () => completePeriod())
    });
    assert.equal(browser.contexts.length, 2);
    assert.equal(browser.contexts[0].page.closed, true);
    assert.equal(receivedPage, browser.contexts[1].page);
    assert.notEqual(receivedPageClosed, true);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('forced login skips denied report preprobe and verifies only after handler', async () => {
  const report = link();
  let gotoCalls = 0;
  let handlerCalled = false;
  const page = {
    url: () => 'https://khachhang.24h.com.vn/report',
    async goto() { gotoCalls++; throw new Error('preprobe must be skipped'); },
    async evaluate(fn) {
      if (String(fn).includes('fetch(')) return { payload: { data: [{ c_date: '01-09-2026', c_sum_impressions: 1 }] } };
      return false;
    }
  };
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  try {
    const result = await ensureAuthenticatedSession(page, report, {
      directory: mkdtempSync(join(tmpdir(), 'admicro-forced-login-')),
      force: true,
      probe: true,
      loginHandler: async currentPage => { handlerCalled = currentPage === page; }
    });
    assert.deepEqual(result, { authenticated: true, refreshed: true });
    assert.equal(handlerCalled, true);
    assert.equal(gotoCalls, 0);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('initial 24h access-denied probe enters auto-login flow', async () => {
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  let loginCalls = 0;
  try {
    const result = await ensureAuthenticatedSession(accessDeniedProbePage({ succeedAfterLogin: true }), link(), {
      directory: mkdtempSync(join(tmpdir(), 'admicro-access-denied-probe-login-')),
      loginHandler: async () => { loginCalls++; }
    });
    assert.deepEqual(result, { authenticated: true, refreshed: true });
    assert.equal(loginCalls, 1);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('ambiguous post-login 24h access-denied gets one bounded recovery', async () => {
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  let loginCalls = 0;
  try {
    const result = await ensureAuthenticatedSession(accessDeniedProbePage({ deniedResponses: 2 }), link(), {
      directory: mkdtempSync(join(tmpdir(), 'admicro-access-denied-recovery-')),
      loginHandler: async () => { loginCalls++; }
    });
    assert.deepEqual(result, { authenticated: true, refreshed: true });
    assert.equal(loginCalls, 1);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('post-login 24h access-denied remains an access-denied failure', async () => {
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  let loginCalls = 0;
  try {
    await assert.rejects(ensureAuthenticatedSession(accessDeniedProbePage(), link(), {
      directory: mkdtempSync(join(tmpdir(), 'admicro-access-denied-post-login-')),
      login: true,
      probe: false,
      loginHandler: async () => { loginCalls++; }
    }), error => {
      assert.equal(error.status, 'access_denied');
      return true;
    });
    assert.equal(loginCalls, 1);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('genuine 24h HTTP 403 access-denied is not treated as session ambiguity', async () => {
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  let loginCalls = 0;
  try {
    await assert.rejects(ensureAuthenticatedSession(accessDeniedProbePage({ status: 403 }), link(), {
      directory: mkdtempSync(join(tmpdir(), 'admicro-http-403-denied-')),
      login: true,
      probe: false,
      loginHandler: async () => { loginCalls++; }
    }), error => {
      assert.equal(error.status, 'access_denied');
      return true;
    });
    assert.equal(loginCalls, 1);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('auth fixtures distinguish access-denied report HTML and configuration/interactive failures', async () => {
  const loginFixture = readFileSync(new URL('./fixtures/24h-login.html', import.meta.url), 'utf8');
  assert.match(loginFixture, /id="loginform"/);
  assert.match(loginFixture, /id="username"/);
  assert.match(loginFixture, /id="password"/);
  assert.match(loginFixture, /id="btn-login"/);
  const deniedFixture = readFileSync(new URL('./fixtures/24h-unauth-report.html', import.meta.url), 'utf8');
  assert.equal(classify24Response({ status: 200, html: true, accessDenied: /không có quyền/i.test(deniedFixture) }).status, 'access_denied');
  const page = { async evaluate() { return false; }, url() { return 'https://khachhang.24h.com.vn/'; } };
  const report = link();
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  process.env.SOURCE_24H_AUTO_LOGIN = 'true';
  delete process.env.SOURCE_24H_USERNAME; delete process.env.SOURCE_24H_PASSWORD;
  try {
    await assert.rejects(ensureAuthenticatedSession(page, report, { directory: mkdtempSync(join(tmpdir(), 'admicro-auth-fixture-')), login: true, probe: false }), error => error.status === 'config_error');
    await assert.rejects(ensureAuthenticatedSession(page, report, { directory: mkdtempSync(join(tmpdir(), 'admicro-auth-fixture-')), login: true, probe: false, loginHandler: async () => { throw new SourceError('OTP required', 'interactive_auth_required'); } }), error => error.status === 'interactive_auth_required');
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('login coordinator classifies known password failure, OTP, and verified report success', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  try {
    assert.equal(classify24LoginText('Sai mật khẩu'), 'invalid_credentials');
    for (const [outcome, expected] of [['otp', 'interactive_auth_required']]) {
      const page = loginFixturePage(outcome);
      await assert.rejects(ensureAuthenticatedSession(page, link(), { directory: mkdtempSync(join(tmpdir(), `admicro-login-${outcome}-`)), login: true, probe: false }), error => { assert.equal(error.status, expected); return true; });
    }
    const success = loginFixturePage('success');
    const result = await ensureAuthenticatedSession(success, link(), { directory: mkdtempSync(join(tmpdir(), 'admicro-login-success-')), login: true, probe: false });
    assert.deepEqual(result, { authenticated: true, refreshed: true });
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Admicro SSO fixture exposes the supported form and classifies login outcomes', async () => {
  const fixture = readFileSync(new URL('./fixtures/admicro-login.html', import.meta.url), 'utf8');
  assert.match(fixture, /id="frmLogin"/);
  assert.match(fixture, /id="txtUser"/);
  assert.match(fixture, /id="txtPass"/);
  assert.equal(classifyAdmicroLoginText('Sai mật khẩu'), 'invalid_credentials');
  assert.equal(classifyAdmicroLoginText('Tài khoản hoặc mật khẩu không chính xác'), 'invalid_credentials');
  assert.equal(classifyAdmicroLoginText('Password incorrect'), 'invalid_credentials');
  assert.equal(classifyAdmicroLoginText('Vui lòng nhập mã OTP'), 'interactive_auth_required');
  assert.equal(classifyAdmicroLoginText('Đã đăng nhập'), 'authentication_failed');
  const previous = { enabled: process.env.SOURCE_ADMICRO_AUTO_LOGIN, username: process.env.SOURCE_ADMICRO_USERNAME, password: process.env.SOURCE_ADMICRO_PASSWORD };
  process.env.SOURCE_ADMICRO_AUTO_LOGIN = 'true'; delete process.env.SOURCE_ADMICRO_USERNAME; delete process.env.SOURCE_ADMICRO_PASSWORD;
  const adLink = identify({ name: 'Fixture Admicro', url: 'https://adx.admicro.vn/mobile/vn/campaign/detail/49891?fd=2026-09-01&td=2026-09-30' });
  try {
    await assert.rejects(ensureAuthenticatedSession({ url: () => 'https://sso.admicro.vn/authenticate/sign?token=fixture', async evaluate() { return false; } }, adLink, { directory: mkdtempSync(join(tmpdir(), 'admicro-login-config-')), login: true, probe: false }), error => error.status === 'config_error');
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_ADMICRO_AUTO_LOGIN: previous.enabled, SOURCE_ADMICRO_USERNAME: previous.username, SOURCE_ADMICRO_PASSWORD: previous.password })) { if (value == null) delete process.env[key]; else process.env[key] = value; }
  }
});

test('login action downgrade is rejected before any credential fill', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const page = loginFixturePage('success', { preflight: 'downgrade' });
  try {
    await assert.rejects(ensureAuthenticatedSession(page, link(), { directory: mkdtempSync(join(tmpdir(), 'admicro-login-preflight-')), login: true, probe: false }), error => error.status === 'transport_security');
    assert.equal(page._state().fills, 0);
  } finally {
    if (previous.enabled == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous.enabled;
    if (previous.username == null) delete process.env.SOURCE_24H_USERNAME; else process.env.SOURCE_24H_USERNAME = previous.username;
    if (previous.password == null) delete process.env.SOURCE_24H_PASSWORD; else process.env.SOURCE_24H_PASSWORD = previous.password;
  }
});

test('explicit 24h insecure HTTP opt-in permits the verified same-host redirect', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, allow: process.env.SOURCE_24H_ALLOW_INSECURE_HTTP, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_ALLOW_INSECURE_HTTP = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const page = loginFixturePage('success', { preflight: 'downgrade' });
  try {
    const result = await ensureAuthenticatedSession(page, link(), { directory: mkdtempSync(join(tmpdir(), 'admicro-login-http-opt-in-')), login: true, probe: false });
    assert.deepEqual(result, { authenticated: true, refreshed: true });
    assert.equal(page._state().fills, 2);
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_ALLOW_INSECURE_HTTP: previous.allow, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('bad password and OTP trip the durable circuit before the next login job', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  try {
    for (const [outcome, expected] of [['wrong', 'invalid_credentials'], ['otp', 'interactive_auth_required']]) {
      const directory = mkdtempSync(join(tmpdir(), `admicro-login-circuit-${outcome}-`));
      await assert.rejects(ensureAuthenticatedSession(loginFixturePage(outcome), link(), { directory, login: true, probe: false }), error => error.status === expected);
      await assert.rejects(ensureAuthenticatedSession(loginFixturePage('success'), link(), { directory, login: true, probe: false }), error => error.status === 'auth_blocked');
    }
  } finally {
    if (previous.enabled == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous.enabled;
    if (previous.username == null) delete process.env.SOURCE_24H_USERNAME; else process.env.SOURCE_24H_USERNAME = previous.username;
    if (previous.password == null) delete process.env.SOURCE_24H_PASSWORD; else process.env.SOURCE_24H_PASSWORD = previous.password;
  }
});

test('ambiguous submit is latched and never retried automatically', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const directory = mkdtempSync(join(tmpdir(), 'admicro-login-ambiguous-'));
  try {
    await assert.rejects(ensureAuthenticatedSession(loginFixturePage('success', { navigation: false }), link(), { directory, login: true, probe: false }), error => error.status === 'authentication_pending');
    await assert.rejects(ensureAuthenticatedSession(loginFixturePage('success'), link(), { directory, login: true, probe: false }), error => error.status === 'auth_blocked');
  } finally {
    if (previous.enabled == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous.enabled;
    if (previous.username == null) delete process.env.SOURCE_24H_USERNAME; else process.env.SOURCE_24H_USERNAME = previous.username;
    if (previous.password == null) delete process.env.SOURCE_24H_PASSWORD; else process.env.SOURCE_24H_PASSWORD = previous.password;
  }
});

test('stale login_in_progress circuit permits one real fixture submit', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const directory = mkdtempSync(join(tmpdir(), 'admicro-login-stale-circuit-'));
  try {
    await tripAuthCircuit(directory, '24h', 'login_in_progress');
    const state = JSON.parse(readFileSync(join(directory, 'source-auth-circuit.json'), 'utf8'));
    state['24h'].at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    writeFileSync(join(directory, 'source-auth-circuit.json'), JSON.stringify(state));
    const page = loginFixturePage('success');
    const result = await ensureAuthenticatedSession(page, link(), { directory, login: true, probe: false });
    assert.deepEqual(result, { authenticated: true, refreshed: true });
    assert.equal(page._state().fills, 2);
    assert.equal(await authCircuit(directory, '24h'), null);
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('stale invalid credentials and interactive circuits remain hard blocks', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  try {
    for (const reason of ['invalid_credentials', 'interactive_auth_required']) {
      const directory = mkdtempSync(join(tmpdir(), `admicro-login-stale-hard-${reason}-`));
      await tripAuthCircuit(directory, '24h', reason);
      const circuitPath = join(directory, 'source-auth-circuit.json');
      const state = JSON.parse(readFileSync(circuitPath, 'utf8'));
      state['24h'].at = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      writeFileSync(circuitPath, JSON.stringify(state));
      const page = loginFixturePage('success');
      await assert.rejects(ensureAuthenticatedSession(page, link(), { directory, login: true, probe: false }), error => error.status === 'auth_blocked');
      assert.equal(page._state().fills, 0);
      assert.equal((await authCircuit(directory, '24h')).reason, reason);
    }
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('real failed submit refreshes temporary circuit and blocks the next submit', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const directory = mkdtempSync(join(tmpdir(), 'admicro-login-refresh-circuit-'));
  try {
    await tripAuthCircuit(directory, '24h', 'authentication_failed');
    const circuitPath = join(directory, 'source-auth-circuit.json');
    const state = JSON.parse(readFileSync(circuitPath, 'utf8'));
    const oldAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    state['24h'].at = oldAt;
    writeFileSync(circuitPath, JSON.stringify(state));
    await assert.rejects(ensureAuthenticatedSession(loginFixturePage('success', { navigation: false }), link(), { directory, login: true, probe: false }), error => error.status === 'authentication_pending');
    const refreshed = await authCircuit(directory, '24h');
    assert.ok(Date.parse(refreshed.at) > Date.parse(oldAt));
    const nextPage = loginFixturePage('success');
    await assert.rejects(ensureAuthenticatedSession(nextPage, link(), { directory, login: true, probe: false }), error => error.status === 'auth_blocked' && /sau khoảng/.test(error.message));
    assert.equal(nextPage._state().fills, 0);
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('successful protected candidate probe clears temporary circuit without submit', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const directory = mkdtempSync(join(tmpdir(), 'admicro-login-candidate-probe-'));
  try {
    await tripAuthCircuit(directory, '24h', 'login_in_progress');
    const candidate = accessDeniedProbePage({ deniedResponses: 0 });
    const result = await ensureAuthenticatedSession(loginFixturePage('success'), link(), {
      directory, job: { useCandidate: true }, login: true, probe: false,
      beforeLogin: async () => candidate
    });
    assert.deepEqual(result, { authenticated: true, refreshed: true });
    assert.equal(await authCircuit(directory, '24h'), null);
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('candidate probe propagates unknown errors and genuine HTTP 403 without submitting', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  try {
    const unknownDirectory = mkdtempSync(join(tmpdir(), 'admicro-login-candidate-unknown-'));
    await tripAuthCircuit(unknownDirectory, '24h', 'login_in_progress');
    const unknownAt = (await authCircuit(unknownDirectory, '24h')).at;
    const browserError = new TypeError('fixture browser failure');
    const unknownCandidate = { url: () => 'https://khachhang.24h.com.vn/report', async evaluate() { throw browserError; } };
    await assert.rejects(ensureAuthenticatedSession(loginFixturePage('success'), link(), {
      directory: unknownDirectory, job: { useCandidate: true }, login: true, probe: false,
      beforeLogin: async () => unknownCandidate,
      loginHandler: async () => { throw new Error('credential submit must not run'); }
    }), error => error === browserError);
    assert.equal((await authCircuit(unknownDirectory, '24h')).at, unknownAt);

    const deniedDirectory = mkdtempSync(join(tmpdir(), 'admicro-login-candidate-403-'));
    await tripAuthCircuit(deniedDirectory, '24h', 'login_in_progress');
    const deniedAt = (await authCircuit(deniedDirectory, '24h')).at;
    await assert.rejects(ensureAuthenticatedSession(loginFixturePage('success'), link(), {
      directory: deniedDirectory, job: { useCandidate: true }, login: true, probe: false,
      beforeLogin: async () => accessDeniedProbePage({ status: 403 }),
      loginHandler: async () => { throw new Error('credential submit must not run'); }
    }), error => error.status === 'access_denied');
    assert.equal((await authCircuit(deniedDirectory, '24h')).at, deniedAt);
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('real ambiguous post-submit denial performs one submit and retains cooldown circuit', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const directory = mkdtempSync(join(tmpdir(), 'admicro-login-real-ambiguous-'));
  try {
    const page = loginFixturePage('success', { deniedResponses: 2 });
    await assert.rejects(ensureAuthenticatedSession(page, link(), { directory, login: true, probe: false }), error => error.status === 'access_denied');
    assert.equal(page._state().fills, 2);
    const circuit = await authCircuit(directory, '24h');
    assert.deepEqual(circuit.reason, 'login_in_progress');
    assert.ok(Date.now() - Date.parse(circuit.at) < 60_000);
    const nextPage = loginFixturePage('success');
    await assert.rejects(ensureAuthenticatedSession(nextPage, link(), { directory, login: true, probe: false }), error => error.status === 'auth_blocked');
    assert.equal(nextPage._state().fills, 0);
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('malformed or unknown open 24h circuits fail closed', async () => {
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  try {
    for (const reason of ['login_in_progress', 'unknown_reason']) {
      const directory = mkdtempSync(join(tmpdir(), `admicro-login-invalid-circuit-${reason}-`));
      await tripAuthCircuit(directory, '24h', reason);
      const circuitPath = join(directory, 'source-auth-circuit.json');
      const state = JSON.parse(readFileSync(circuitPath, 'utf8'));
      if (reason === 'login_in_progress') state['24h'].at = 'not-a-timestamp';
      writeFileSync(circuitPath, JSON.stringify(state));
      await assert.rejects(ensureAuthenticatedSession(loginFixturePage('success'), link(), { directory, login: true, probe: false }), error => error.status === 'auth_blocked');
    }
  } finally {
    for (const [key, value] of Object.entries({ SOURCE_24H_AUTO_LOGIN: previous.enabled, SOURCE_24H_USERNAME: previous.username, SOURCE_24H_PASSWORD: previous.password })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('manual mode preserves the configured report URL and does not enforce auto-login HTTPS', async () => {
  const previous = process.env.SOURCE_24H_AUTO_LOGIN;
  delete process.env.SOURCE_24H_AUTO_LOGIN;
  let receivedOptions;
  const manualLink = link();
  manualLink.url = manualLink.url.replace('https://', 'http://');
  try {
    const result = await collect(manualLink, {
      directory: mkdtempSync(join(tmpdir(), 'admicro-manual-http-')),
      browser: fixtureBrowser(),
      adapterMap: { '24h': { read: async (_page, _link, _from, _to, options) => { receivedOptions = options; return completePeriod(); } } }
    });
    assert.equal(result.complete, true);
    assert.equal(receivedOptions.secureTransport, false);
  } finally {
    if (previous == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous;
  }
});

test('concurrent collections serialize profile use and share one recovery login', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-concurrent-collect-'));
  const previous = { enabled: process.env.SOURCE_24H_AUTO_LOGIN, username: process.env.SOURCE_24H_USERNAME, password: process.env.SOURCE_24H_PASSWORD };
  process.env.SOURCE_24H_AUTO_LOGIN = 'true'; process.env.SOURCE_24H_USERNAME = 'fixture-user'; process.env.SOURCE_24H_PASSWORD = 'fixture-password';
  const browser = fixtureBrowser({ probeFailures: 1 });
  let logins = 0;
  try {
    await Promise.all([1, 2].map(() => collect(link(), {
      directory,
      browser,
      loginHandler: async page => { logins++; page.current = 'https://khachhang.24h.com.vn/report'; },
      adapterMap: fixtureAdapter(async () => completePeriod())
    })));
    assert.equal(logins, 1);
    assert.equal(browser.maxOpen, 1);
  } finally {
    if (previous.enabled == null) delete process.env.SOURCE_24H_AUTO_LOGIN; else process.env.SOURCE_24H_AUTO_LOGIN = previous.enabled;
    if (previous.username == null) delete process.env.SOURCE_24H_USERNAME; else process.env.SOURCE_24H_USERNAME = previous.username;
    if (previous.password == null) delete process.env.SOURCE_24H_PASSWORD; else process.env.SOURCE_24H_PASSWORD = previous.password;
  }
});
