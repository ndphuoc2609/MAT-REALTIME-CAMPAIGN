import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identify, scope } from '../lib/links.mjs';
import { classify24Response, isTransientNetworkError, SourceError, sourceProfileDirectory } from '../lib/connectors.mjs';
import { createApp } from '../source-app.mjs';
import { createMemoryPersistence } from './support/memory-persistence.mjs';

const password = 'correct horse battery staple';

test('only known transient network and timeout failures are retryable', () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('request timed out'), { name: 'TimeoutError' })), true);
  assert.equal(isTransientNetworkError(new SourceError('Sign in again', 'auth_required')), false);
  assert.equal(isTransientNetworkError(new SourceError('Unexpected report schema', 'schema_error')), false);
  assert.equal(isTransientNetworkError(Object.assign(new Error('Forbidden'), { status: 403 })), false);
  assert.equal(isTransientNetworkError(new Error('Could not parse report')), false);
});

test('24h response fixtures distinguish authentication, denied access, schema, and HTTP failures', () => {
  assert.equal(classify24Response({ status: 401 }).status, 'auth_required');
  assert.equal(classify24Response({ status: 200, redirectedToLogin: true }).status, 'auth_required');
  assert.equal(classify24Response({ status: 403 }).status, 'access_denied');
  assert.equal(classify24Response({ status: 200, contentType: 'text/html; charset=utf-8' }).status, 'schema_error');
  assert.equal(classify24Response({ status: 200, invalidJson: true }).status, 'schema_error');
  assert.equal(classify24Response({ status: 503 }).status, 'http_error');
  assert.equal(classify24Response({ status: 200, contentType: 'application/json' }), null);
});

async function signedIn(base, origin) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'retry.admin', password })
  });
  const data = await response.json();
  assert.equal(response.status, 200);
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
}

