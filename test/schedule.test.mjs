import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../source-app.mjs';
import { identify, scope } from '../lib/links.mjs';
import { sourceProfileDirectory } from '../lib/connectors.mjs';
import { createMemoryPersistence } from './support/memory-persistence.mjs';

const password = 'correct horse battery staple';
const beforeSchedule = new Date('2026-02-01T16:00:00.000Z'); // 00:00 in Ho Chi Minh City
const afterSchedule = new Date('2026-02-01T20:30:00.000Z'); // 03:30 in Ho Chi Minh City

function seedSource(persistence, id, withSnapshot = false) {
  const store = persistence.store;
  const link = identify({
    name: id,
    url: `https://khachhang.24h.com.vn/report?c_statistic_from_date=01-02-2026&c_statistic_to_date=01-02-2026`
  });
  link.id = id;
  link.scope = scope(link);
  store.put(link);
  if (withSnapshot) store.commit(link, {
    total: { impressions: 1, clicks: 1 }, daily: [], dailyDetails: [], details: [], warnings: [],
    complete: true, reconciliation: { status: 'matched' }, fetchedAt: '2026-02-01T00:00:00.000Z'
  }, { id: `${id}-old`, linkId: id, scope: link.scope, status: 'success', startedAt: '2026-02-01T00:00:00.000Z' });
  return link;
}

async function setup({ schedulerMinutes = 1440, clock = beforeSchedule, seed, collector } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-schedule-test-'));
  const persistence = createMemoryPersistence();
  const auth = persistence.auth;
  const admin = auth.createUser('schedule.admin', password, 'admin', { bootstrap: true });
  const viewer = auth.createUser('schedule.viewer', password, 'viewer');
  const link = seed?.(persistence, directory) || null;
  const app = createApp({ directory, schedulerMinutes, now: () => new Date(clock), collector: collector || (async () => completeReport(clock)), persistence });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  return { directory, admin, viewer, link, app, base, persistence };
}

function completeReport(clock) {
  return {
    total: { impressions: 10, clicks: 2 }, daily: [], dailyDetails: [], details: [], warnings: [],
    complete: true, reconciliation: { status: 'matched' }, fetchedAt: new Date(clock).toISOString()
  };
}

async function signIn(base, username) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await response.json();
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
}

async function api(base, identity, path, method = 'GET', value, csrf = identity.csrf) {
  const headers = { cookie: identity.cookie, origin: base };
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const response = await fetch(`${base}${path}`, { method, headers, body: value === undefined ? undefined : JSON.stringify(value) });
  return { response, data: await response.json() };
}

async function waitForJobs(app, linkId, count) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const jobs = app.stores.store.jobs().filter(job => job.linkId === linkId);
    if (jobs.length >= count && jobs.every(job => !['queued', 'running'].includes(job.status))) return jobs;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`expected ${count} completed jobs for ${linkId}`);
}

test('admin schedule API validates time and auth; complete added and edited sources queue automatically', async () => {
  const ctx = await setup({ schedulerMinutes: 1440, collector: async (_link, options) => {
    assert.equal(options.useCandidate, false);
    return completeReport(beforeSchedule);
  } });
  try {
    const admin = await signIn(ctx.base, ctx.admin.username);
    const viewer = await signIn(ctx.base, ctx.viewer.username);
    const initial = await api(ctx.base, admin, '/api/jobs');
    assert.deepEqual(initial.data.schedule, { enabled: true, time: '02:00', timeZone: 'Asia/Ho_Chi_Minh', initialEnabled: true });

    const forbidden = await api(ctx.base, viewer, '/api/jobs/schedule', 'PUT', { enabled: true, time: '03:15' });
    assert.equal(forbidden.response.status, 403);
    const noCsrf = await api(ctx.base, admin, '/api/jobs/schedule', 'PUT', { enabled: true, time: '03:15' }, null);
    assert.equal(noCsrf.response.status, 403);
    const invalid = await api(ctx.base, admin, '/api/jobs/schedule', 'PUT', { enabled: true, time: '24:00' });
    assert.equal(invalid.response.status, 400);
    const saved = await api(ctx.base, admin, '/api/jobs/schedule', 'PUT', { enabled: true, time: '03:15' });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.schedule.time, '03:15');

    const added = await api(ctx.base, admin, '/api/links', 'POST', {
      name: 'Scheduled report', url: 'https://adx.admicro.vn/vn/campaign/detail/888?fd=2026-02-01&td=2026-02-08'
    });
    assert.equal(added.response.status, 201);
    assert.ok(['queued', 'running', 'success'].includes(added.data.job.status));
    const firstJobs = await waitForJobs(ctx.app, added.data.id, 1);
    assert.equal(firstJobs[0].status, 'success');

    const edited = await api(ctx.base, admin, `/api/links/${added.data.id}`, 'PATCH', { name: 'Edited report' });
    assert.equal(edited.response.status, 200);
    const editedJobs = await waitForJobs(ctx.app, added.data.id, 2);
    assert.equal(editedJobs.length, 2);
    assert.ok(editedJobs.every(job => job.status === 'success'));
  } finally { await ctx.app.close(); }
});

