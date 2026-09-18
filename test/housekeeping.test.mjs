import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryPersistence } from './support/memory-persistence.mjs';
import { cleanChromiumCaches, runHousekeeping } from '../lib/housekeeping.mjs';
import { acquireProfileLock } from '../lib/source-session.mjs';
import { createApp } from '../source-app.mjs';

const link = { id: 'source-1', scope: 'scope-1', connector: '24h' };

test('housekeeping keeps the latest three snapshots and only prunes old terminal jobs', async () => {
  const { store } = createMemoryPersistence();
  for (let index = 0; index < 5; index++) {
    store.commit(link, { complete: true, fetchedAt: `2026-01-0${index + 1}T00:00:00.000Z`, value: index }, { id: `job-${index}`, status: 'success' });
  }
  store.putJob({ id: 'old-error', status: 'error', finishedAt: '2025-01-01T00:00:00.000Z' });
  store.putJob({ id: 'old-queued', status: 'queued', finishedAt: '2025-01-01T00:00:00.000Z' });
  store.putJob({ id: 'recent-success', status: 'success', finishedAt: '2026-09-01T00:00:00.000Z' });
  const result = await runHousekeeping({ store, directory: mkdtempSync(join(tmpdir(), 'admicro-housekeeping-db-')), now: () => new Date('2026-09-18T00:00:00.000Z'), cacheEnabled: false });
  assert.equal(result.status, 'completed');
  assert.equal(result.snapshotsRemoved, 2);
  assert.equal(result.jobsRemoved, 1);
  assert.equal(store.snapshotCount(), 3);
  assert.equal(store.result(link).value, 4);
  const jobs = store.jobs();
  assert.ok(jobs.some(job => job.id === 'old-queued'));
  assert.ok(jobs.some(job => job.id === 'recent-success'));
  assert.ok(!jobs.some(job => job.id === 'old-error'));
});

test('cache cleanup removes only known caches, keeps profile data and newest backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-housekeeping-cache-'));
  const sessions = join(directory, 'sessions');
  const active = join(sessions, '24h');
  const oldBackup = join(sessions, '24h.previous-old');
  const newestBackup = join(sessions, '24h.previous-new');
  mkdirSync(join(active, 'Default', 'Cache'), { recursive: true });
  mkdirSync(join(active, 'Default', 'DawnWebGPUCache'), { recursive: true });
  mkdirSync(join(active, 'Default', 'Local Storage'), { recursive: true });
  writeFileSync(join(active, 'Default', 'Cache', 'stale'), 'cache');
  writeFileSync(join(active, 'Default', 'DawnWebGPUCache', 'stale'), 'cache');
  writeFileSync(join(active, 'Default', 'Local Storage', 'keep'), 'cookie-state');
  mkdirSync(join(oldBackup, 'Cache'), { recursive: true });
  mkdirSync(join(newestBackup, 'Cache'), { recursive: true });
  writeFileSync(join(oldBackup, 'Cache', 'stale'), 'old');
  writeFileSync(join(newestBackup, 'Cache', 'stale'), 'new');
  utimesSync(oldBackup, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  utimesSync(newestBackup, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));
  const pending = join(sessions, 'admicro.pending');
  mkdirSync(join(pending, 'Cache'), { recursive: true });
  writeFileSync(join(pending, 'Cache', 'keep'), 'pending');

  const result = await cleanChromiumCaches(directory);
  assert.equal(result.find(item => item.profile === '24h').status, 'cleaned');
  assert.equal(result.find(item => item.profile === '24h').backupsRemoved, 1);
  assert.equal(result.find(item => item.profile === 'admicro').reason, 'profile_transition');
  assert.equal(existsSync(join(active, 'Default', 'Cache')), false);
  assert.equal(existsSync(join(active, 'Default', 'DawnWebGPUCache')), false);
  assert.equal(readFileSync(join(active, 'Default', 'Local Storage', 'keep'), 'utf8'), 'cookie-state');
  assert.equal(existsSync(oldBackup), false);
  assert.equal(existsSync(newestBackup), true);
  assert.equal(existsSync(join(newestBackup, 'Cache')), false);
  assert.equal(existsSync(join(pending, 'Cache', 'keep')), true);
});

test('housekeeping skips while the application reports active or queued work', async () => {
  const { store } = createMemoryPersistence();
  let calls = 0;
  const result = await runHousekeeping({ store, directory: mkdtempSync(join(tmpdir(), 'admicro-housekeeping-busy-')), isIdle: async () => false, cacheEnabled: false, logger: () => { calls++; } });
  assert.equal(result.status, 'skipped');
  assert.equal(calls, 0);
});

test('cache cleanup skips a profile held by the source lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-housekeeping-lock-'));
  const cache = join(directory, 'sessions', '24h', 'Cache');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'keep'), 'locked');
  const lock = await acquireProfileLock(directory, '24h', { timeoutMs: 1000 });
  try {
    const result = await cleanChromiumCaches(directory);
    const source = result.find(item => item.profile === '24h');
    assert.equal(source.status, 'skipped');
    assert.equal(source.reason, 'profile_locked');
    assert.equal(existsSync(join(cache, 'keep')), true);
  } finally { await lock.release(); }
});

test('application starts housekeeping independently of the scheduler', async () => {
  const calls = [];
  const app = createApp({
    directory: mkdtempSync(join(tmpdir(), 'admicro-housekeeping-app-test-')),
    schedulerMinutes: 0,
    persistence: createMemoryPersistence(),
    housekeepingRunner: async options => { calls.push(options); return { status: 'completed', snapshotsRemoved: 0, jobsRemoved: 0, caches: [] }; }
  });
  await app.ready;
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].isIdle, 'function');
  await app.close();
});