async function getJob(base, cookie, origin, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/jobs`, { headers: { cookie, origin } });
    const data = await response.json();
    const job = data.jobs.find(item => item.id === id);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`job ${id} did not finish`);
}

test('candidate profile is isolated until a report parses; transient failures retry twice and keep old snapshots until complete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-retry-test-'));
  const persistence = createMemoryPersistence();
  const accounts = persistence.auth;
  const admin = accounts.createUser('retry.admin', password, 'admin', { bootstrap: true });

  const link = identify({
    url: 'https://khachhang.24h.com.vn/report?c_statistic_from_date=01-09-2026&c_statistic_to_date=01-09-2026',
    name: 'Candidate report'
  });
  link.id = 'candidate-report';
  link.scope = scope(link);
  const initial = persistence.store;
  initial.put(link);
  const oldSnapshot = { total: { impressions: 10, clicks: 1 }, daily: [], details: [], warnings: [], complete: true, fetchedAt: '2026-09-01T00:00:00.000Z' };
  initial.commit(link, oldSnapshot, { id: 'old-job', linkId: link.id, scope: link.scope, status: 'success', startedAt: '2026-09-01T00:00:00.000Z' });

  const profile = sourceProfileDirectory(directory, '24h');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'marker'), 'active-profile');
  mkdirSync(`${profile}.pending`, { recursive: true, mode: 0o700 });
  writeFileSync(join(`${profile}.pending`, 'marker'), 'pending-profile');

  let calls = 0;
  const app = createApp({
    directory, schedulerMinutes: 0, retryDelayMs: 2, maxRetries: 2, persistence,
    collector: async () => {
      calls++;
      if (calls === 1) throw new SourceError('Sign in required', 'auth_required');
      if (calls < 4) {
        assert.equal(app.stores.store.result(link).total.impressions, 10, 'old snapshot remains visible during retries');
        throw Object.assign(new Error('socket timed out'), { code: 'ECONNRESET' });
      }
      if (calls > 4) {
        assert.equal(app.stores.store.result(link).total.impressions, 12, 'last complete snapshot remains visible after exhausted network retries');
        throw Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT', name: 'TimeoutError' });
      }
      return {
        total: { impressions: 12, clicks: 2 }, daily: [], details: [], warnings: [], complete: true,
        reconciliation: { status: 'matched' }, fetchedAt: '2026-09-02T00:00:00.000Z'
      };
    }
  });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const identity = await signedIn(base, base);
  try {
    const failedResponse = await fetch(`${base}/api/links/${link.id}/collect`, {
      method: 'POST', headers: { cookie: identity.cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': identity.csrf }, body: '{}'
    });
    const failed = await failedResponse.json();
    assert.equal((await getJob(base, identity.cookie, base, failed.id)).status, 'auth_required');
    assert.equal(readFileSync(join(profile, 'marker'), 'utf8'), 'active-profile');
    assert.equal(readFileSync(join(`${profile}.pending`, 'marker'), 'utf8'), 'pending-profile');
    assert.equal(app.stores.store.result(link).total.impressions, 10);

    const retryResponse = await fetch(`${base}/api/links/${link.id}/collect`, {
      method: 'POST', headers: { cookie: identity.cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': identity.csrf }, body: '{}'
    });
    const retryJob = await retryResponse.json();
    const finished = await getJob(base, identity.cookie, base, retryJob.id);
    assert.equal(finished.status, 'success');
    assert.equal(finished.attempts, 3);
    assert.equal(finished.retries, 2);
    assert.equal(calls, 4); // one auth failure plus three attempts for the second job
    assert.equal(readFileSync(join(profile, 'marker'), 'utf8'), 'pending-profile');
    assert.equal(existsSync(`${profile}.pending`), false);
    const backup = readdirSync(join(directory, 'sessions')).find(name => name.startsWith('24h.previous-'));
    assert.ok(backup, 'previous active profile is retained as a backup');
    assert.equal(readFileSync(join(directory, 'sessions', backup, 'marker'), 'utf8'), 'active-profile');
    assert.equal(app.stores.store.result(link).total.impressions, 12);

    const exhaustedResponse = await fetch(`${base}/api/links/${link.id}/collect`, {
      method: 'POST', headers: { cookie: identity.cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': identity.csrf }, body: '{}'
    });
    const exhaustedJob = await exhaustedResponse.json();
    const terminalNetworkJob = await getJob(base, identity.cookie, base, exhaustedJob.id);
    assert.equal(terminalNetworkJob.status, 'network_error');
    assert.equal(terminalNetworkJob.attempts, 3);
    assert.equal(terminalNetworkJob.retries, 2);
    assert.match(terminalNetworkJob.message, /Kiểm tra kết nối mạng, DNS/);
    assert.equal(calls, 7);
    assert.equal(app.stores.store.result(link).total.impressions, 12);
  } finally { await app.close(); }
});

test('partial collection keeps the last complete snapshot and does not promote a candidate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-partial-test-'));
  const persistence = createMemoryPersistence();
  persistence.auth.createUser('retry.admin', password, 'admin', { bootstrap: true });
  const link = identify({
    url: 'https://khachhang.24h.com.vn/report?c_statistic_from_date=01-09-2026&c_statistic_to_date=02-09-2026',
    name: 'Partial report'
  });
  link.id = 'partial-report'; link.scope = scope(link);
  persistence.store.put(link);
  persistence.store.commit(link, { complete: true, total: { impressions: 10 }, daily: [], details: [], fetchedAt: '2026-09-01T00:00:00.000Z' }, { id: 'old-partial-job', linkId: link.id, scope: link.scope, status: 'success' });

  const profile = sourceProfileDirectory(directory, '24h');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'marker'), 'active-profile');
  mkdirSync(`${profile}.pending`, { recursive: true, mode: 0o700 });
  writeFileSync(join(`${profile}.pending`, 'marker'), 'pending-profile');
  const app = createApp({
    directory, schedulerMinutes: 0, persistence,
    collector: async () => ({ complete: false, total: { impressions: 12 }, daily: [], details: [], reconciliation: { status: 'incomplete' }, fetchedAt: '2026-09-02T00:00:00.000Z' })
  });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const identity = await signedIn(base, base);
  try {
    const response = await fetch(`${base}/api/links/${link.id}/collect`, { method: 'POST', headers: { cookie: identity.cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': identity.csrf }, body: '{}' });
    const job = await getJob(base, identity.cookie, base, (await response.json()).id);
    assert.equal(job.status, 'partial');
    assert.equal(persistence.store.result(link).total.impressions, 10);
    assert.equal(readFileSync(join(profile, 'marker'), 'utf8'), 'active-profile');
    assert.equal(readFileSync(join(`${profile}.pending`, 'marker'), 'utf8'), 'pending-profile');
  } finally { await app.close(); }
});