test('daily scheduler tries a pending candidate once per local calendar date', async () => {
  let calls = 0;
  const ctx = await setup({
    clock: afterSchedule,
    seed(persistence, directory) {
      const link = seedSource(persistence, 'scheduled-candidate', true);
      const profile = sourceProfileDirectory(directory, link.connector);
      mkdirSync(`${profile}.pending`, { recursive: true, mode: 0o700 });
      writeFileSync(join(`${profile}.pending`, 'marker'), 'candidate');
      const store = persistence.store;
      store.setMetadata('auto-sync-enabled', '1');
      store.setMetadata('auto-sync-time', '02:00');
      return link;
    },
    collector: async (_link, options) => {
      calls++;
      assert.equal(options.useCandidate, true);
      return completeReport(afterSchedule);
    }
  });
  try {
    const jobs = await waitForJobs(ctx.app, ctx.link.id, 2);
    const scheduled = jobs.filter(job => job.id !== `${ctx.link.id}-old`);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].status, 'success');
    assert.equal(scheduled[0].scheduledDate, '2026-02-02');
    const profile = sourceProfileDirectory(ctx.directory, ctx.link.connector);
    assert.equal(existsSync(`${profile}.pending`), false);
    assert.equal(readFileSync(join(profile, 'marker'), 'utf8'), 'candidate');

    const admin = await signIn(ctx.base, ctx.admin.username);
    await api(ctx.base, admin, '/api/jobs/schedule', 'PUT', { enabled: true, time: '02:00' });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(ctx.app.stores.store.jobs().filter(job => job.linkId === ctx.link.id).length, 2);
    assert.equal(calls, 1);
  } finally { await ctx.app.close(); }
});

test('startup catches up missing snapshots despite today metadata; zero interval defaults off but admin can enable', async () => {
  let calls = 0;
  const ctx = await setup({
    schedulerMinutes: 0,
    seed(persistence) {
      const link = seedSource(persistence, 'startup-catchup');
      const store = persistence.store;
      store.setMetadata('auto-sync-enabled', '1');
      store.setMetadata('auto-sync-time', '02:00');
      store.setMetadata('last-scheduled-date', '2026-02-02');
      return link;
    },
    collector: async () => { calls++; return completeReport(beforeSchedule); }
  });
  try {
    const jobs = await waitForJobs(ctx.app, ctx.link.id, 1);
    assert.equal(jobs[0].status, 'success');
    assert.equal(calls, 1);
  } finally { await ctx.app.close(); }

  let optOutCalls = 0;
  const optedOut = await setup({ schedulerMinutes: 0, seed: persistence => seedSource(persistence, 'opted-out-source'), collector: async () => { optOutCalls++; return completeReport(beforeSchedule); } });
  try {
    const admin = await signIn(optedOut.base, optedOut.admin.username);
    const initial = await api(optedOut.base, admin, '/api/jobs');
    assert.equal(initial.data.schedule.enabled, false);
    assert.equal(initial.data.schedule.initialEnabled, false);
    assert.equal(optedOut.app.stores.store.jobs().length, 0);
    const enabled = await api(optedOut.base, admin, '/api/jobs/schedule', 'PUT', { enabled: true, time: '02:00' });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.data.schedule.enabled, true);
    const jobsAfterEnable = await waitForJobs(optedOut.app, optedOut.link.id, 1);
    assert.equal(jobsAfterEnable[0].status, 'success');
    assert.equal(optOutCalls, 1);
  } finally { await optedOut.app.close(); }
});
