import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acquireProfileLock } from './source-session.mjs';

export const TERMINAL_SYNC_STATUSES = Object.freeze([
  'success', 'partial', 'error', 'network_error', 'auth_required', 'auth_blocked',
  'authentication_failed', 'authentication_pending', 'invalid_credentials', 'config_error', 'schema_error',
  'access_denied', 'http_error', 'needs_inspection', 'transport_security',
  'interactive_auth_required', 'debug_unsafe'
]);

const PROFILE_NAMES = Object.freeze(['24h', 'admicro', 'fpt']);
const REBUILDABLE_CACHE_NAMES = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache',
  'GPUPersistentCache', 'BrowserMetrics', 'Safe Browsing', 'component_crx_cache',
  'extensions_crx_cache', 'segmentation_platform'
]);
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'waiting_login']);

const noopLogger = () => {};

async function removeKnownCaches(root) {
  let removed = 0;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const target = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (REBUILDABLE_CACHE_NAMES.has(entry.name)) {
      await rm(target, { recursive: true, force: true });
      removed++;
      continue;
    }
    removed += await removeKnownCaches(target);
  }
  return removed;
}

async function profileRoots(sessionsRoot, profileName) {
  const active = join(sessionsRoot, profileName);
  const roots = { active: null, backups: [] };
  let entries;
  try { entries = await readdir(sessionsRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return roots; throw error; }
  const activeEntry = entries.find(entry => entry.name === profileName);
  if (activeEntry?.isDirectory() && !activeEntry.isSymbolicLink()) roots.active = active;
  const prefix = `${profileName}.previous-`;
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(prefix)) {
      const path = join(sessionsRoot, entry.name);
      const modifiedAt = (await stat(path)).mtimeMs;
      const timestamp = Number(entry.name.match(/\.previous-(\d+)-/)?.[1]);
      roots.backups.push({ path, modifiedAt, sortKey: Number.isFinite(timestamp) ? timestamp : modifiedAt });
    }
  }
  return roots;
}

async function cleanSourceCaches(directory, profileName) {
  const sessionsRoot = join(resolve(directory), 'sessions');
  const active = join(sessionsRoot, profileName);
  const pending = `${active}.pending`;
  const journal = `${active}.promotion.json`;
  if (existsSync(pending) || existsSync(journal)) return { profile: profileName, status: 'skipped', reason: 'profile_transition', removed: 0 };
  const roots = await profileRoots(sessionsRoot, profileName);
  if (!roots.active && !roots.backups.length) return { profile: profileName, status: 'absent', removed: 0 };
  let lock;
  try {
    lock = await acquireProfileLock(directory, profileName, { timeoutMs: 0 });
  } catch {
    return { profile: profileName, status: 'skipped', reason: 'profile_locked', removed: 0 };
  }
  try {
    let removed = 0;
    let backupsRemoved = 0;
    const backups = [...roots.backups].sort((a, b) => b.sortKey - a.sortKey || b.modifiedAt - a.modifiedAt || b.path.localeCompare(a.path));
    const retainedBackup = backups[0]?.path || null;
    if (roots.active) removed += await removeKnownCaches(roots.active);
    if (retainedBackup) removed += await removeKnownCaches(retainedBackup);
    for (const backup of backups.slice(1)) {
      await rm(backup.path, { recursive: true, force: true });
      backupsRemoved++;
    }
    return { profile: profileName, status: 'cleaned', removed, backupsRetained: retainedBackup ? 1 : 0, backupsRemoved };
  } finally { await lock.release(); }
}

export async function cleanChromiumCaches(directory, { logger = noopLogger } = {}) {
  const results = [];
  for (const profileName of PROFILE_NAMES) {
    try { results.push(await cleanSourceCaches(directory, profileName)); }
    catch (error) {
      logger('Housekeeping skipped one browser profile cache cleanup.');
      results.push({ profile: profileName, status: 'error', removed: 0 });
    }
  }
  return results;
}

export async function runHousekeeping({
  store,
  directory,
  now = () => new Date(),
  snapshotRetain = 3,
  jobRetentionDays = 90,
  cacheEnabled = true,
  isIdle = async () => true,
  logger = noopLogger
} = {}) {
  try {
    if (!(await isIdle())) return { status: 'skipped', reason: 'sync_busy', snapshotsRemoved: 0, jobsRemoved: 0, caches: [] };
    const current = typeof now === 'function' ? now() : now;
    const cutoff = new Date(current).getTime() - Number(jobRetentionDays) * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(cutoff)) throw new Error('Invalid housekeeping clock.');
    if (typeof store?.pruneHousekeeping !== 'function') throw new Error('Persistence adapter does not support housekeeping.');
    const pruned = await store.pruneHousekeeping({
      keepSnapshots: Math.max(3, Number(snapshotRetain)),
      jobCutoff: new Date(cutoff),
      terminalStatuses: TERMINAL_SYNC_STATUSES
    });
    const caches = cacheEnabled ? await cleanChromiumCaches(directory, { logger }) : [];
    return { status: 'completed', snapshotsRemoved: Number(pruned?.snapshotsRemoved || 0), jobsRemoved: Number(pruned?.jobsRemoved || 0), caches };
  } catch (error) {
    logger('Housekeeping failed; it will be retried on the next run.');
    return { status: 'error', snapshotsRemoved: 0, jobsRemoved: 0, caches: [] };
  }
}

export function hasActiveSyncJobs(jobs) {
  return Array.isArray(jobs) && jobs.some(job => ACTIVE_JOB_STATUSES.has(String(job?.status || '')));
}
