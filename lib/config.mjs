import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Only settings explicitly listed here are read from a local .env file. Source
// credentials are supported for the source auto-login flows, but are never logged
// or returned to a caller.
const allowed = new Set(['PORT', 'HOST', 'DATA_DIR', 'DATABASE_URL', 'SYNC_INTERVAL_MINUTES', 'TRUST_PROXY', 'COOKIE_SECURE', 'PUBLIC_ORIGIN', 'CHROME_BIN', 'HOUSEKEEPING_ENABLED', 'HOUSEKEEPING_INTERVAL_MINUTES', 'HOUSEKEEPING_SNAPSHOT_RETAIN', 'HOUSEKEEPING_JOB_RETENTION_DAYS', 'HOUSEKEEPING_CACHE_ENABLED', 'SOURCE_24H_USERNAME', 'SOURCE_24H_PASSWORD', 'SOURCE_24H_AUTO_LOGIN', 'SOURCE_24H_ALLOW_INSECURE_HTTP', 'SOURCE_ADMICRO_USERNAME', 'SOURCE_ADMICRO_PASSWORD', 'SOURCE_ADMICRO_AUTO_LOGIN']);

export function parseBoolean(value, fallback = false, name = 'SOURCE_24H_AUTO_LOGIN') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be one of true/false, yes/no, or 1/0.`);
}

function boundedInteger(value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}

export function housekeepingConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.HOUSEKEEPING_ENABLED, true, 'HOUSEKEEPING_ENABLED'),
    intervalMinutes: boundedInteger(env.HOUSEKEEPING_INTERVAL_MINUTES, 360, 'HOUSEKEEPING_INTERVAL_MINUTES', { min: 5, max: 7 * 24 * 60 }),
    snapshotRetain: boundedInteger(env.HOUSEKEEPING_SNAPSHOT_RETAIN, 3, 'HOUSEKEEPING_SNAPSHOT_RETAIN', { min: 3, max: 1000 }),
    jobRetentionDays: boundedInteger(env.HOUSEKEEPING_JOB_RETENTION_DAYS, 90, 'HOUSEKEEPING_JOB_RETENTION_DAYS', { min: 1, max: 3650 }),
    cacheEnabled: parseBoolean(env.HOUSEKEEPING_CACHE_ENABLED, true, 'HOUSEKEEPING_CACHE_ENABLED')
  };
}

export function source24hAutoLoginEnabled(env = process.env) {
  return parseBoolean(env.SOURCE_24H_AUTO_LOGIN, false);
}

export function source24hAllowInsecureHttp(env = process.env) {
  return parseBoolean(env.SOURCE_24H_ALLOW_INSECURE_HTTP, false, 'SOURCE_24H_ALLOW_INSECURE_HTTP');
}

export function source24hConfig(env = process.env) {
  const enabled = source24hAutoLoginEnabled(env);
  return {
    autoLogin: enabled,
    username: enabled ? String(env.SOURCE_24H_USERNAME || '').trim() : '',
    password: enabled ? String(env.SOURCE_24H_PASSWORD || '') : ''
  };
}

export function sourceAdmicroAutoLoginEnabled(env = process.env) {
  return parseBoolean(env.SOURCE_ADMICRO_AUTO_LOGIN, false, 'SOURCE_ADMICRO_AUTO_LOGIN');
}

export function sourceAdmicroConfig(env = process.env) {
  const enabled = sourceAdmicroAutoLoginEnabled(env);
  return {
    autoLogin: enabled,
    username: enabled ? String(env.SOURCE_ADMICRO_USERNAME || '').trim() : '',
    password: enabled ? String(env.SOURCE_ADMICRO_PASSWORD || '') : ''
  };
}

export function loadLocalConfig(projectRoot) {
  try {
    const content = readFileSync(join(projectRoot, '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* Optional local config file. */ }
}
