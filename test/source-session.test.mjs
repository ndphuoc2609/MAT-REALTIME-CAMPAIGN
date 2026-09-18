import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rename as nativeRename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { housekeepingConfig, parseBoolean, source24hAutoLoginEnabled, source24hAllowInsecureHttp, source24hConfig, sourceAdmicroAutoLoginEnabled, sourceAdmicroConfig } from '../lib/config.mjs';
import { acquireProfileLock, authCircuit, promoteVerifiedProfile, recoverProfilePromotion, resetAuthCircuit, tripAuthCircuit, withProfileLock } from '../lib/source-session.mjs';

test('source auto-login config parses false explicitly and does not expose disabled credentials', () => {
  assert.equal(parseBoolean('false'), false);
  assert.equal(parseBoolean('0'), false);
  assert.equal(parseBoolean('TRUE'), true);
  assert.throws(() => parseBoolean('sometimes'), /SOURCE_24H_AUTO_LOGIN/);
  assert.equal(source24hAutoLoginEnabled({ SOURCE_24H_AUTO_LOGIN: 'false', SOURCE_24H_USERNAME: 'unused' }), false);
  assert.equal(source24hAllowInsecureHttp({}), false);
  assert.equal(source24hAllowInsecureHttp({ SOURCE_24H_ALLOW_INSECURE_HTTP: 'true' }), true);
  assert.throws(() => source24hAllowInsecureHttp({ SOURCE_24H_ALLOW_INSECURE_HTTP: 'sometimes' }), /SOURCE_24H_ALLOW_INSECURE_HTTP/);
  assert.deepEqual(housekeepingConfig({}), { enabled: true, intervalMinutes: 360, snapshotRetain: 3, jobRetentionDays: 90, cacheEnabled: true });
  assert.throws(() => housekeepingConfig({ HOUSEKEEPING_SNAPSHOT_RETAIN: '2' }), /HOUSEKEEPING_SNAPSHOT_RETAIN/);
  assert.deepEqual(source24hConfig({ SOURCE_24H_AUTO_LOGIN: 'false', SOURCE_24H_USERNAME: 'user', SOURCE_24H_PASSWORD: 'secret' }), { autoLogin: false, username: '', password: '' });
  assert.deepEqual(source24hConfig({ SOURCE_24H_AUTO_LOGIN: 'true', SOURCE_24H_USERNAME: 'user', SOURCE_24H_PASSWORD: 'secret' }), { autoLogin: true, username: 'user', password: 'secret' });
  assert.equal(sourceAdmicroAutoLoginEnabled({ SOURCE_ADMICRO_AUTO_LOGIN: 'false' }), false);
  assert.deepEqual(sourceAdmicroConfig({ SOURCE_ADMICRO_AUTO_LOGIN: 'false', SOURCE_ADMICRO_USERNAME: 'user', SOURCE_ADMICRO_PASSWORD: 'secret' }), { autoLogin: false, username: '', password: '' });
  assert.deepEqual(sourceAdmicroConfig({ SOURCE_ADMICRO_AUTO_LOGIN: 'true', SOURCE_ADMICRO_USERNAME: 'user', SOURCE_ADMICRO_PASSWORD: 'secret' }), { autoLogin: true, username: 'user', password: 'secret' });
  assert.throws(() => sourceAdmicroAutoLoginEnabled({ SOURCE_ADMICRO_AUTO_LOGIN: 'sometimes' }), /SOURCE_ADMICRO_AUTO_LOGIN/);
});

test('profile lock serializes workers and recovers an old abandoned lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-session-lock-'));
  const events = [];
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const first = withProfileLock(directory, '24h', async () => {
    events.push('first-start');
    started();
    await new Promise(resolve => setTimeout(resolve, 30));
    events.push('first-end');
  });
  await firstStarted;
  const second = withProfileLock(directory, '24h', async () => events.push('second'));
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);

  const lock = await acquireProfileLock(directory, '24h', { timeoutMs: 200 });
  await lock.release();
});

test('authentication circuit is durable and explicitly resettable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-auth-circuit-'));
  assert.equal(await authCircuit(directory, '24h'), null);
  await tripAuthCircuit(directory, '24h', 'authentication_failed');
  assert.deepEqual((await authCircuit(directory, '24h')).reason, 'authentication_failed');
  await resetAuthCircuit(directory, '24h');
  assert.equal(await authCircuit(directory, '24h'), null);
});

test('kernel lock loss is observable and cannot be mistaken for a released lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-lock-loss-'));
  const lock = await acquireProfileLock(directory, '24h', { timeoutMs: 500 });
  process.kill(lock.pid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => lock.assertHeld(), /Khóa phiên nguồn đã mất/);
  await lock.release();
});

test('promotion journal recovers before a browser can recreate the active profile', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-promotion-recover-'));
  const active = join(directory, 'sessions', '24h');
  const previous = `${active}.previous-crash`;
  const candidate = `${active}.pending`;
  mkdirSync(previous, { recursive: true });
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(previous, 'marker'), 'old');
  writeFileSync(join(candidate, 'marker'), 'new');
  writeFileSync(`${active}.promotion.json`, JSON.stringify({ active, candidate, previous, phase: 'active-moved' }));
  assert.equal(await recoverProfilePromotion(active), true);
  assert.equal(readFileSync(join(active, 'marker'), 'utf8'), 'old');
  assert.equal(readFileSync(join(candidate, 'marker'), 'utf8'), 'new');
  assert.equal(existsSync(`${active}.promotion.json`), false);
});

test('promotion rollback retains active profile and journal when candidate rename fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-promotion-rollback-'));
  const active = join(directory, 'sessions', '24h');
  const candidate = `${active}.pending`;
  mkdirSync(active, { recursive: true });
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(active, 'marker'), 'old');
  writeFileSync(join(candidate, 'marker'), 'new');
  const failingRename = async (from, to) => {
    if (from === candidate) throw new Error('injected candidate rename failure');
    return nativeRename(from, to);
  };
  await assert.rejects(promoteVerifiedProfile(active, { renameFn: failingRename }), /injected candidate rename failure/);
  assert.equal(readFileSync(join(active, 'marker'), 'utf8'), 'old');
  assert.equal(readFileSync(join(candidate, 'marker'), 'utf8'), 'new');
  assert.equal(existsSync(`${active}.promotion.json`), true);
});
