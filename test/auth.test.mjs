import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identify, scope } from '../lib/links.mjs';
import { createApp } from '../source-app.mjs';
import { createMemoryPersistence } from './support/memory-persistence.mjs';

const password = 'correct horse battery staple';

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-auth-test-'));
  const persistence = createMemoryPersistence();
  const accounts = persistence.auth;
  const admin = accounts.createUser('admin.test', password, 'admin', { bootstrap: true });
  const viewer = accounts.createUser('viewer.test', password, 'viewer');
  const linkStore = persistence.store;
  const link = identify({ url: 'https://adx.admicro.vn/vn/campaign/detail/103592?fd=2026-09-01&td=2026-09-08&token=do-not-return', name: 'Stored report' });
  link.id = 'stored-link'; link.scope = scope(link); linkStore.put(link);
  linkStore.commit(link, { total: { impressions: 100, clicks: 4 }, daily: [], dailyDetails: [{ extra: { cookie: 'raw-report-secret' }, nested: { extra: 'nested-secret' } }], details: [], warnings: [], complete: true, fetchedAt: '2026-09-08T00:00:00.000Z' }, { id: 'stored-job', linkId: link.id, scope: link.scope, status: 'success', message: 'Done', startedAt: '2026-09-08T00:00:00.000Z' });
  const restricted = identify({ url: 'https://adx.admicro.vn/vn/campaign/detail/103593?fd=2026-09-01&td=2026-09-08', name: 'Restricted report' });
  restricted.id = 'restricted-link'; restricted.scope = scope(restricted); linkStore.put(restricted);
  accounts.replaceGrants(viewer.id, ['stored-link']);
  const app = createApp({ directory, schedulerMinutes: 0, persistence });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  return { directory, admin, viewer, app, base, origin: base, persistence };
}

async function signIn(base, origin, username, pass = password) {
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, password: pass }) });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function api(base, origin, cookie, csrf, path, method = 'GET', value) {
  const headers = { cookie, origin };
  if (method !== 'GET') { headers['content-type'] = 'application/json'; if (csrf) headers['x-csrf-token'] = csrf; }
  const response = await fetch(`${base}${path}`, { method, headers, body: value === undefined ? undefined : JSON.stringify(value) });
  return { response, data: await response.json() };
}

test('admin password reset changes only admin credentials and revokes their sessions', () => {
  const accounts = createMemoryPersistence().auth;
  try {
    const admin = accounts.createUser('reset.admin', password, 'admin', { bootstrap: true });
    const viewer = accounts.createUser('reset.viewer', password, 'viewer');
    const adminSession = accounts.issueSession(admin.id);
    const otherAdminSession = accounts.issueSession(admin.id);
    const viewerSession = accounts.issueSession(viewer.id);
    const newPassword = 'a new secure admin password 2026!';

    assert.throws(() => accounts.resetAdminPassword('missing.admin', newPassword), /Administrator account not found/);
    assert.throws(() => accounts.resetAdminPassword(viewer.username, newPassword), /Administrator account not found/);
    assert.throws(() => accounts.resetAdminPassword(admin.username, 'too short'), /at least 14 characters/);
    assert.equal(accounts.authenticate(adminSession.token).user.id, admin.id);
    assert.equal(accounts.authenticate(viewerSession.token).user.id, viewer.id);
    assert.equal(accounts.verify(admin.username, password).id, admin.id);

    const result = accounts.resetAdminPassword(admin.username, newPassword);
    assert.deepEqual(result, { id: admin.id, username: admin.username, role: 'admin' });
    assert.equal(JSON.stringify(result).includes(newPassword), false);
    assert.equal(accounts.verify(admin.username, newPassword).id, admin.id);
    assert.equal(accounts.verify(admin.username, password), null);
    assert.equal(accounts.authenticate(adminSession.token), null);
    assert.equal(accounts.authenticate(otherAdminSession.token), null);
    assert.equal(accounts.verify(viewer.username, password).id, viewer.id);
    assert.equal(accounts.authenticate(viewerSession.token).user.id, viewer.id);
  } finally { accounts.close(); }
});

test('authenticated APIs enforce roles, CSRF, opaque 24h sessions, and never return source query secrets', async () => {
  const ctx = await setup();
  try {
    const anonymous = await fetch(`${ctx.base}/api/links`);
    assert.equal(anonymous.status, 401);

    const signedViewer = await signIn(ctx.base, ctx.origin, ctx.viewer.username);
    assert.equal(signedViewer.response.status, 200);
    assert.match(signedViewer.response.headers.get('set-cookie'), /HttpOnly/);
    assert.match(signedViewer.response.headers.get('set-cookie'), /SameSite=Strict/);
    assert.match(signedViewer.response.headers.get('set-cookie'), /Max-Age=86400/);
    assert.equal(JSON.stringify(signedViewer.data).includes(password), false);

    const report = await api(ctx.base, ctx.origin, signedViewer.cookie, signedViewer.data.csrfToken, '/api/links');
    assert.equal(report.response.status, 200);
    assert.deepEqual(report.data.links.map(link => link.id), ['stored-link']);
    assert.equal(report.data.links[0].result.total.impressions, 100);
    assert.equal(JSON.stringify(report.data).includes('do-not-return'), false);
    assert.equal(JSON.stringify(report.data).includes('raw-report-secret'), false);
    assert.equal(JSON.stringify(report.data).includes('nested-secret'), false);
    const ungrantedReport = await api(ctx.base, ctx.origin, signedViewer.cookie, signedViewer.data.csrfToken, '/api/links/restricted-link');
    assert.equal(ungrantedReport.response.status, 404);

    const viewerWrite = await api(ctx.base, ctx.origin, signedViewer.cookie, signedViewer.data.csrfToken, '/api/links', 'POST', { name: 'Nope' });
    assert.equal(viewerWrite.response.status, 403);
    const noCsrf = await api(ctx.base, ctx.origin, signedViewer.cookie, null, '/api/auth/logout', 'POST', {});
    assert.equal(noCsrf.response.status, 403);
    const viewerSessions = await api(ctx.base, ctx.origin, signedViewer.cookie, signedViewer.data.csrfToken, '/api/sessions');
    assert.equal(viewerSessions.response.status, 403);
    const viewerJobs = await api(ctx.base, ctx.origin, signedViewer.cookie, signedViewer.data.csrfToken, '/api/jobs');
    assert.equal(viewerJobs.response.status, 403);

    const signedAdmin = await signIn(ctx.base, ctx.origin, ctx.admin.username);
    const sessions = await api(ctx.base, ctx.origin, signedAdmin.cookie, signedAdmin.data.csrfToken, '/api/sessions');
    assert.equal(sessions.response.status, 200);
    assert.equal(sessions.data.sessions.find(x => x.connector === '24h').profileFound, false);
    const added = await api(ctx.base, ctx.origin, signedAdmin.cookie, signedAdmin.data.csrfToken, '/api/links', 'POST', {
      name: 'New source', url: 'https://adx.admicro.vn/vn/campaign/detail/888?fd=2026-09-01&td=2026-09-08&token=secret-again'
    });
    assert.equal(added.response.status, 201);
    assert.equal(JSON.stringify(added.data).includes('secret-again'), false);
    const grantIndex = await api(ctx.base, ctx.origin, signedAdmin.cookie, signedAdmin.data.csrfToken, '/api/admin/grants');
    assert.equal(grantIndex.response.status, 200);
    const changedGrants = await api(ctx.base, ctx.origin, signedAdmin.cookie, signedAdmin.data.csrfToken, `/api/admin/grants/${ctx.viewer.id}`, 'PUT', { linkIds: ['stored-link', added.data.id] });
    assert.equal(changedGrants.response.status, 200);
    const grantedDetail = await api(ctx.base, ctx.origin, signedViewer.cookie, signedViewer.data.csrfToken, `/api/links/${added.data.id}`);
    assert.equal(grantedDetail.response.status, 200);
    await api(ctx.base, ctx.origin, signedAdmin.cookie, signedAdmin.data.csrfToken, `/api/admin/grants/${ctx.viewer.id}`, 'PUT', { linkIds: ['stored-link'] });
    const revokedDetail = await api(ctx.base, ctx.origin, signedViewer.cookie, signedViewer.data.csrfToken, `/api/links/${added.data.id}`);
    assert.equal(revokedDetail.response.status, 404);
    const changed = await api(ctx.base, ctx.origin, signedAdmin.cookie, signedAdmin.data.csrfToken, `/api/links/${added.data.id}`, 'PATCH', {
      name: 'Updated source', url: 'https://adx.admicro.vn/vn/campaign/detail/889?fd=2026-09-01&td=2026-09-08&token=updated-secret'
    });
    assert.equal(changed.response.status, 200);
    assert.equal(JSON.stringify(changed.data).includes('updated-secret'), false);
    const deleted = await api(ctx.base, ctx.origin, signedAdmin.cookie, signedAdmin.data.csrfToken, `/api/links/${added.data.id}`, 'DELETE');
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.data.snapshotsRetained, true);
    assert.equal(ctx.app.stores.store.result({ id: 'stored-link', scope: scope(identify({ url: 'https://adx.admicro.vn/vn/campaign/detail/103592?fd=2026-09-01&td=2026-09-08&token=do-not-return' })) }).total.impressions, 100);

    const wrongOrigin = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(wrongOrigin.status, 403);
  } finally { await ctx.app.close(); }
});

test('login attempts are rate-limited and sessions persist across app restarts', async () => {
  const ctx = await setup();
  try {
    let latest;
    for (let attempt = 0; attempt < 5; attempt++) {
      latest = await signIn(ctx.base, ctx.origin, ctx.viewer.username, 'incorrect password');
      assert.equal(latest.response.status, 401);
    }
    latest = await signIn(ctx.base, ctx.origin, ctx.viewer.username, 'incorrect password');
    assert.equal(latest.response.status, 429);
  } finally { await ctx.app.close(); }

  const accounts = ctx.persistence.auth;
  const established = accounts.verify(ctx.viewer.username, password);
  const session = accounts.issueSession(established.id);
  const restarted = createApp({ directory: ctx.directory, schedulerMinutes: 0, persistence: ctx.persistence });
  const address = await restarted.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, { headers: { cookie: `admicro_session=${session.token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.role, 'viewer');
  } finally { await restarted.close(); }
});
