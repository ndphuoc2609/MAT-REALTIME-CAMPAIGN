import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { identify, scope, safeLink, groups, aggregateReports, month } from './lib/links.mjs';
import { validateDisplayName } from './lib/name-validation.mjs';
import { openStore } from './lib/link-store.mjs';
import { housekeepingConfig, loadLocalConfig, source24hAutoLoginEnabled, sourceAdmicroAutoLoginEnabled } from './lib/config.mjs';
import { openAuthStore } from './lib/auth-store.mjs';
import { createPostgresPool } from './lib/postgres-persistence.mjs';
import { collect, closeBrowserContexts, sourceProfileDirectory, isTransientNetworkError } from './lib/connectors.mjs';
import { SourceError } from './lib/source-error.mjs';
import { ensureGoogleAdsMonthlyLinks, GOOGLE_CONNECTOR } from './lib/google-ads.mjs';
import { authCircuit, promoteVerifiedProfile, recoverProfilePromotion, resetAuthCircuit, withProfileLock } from './lib/source-session.mjs';
import { hasActiveSyncJobs, runHousekeeping } from './lib/housekeeping.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'admicro_session';
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME_SECONDS = SESSION_LIFETIME_MS / 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 5;
const ADMIN_CONNECTORS = ['admicro-pc', 'admicro-mobile', '24h', 'fpt'];
const SCHEDULE_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const DEFAULT_SCHEDULE_TIME = '02:00';

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const knownJobStatuses = new Set([
  'success', 'partial', 'error', 'network_error', 'auth_required', 'auth_blocked',
  'authentication_failed', 'authentication_pending', 'invalid_credentials', 'config_error',
  'schema_error', 'access_denied', 'http_error', 'needs_inspection', 'transport_security',
  'interactive_auth_required', 'debug_unsafe', 'session_busy'
]);
const storageErrorCodes = new Set(['EACCES', 'EPERM', 'EROFS']);
const diskErrorCodes = new Set(['ENOSPC', 'EDQUOT']);
const browserRuntimeError = /(?:browserType\.(?:launch|launchPersistentContext)|(?:chrom(?:e|ium)|playwright).*(?:launch|executable|browser)|executable(?:\s+doesn't|\s+does not|\s+not)?\s+exist|browser\s+(?:was\s+)?not\s+found|failed\s+to\s+launch|spawn\s+(?:chrome|chromium)|target\s+(?:page|context|browser)\s+or\s+browser\s+has\s+been\s+closed)/i;
export function classifyJobError(error) {
  if (error instanceof HttpError || error instanceof SourceError) return error;
  if (error && (typeof error.status === 'number' || knownJobStatuses.has(String(error.status || '')))) return error;
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  const location = String(error?.path || error?.filename || '');
  const storageLocation = /(?:[\\/]data(?:[\\/]|$)|sessions|profile|data_dir)/i.test(`${message} ${location}`);
  if (storageErrorCodes.has(code) || (['ENOENT', 'ENOTDIR'].includes(code) && storageLocation) || /(?:permission denied|operation not permitted|read-only file system)/i.test(message)) {
    return new SourceError('Máy chủ không có quyền đọc/ghi DATA_DIR hoặc hồ sơ nguồn. Kiểm tra quyền thư mục và profile rồi chạy lại.', 'config_error');
  }
  if (diskErrorCodes.has(code) || /(?:no space left on device|disk quota exceeded|out of disk space)/i.test(message)) {
    return new SourceError('Ổ đĩa máy chủ không còn đủ dung lượng cho DATA_DIR hoặc hồ sơ nguồn. Giải phóng dung lượng rồi chạy lại.', 'config_error');
  }
  if (browserRuntimeError.test(message) || /(?:chrom(?:e|ium)|playwright)/i.test(location)) {
    return new SourceError('Không khởi động được browser runtime cho nguồn. Kiểm tra Google Chrome/Chromium, CHROME_BIN và quyền chạy rồi thử lại.', 'config_error');
  }
  return new SourceError('Lỗi runtime khi đồng bộ nguồn. Kiểm tra log máy chủ và cấu hình runtime rồi thử lại.', 'error');
}
const json = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
};
const safeError = error => classifyJobError(error).message;
const inputResult = callback => {
  try { return callback(); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error.message || 'Invalid input.'); }
};
const inputResultAsync = async callback => {
  try { return await callback(); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, error.message || 'Invalid input.'); }
};
function localScheduleParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHEDULE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function publicJob(job) {
  if (!job) return null;
  const message = String(job.message || '').replace(/https?:\/\/[^\s]+/gi, '[source URL]').replace(/([?&](?:token|cookie|session|auth|key|access_token)=)[^&\s]+/gi, '$1[redacted]');
  return { id: job.id, linkId: job.linkId, status: job.status, message, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null, attempts: Number(job.attempts || 0), retries: Number(job.retries || 0), authRecoveryAttempts: Number(job.authRecoveryAttempts || 0), nextAttemptAt: job.nextAttemptAt || null };
}
function publicReport(value) {
  if (Array.isArray(value)) return value.map(publicReport);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key.toLowerCase() !== 'extra')
    .map(([key, item]) => [key, publicReport(item)]));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at >= 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return null;
}
function cookieHeader(req, token, maxAge) {
  const trustedTls = process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https';
  const secure = Boolean(req.socket.encrypted || trustedTls || process.env.COOKIE_SECURE === '1');
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function expectedOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return new URL(process.env.PUBLIC_ORIGIN).origin;
  const trusted = process.env.TRUST_PROXY === '1';
  const proto = trusted ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() : req.socket.encrypted ? 'https' : 'http';
  const host = trusted ? (req.headers['x-forwarded-host'] || req.headers.host) : req.headers.host;
  return host ? `${proto}://${String(host).split(',')[0].trim()}` : '';
}
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin !== expectedOrigin(req)) throw new HttpError(403, 'Origin check failed.');
}
function assertCsrf(req, session) {
  assertSameOrigin(req);
  const supplied = Buffer.from(String(req.headers['x-csrf-token'] || ''));
  const expected = Buffer.from(session.csrfToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(403, 'CSRF check failed.');
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64_000) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
}
async function lastJobFor(store, link) {
  return (await store.jobs()).filter(job => job.linkId === link.id && job.scope === link.scope)
    .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || ''))).at(-1) || null;
}
export function createApp({ directory = resolve(process.env.DATA_DIR || join(root, 'data')), databaseUrl = process.env.DATABASE_URL, projectRoot = root, schedulerMinutes = Number(process.env.SYNC_INTERVAL_MINUTES || 1440), collector = collect, transientError = isTransientNetworkError, retryDelayMs = 1000, maxRetries = 2, now = () => new Date(), persistence = null, housekeepingRunner = runHousekeeping } = {}) {
  if (persistence && (!persistence.store || !persistence.auth)) throw new Error('Injected persistence must provide both store and auth adapters.');
  const postgresPool = persistence ? null : createPostgresPool(databaseUrl);
  const store = persistence?.store || openStore(directory, { databaseUrl, pool: postgresPool });
  const auth = persistence?.auth || openAuthStore(directory, { databaseUrl, pool: postgresPool });
  const initialScheduleEnabled = Number.isFinite(Number(schedulerMinutes)) && Number(schedulerMinutes) > 0;
  let schedule = { enabled: initialScheduleEnabled, time: DEFAULT_SCHEDULE_TIME };
  const queue = [];
  const inFlight = new Map();
  const enqueueLocks = new Map();
  const loginAttempts = new Map();
  let busy = false;
  let shuttingDown = false;
  let workerPromise = null;
  let scheduleTimer = null;
  let housekeepingTimer = null;
  let housekeepingPromise = null;
  let housekeepingRunning = false;
  let housekeepingSettings = null;
  let checkingSchedule = false;

  function scheduleSettings() {
    return {
      enabled: schedule.enabled,
      time: schedule.time,
      timeZone: SCHEDULE_TIME_ZONE,
      initialEnabled: initialScheduleEnabled
    };
  }
  async function ensureGoogleSources(requestedMonth = null) {
    return ensureGoogleAdsMonthlyLinks(store, { requestedMonth, now: now() });
  }
  async function queueUnsyncedSources() {
    if (!scheduleSettings().enabled) return;
    await ensureGoogleSources();
    const parts = localScheduleParts(now());
    const scheduledDate = `${parts.year}-${parts.month}-${parts.day}`;
    for (const link of await store.list()) {
      // Monthly Google sources are materialized automatically, but provider
      // calls remain explicit through the queue actions in the UI/API.
      if (link.connector === GOOGLE_CONNECTOR) continue;
      if (!link.needsDates && !await store.result(link)) await enqueue(link, { useCandidate: true, scheduledDate });
    }
  }

  async function syncIdle() {
    if (shuttingDown || busy || queue.length || inFlight.size) return false;
    return !hasActiveSyncJobs(await store.jobs());
  }
  async function performHousekeeping() {
    if (housekeepingRunning || shuttingDown || !housekeepingSettings?.enabled) return null;
    housekeepingRunning = true;
    housekeepingPromise = (async () => {
      try {
        return await housekeepingRunner({
          store,
          directory,
          now,
          snapshotRetain: housekeepingSettings.snapshotRetain,
          jobRetentionDays: housekeepingSettings.jobRetentionDays,
          cacheEnabled: housekeepingSettings.cacheEnabled,
          isIdle: syncIdle,
          logger: message => process.stderr.write(`${message}\n`)
        });
      } catch {
        process.stderr.write('Housekeeping failed; it will be retried on the next run.\n');
        return { status: 'error' };
      } finally {
        housekeepingRunning = false;
        housekeepingPromise = null;
      }
    })();
    return housekeepingPromise;
  }

  const requestedMonth = url => { const value = url.searchParams.get('month'); return value ? month(value) : null; };
  const view = async link => {
    const result = publicReport(await store.result(link));
    const job = publicJob(await lastJobFor(store, link));
    if (job?.status === 'partial' && result?.reconciliation?.status === 'incomplete') job.message = 'Một số ngày thiếu giá trị từ nguồn; tổng kỳ chưa được đối soát đầy đủ và snapshot trước được giữ lại.';
    return { ...safeLink(link), result, job };
  };
  async function enqueue(link, options = {}) {
    const previous = enqueueLocks.get(link.id) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => enqueueOne(link, options));
    enqueueLocks.set(link.id, current);
    try { return await current; }
    finally { if (enqueueLocks.get(link.id) === current) enqueueLocks.delete(link.id); }
  }
  async function enqueueOne(link, { useCandidate = false, scheduledDate = null } = {}) {
    const active = (await store.jobs()).filter(job => job.linkId === link.id && ['queued', 'running'].includes(job.status));
    const queued = active.find(job => job.status === 'queued');
    if (queued) {
      if ((useCandidate && !queued.useCandidate) || (scheduledDate && queued.scheduledDate !== scheduledDate)) {
        if (useCandidate) queued.useCandidate = true;
        if (scheduledDate) queued.scheduledDate = scheduledDate;
        await store.putJob(queued);
        const live = inFlight.get(queued.id);
        if (live) { if (useCandidate) live.useCandidate = true; if (scheduledDate) live.scheduledDate = scheduledDate; }
        const queuedItem = queue.find(item => item.job.id === queued.id);
        if (queuedItem) { if (useCandidate) queuedItem.job.useCandidate = true; if (scheduledDate) queuedItem.job.scheduledDate = scheduledDate; }
      }
      return publicJob(queued);
    }
    const running = active.find(job => job.status === 'running');
    if (running) {
      const candidatePending = useCandidate && link.connector !== GOOGLE_CONNECTOR && existsSync(`${sourceProfileDirectory(directory, link.connector)}.pending`);
      // A scheduled active-profile crawl must not consume the administrator's
      // next explicit candidate test. Queue the candidate behind it instead.
      if (!candidatePending || running.useCandidate) {
        if (scheduledDate && running.scheduledDate !== scheduledDate) { running.scheduledDate = scheduledDate; await store.putJob(running); }
        return publicJob(running);
      }
    }
    if (link.needsDates) throw new HttpError(400, 'This source needs a complete date range before syncing.');
    const job = { id: randomUUID(), linkId: link.id, scope: link.scope, status: 'queued', message: 'Đã thêm vào hàng đợi đồng bộ.', startedAt: new Date().toISOString(), attempts: 0, retries: 0, useCandidate, ...(scheduledDate ? { scheduledDate } : {}) };
    await store.putJob(job);
    queue.push({ link, job });
    void drain();
    return publicJob(job);
  }
  async function drain() {
    if (busy || shuttingDown) return workerPromise;
    busy = true;
    workerPromise = (async () => {
      try {
        while (queue.length && !shuttingDown) {
          const { link, job } = queue.shift();
          inFlight.set(job.id, job);
          try { while (!shuttingDown) {
            const waitMs = Math.max(0, Number(job.nextAttemptAt || 0) - Date.now());
            if (waitMs) await new Promise(resolveWait => setTimeout(resolveWait, waitMs));
            if (shuttingDown) { job.status = 'queued'; job.message = 'Đã lưu vào hàng đợi; sẽ tiếp tục sau khi máy chủ khởi động lại.'; await store.putJob(job); break; }
            job.status = 'running'; job.attempts = Number(job.attempts || 0) + 1; job.nextAttemptAt = null;
            job.message = 'Đang mở phiên nguồn đã cấu hình.'; await store.putJob(job);
            try {
              const collectWithLock = async () => {
                if (link.connector === GOOGLE_CONNECTOR) {
                  return collector(link, { directory, projectRoot, job, update: () => store.putJob(job), retryBudget: maxRetries });
                }
                const activeProfile = sourceProfileDirectory(directory, link.connector);
                return withProfileLock(directory, link.connector, async profileLock => {
                  await recoverProfilePromotion(activeProfile);
                  const candidateInUse = Boolean(job.useCandidate && existsSync(`${activeProfile}.pending`));
                  const collected = await collector(link, { directory, projectRoot, job, update: () => store.putJob(job), useCandidate: candidateInUse, lockHeld: true, profileLock, retryBudget: maxRetries });
                  profileLock.assertHeld();
                  // Built-in collect emits an explicit verification marker. A
                  // legacy/injected collector may not know that contract, so a
                  // complete read is accepted only when this locked run was
                  // actually using an existing candidate. Partial results never
                  // promote a candidate.
                  const sessionVerified = collected?.sessionVerified === true || (candidateInUse && collected?.complete === true);
                  if (sessionVerified) {
                    profileLock.assertHeld();
                    await promoteVerifiedProfile(activeProfile);
                    profileLock.assertHeld();
                  }
                  return collected;
                });
              };
              const result = await collectWithLock();
              job.status = result.complete ? 'success' : 'partial';
              job.message = result.complete ? 'Đã tải dữ liệu và đối soát thành công.' : result.reconciliation.status === 'incomplete' ? 'Đã đọc báo cáo nhưng một số ngày thiếu dữ liệu; giữ snapshot trước để đối soát tiếp.' : 'Tổng các ngày không khớp tổng kỳ; giữ snapshot trước để đối soát lại.';
              job.finishedAt = new Date().toISOString();
              const { sessionVerified: _sessionVerified, ...persistedResult } = result;
              if (result.complete) await store.commit(link, persistedResult, job);
              else { await store.put({ ...link, status: 'partial' }); await store.putJob(job); }
              break;
            } catch (error) {
              if (shuttingDown) { job.status = 'queued'; job.message = 'Đã lưu vào hàng đợi; sẽ tiếp tục sau khi máy chủ khởi động lại.'; await store.putJob(job); break; }
              const retries = Number(job.retries || 0);
              const transient = transientError(error);
              const classified = classifyJobError(error);
              if (retries < maxRetries && transient) {
                job.retries = retries + 1;
                const delay = retryDelayMs * (2 ** retries);
                job.nextAttemptAt = Date.now() + delay;
                const delayText = delay >= 1000 ? `${delay / 1000} giây` : `${delay} ms`;
                job.status = 'queued'; job.message = `Lỗi mạng tạm thời; đã lên lịch thử lại ${job.retries}/${maxRetries} sau ${delayText}.`;
                await store.putJob(job);
                continue;
              }
              job.status = transient ? 'network_error' : classified.status || 'error';
              job.message = transient
                ? `Không thể kết nối tới nguồn hoặc đã hết thời gian chờ sau ${Number(job.attempts || 1)} lần thử. Kiểm tra kết nối mạng, DNS, firewall/proxy rồi chạy lại thủ công.`
                : classified.message;
              job.finishedAt = new Date().toISOString(); await store.putJob(job);
              break;
            }
          }} finally { inFlight.delete(job.id); }
        }
      } finally { busy = false; workerPromise = null; }
    })();
    return workerPromise;
  }
  function limitedLogin(ip) {
    const now = Date.now();
    const record = (loginAttempts.get(ip) || []).filter(at => now - at < LOGIN_WINDOW_MS);
    if (record.length >= LOGIN_LIMIT) { loginAttempts.set(ip, record); throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.'); }
    record.push(now); loginAttempts.set(ip, record);
  }
  function loginIp(req) {
    if (process.env.TRUST_PROXY === '1' && req.headers['x-real-ip']) return String(req.headers['x-real-ip']).trim();
    return req.socket.remoteAddress || 'unknown';
  }
  function requireAdmin(session) { if (session.user.role !== 'admin') throw new HttpError(403, 'Administrator access is required.'); }
  async function sessionStatus() {
    return Promise.all(ADMIN_CONNECTORS.map(async connector => {
      const profile = sourceProfileDirectory(directory, connector);
      let profileFound = false, lastModifiedAt = null;
      try { profileFound = existsSync(profile); if (profileFound) lastModifiedAt = statSync(profile).mtime.toISOString(); } catch { /* Report absent profile without a path. */ }
      const candidatePending = existsSync(`${profile}.pending`);
      const circuit = await authCircuit(directory, connector);
      let autoLogin = false;
      try {
        autoLogin = connector === '24h'
          ? source24hAutoLoginEnabled()
          : ['admicro-pc', 'admicro-mobile'].includes(connector) ? sourceAdmicroAutoLoginEnabled() : false;
      } catch { /* Invalid env is reported by the worker without exposing it. */ }
      return { connector, profileFound, candidatePending, lastModifiedAt, autoLogin, authCircuitOpen: Boolean(circuit?.open), refreshCommand: `npm run session:state -- import ${connector} <private-state-file>` };
    }));
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const staticFiles = {
      '/': ['links.html', 'text/html; charset=utf-8'],
      '/links.html': ['links.html', 'text/html; charset=utf-8'],
      '/login.html': ['login.html', 'text/html; charset=utf-8'],
      '/links.js': ['links.js', 'text/javascript; charset=utf-8'],
      '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
      '/comparison.js': ['comparison.js', 'text/javascript; charset=utf-8'],
      '/links.css': ['links.css', 'text/css; charset=utf-8']
    };
    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname];
      res.writeHead(200, {
        'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
      });
      return res.end(await readFile(join(projectRoot, 'public', file)));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      assertSameOrigin(req);
      const ip = loginIp(req); limitedLogin(ip);
      const input = await body(req);
      const user = typeof input.username === 'string' && typeof input.password === 'string' && input.password.length <= 1024
        ? await auth.verify(input.username, input.password) : null;
      if (!user) throw new HttpError(401, 'Invalid username or password.');
      loginAttempts.delete(ip);
      const issued = await auth.issueSession(user.id, SESSION_LIFETIME_MS);
      res.setHeader('set-cookie', cookieHeader(req, issued.token, SESSION_LIFETIME_SECONDS));
      return json(res, { user, csrfToken: issued.csrfToken, expiresAt: issued.expiresAt });
    }

    if (url.pathname.startsWith('/api/')) {
      const token = readCookie(req, SESSION_COOKIE);
      const session = await auth.authenticate(token);
      if (url.pathname === '/api/auth/me' && req.method === 'GET') {
        if (!session) throw new HttpError(401, 'Sign in required.');
        return json(res, { user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
      }
      if (!session) throw new HttpError(401, 'Sign in required.');
      if (req.method !== 'GET') assertCsrf(req, session);

      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        await auth.revoke(token);
        res.setHeader('set-cookie', cookieHeader(req, '', 0));
        return json(res, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/users') {
        requireAdmin(session); return json(res, { users: await auth.listUsers() });
      }
      if (url.pathname === '/api/admin/grants' && req.method === 'GET') {
        requireAdmin(session);
        await ensureGoogleSources();
        const users = (await auth.listUsers()).filter(user => user.role === 'viewer');
        const sources = (await store.list()).map(link => ({ id: link.id, name: link.name, source: link.source, from: link.from, to: link.to }));
        const grants = await Promise.all(users.map(async user => [user.id, await auth.grantsForUser(user.id)]));
        return json(res, { users, sources, grants: Object.fromEntries(grants) });
      }
      const grantsMatch = url.pathname.match(/^\/api\/admin\/grants\/([^/]+)$/);
      if (req.method === 'PUT' && grantsMatch) {
        requireAdmin(session);
        const input = await body(req);
        const available = new Set((await store.list()).map(link => link.id));
        if (!Array.isArray(input.linkIds) || input.linkIds.some(id => !available.has(id))) throw new HttpError(400, 'A selected source does not exist.');
        const linkIds = await inputResultAsync(() => auth.replaceGrants(decodeURIComponent(grantsMatch[1]), input.linkIds));
        return json(res, { linkIds });
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        requireAdmin(session); return json(res, { sessions: await sessionStatus() });
      }
      const resetAuthMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reset-auth$/);
      if (req.method === 'POST' && resetAuthMatch) {
        requireAdmin(session);
        const connector = decodeURIComponent(resetAuthMatch[1]);
        if (!ADMIN_CONNECTORS.includes(connector)) throw new HttpError(404, 'Source connector not found.');
        await withProfileLock(directory, connector, () => resetAuthCircuit(directory, connector));
        return json(res, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        requireAdmin(session);
        const jobs = await store.jobs();
        return json(res, { jobs: jobs.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''))).map(publicJob), schedulerMinutes, schedule: scheduleSettings() });
      }
      if (req.method === 'PUT' && url.pathname === '/api/jobs/schedule') {
        requireAdmin(session);
        const input = await body(req);
        if (typeof input.enabled !== 'boolean' || typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
          throw new HttpError(400, 'Schedule must include an enabled flag and a valid HH:MM time.');
        }
        const wasEnabled = scheduleSettings().enabled;
        await store.setMetadata('auto-sync-enabled', input.enabled ? '1' : '0');
        await store.setMetadata('auto-sync-time', input.time);
        schedule = { enabled: input.enabled, time: input.time };
        if (input.enabled) {
          if (!wasEnabled) await queueUnsyncedSources();
          void scheduleCheck().catch(() => {});
        }
        return json(res, { schedule: scheduleSettings() });
      }
      if (req.method === 'GET' && url.pathname === '/api/links') {
        const filter = inputResult(() => requestedMonth(url));
        await ensureGoogleSources(filter);
        const storedLinks = await store.list();
        const all = await Promise.all(storedLinks.map(view));
        const viewerGrants = session.user.role === 'admin' ? null : new Set(await auth.grantsForUser(session.user.id));
        const permitted = session.user.role === 'admin' ? all : all.filter(link => viewerGrants.has(link.id));
        const links = filter ? permitted.filter(link => link.reportMonth === filter) : permitted;
        const months = [...new Set(permitted.map(link => link.reportMonth).filter(Boolean))].sort().reverse();
        return json(res, { links, groups: groups(links), months, aggregate: aggregateReports(links, { reportMonth: filter }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/links/preview') {
        requireAdmin(session); const input = await body(req); return json(res, safeLink(inputResult(() => identify(input))));
      }
      if (req.method === 'POST' && url.pathname === '/api/links') {
        requireAdmin(session);
        const input = await body(req); const existingLinks = await store.list();
        const name = inputResult(() => validateDisplayName(input.name, existingLinks));
        const link = inputResult(() => identify({ ...input, name }));
        if (link.needsDates) throw new HttpError(400, 'Choose a complete date range.');
        if (existingLinks.some(existing => existing.scope === scope(link))) throw new HttpError(409, 'This link and date range already exist.');
        link.id = randomUUID(); link.scope = scope(link); link.status = 'idle'; await store.put(link);
        if (scheduleSettings().enabled) {
          const parts = localScheduleParts(now());
          await enqueue(link, { useCandidate: true, scheduledDate: `${parts.year}-${parts.month}-${parts.day}` });
        }
        return json(res, await view(link), 201);
      }
      if (req.method === 'POST' && url.pathname === '/api/links/collect-all') {
        requireAdmin(session);
        const filter = inputResult(() => requestedMonth(url));
        await ensureGoogleSources(filter);
        const links = (await store.list()).filter(link => !link.needsDates && (!filter || link.reportMonth === filter));
        const jobs = [];
        for (const link of links) jobs.push(await enqueue(link, { useCandidate: true }));
        return json(res, { jobs }, 202);
      }
      const linkMatch = url.pathname.match(/^\/api\/links\/([^/]+)(?:\/(collect))?$/);
      if (linkMatch) {
        const link = await store.get(decodeURIComponent(linkMatch[1]));
        if (!link) throw new HttpError(404, 'Source not found.');
        if (session.user.role !== 'admin' && !(await auth.grantsForUser(session.user.id)).includes(link.id)) throw new HttpError(404, 'Source not found.');
        if (req.method === 'POST' && linkMatch[2] === 'collect') {
          requireAdmin(session); return json(res, await enqueue(link, { useCandidate: true }), 202);
        }
        if (linkMatch[2]) throw new HttpError(404, 'Source route not found.');
        if (req.method === 'GET') return json(res, await view(link));
        if (req.method === 'PATCH') {
          requireAdmin(session);
          if ((await store.jobs()).some(job => job.linkId === link.id && ['running', 'queued'].includes(job.status))) throw new HttpError(409, 'Wait for the current sync to finish before editing this source.');
          const input = await body(req);
          const existingLinks = await store.list();
          const name = inputResult(() => validateDisplayName(Object.prototype.hasOwnProperty.call(input, 'name') ? input.name : link.name, existingLinks, link.id));
          const changed = inputResult(() => identify({ url: input.url || link.url, name, from: input.from || link.from, to: input.to || link.to, reportMonth: Object.prototype.hasOwnProperty.call(input, 'reportMonth') ? input.reportMonth : link.reportMonth }));
          if (changed.needsDates) throw new HttpError(400, 'Choose a complete date range.');
          if (existingLinks.some(existing => existing.id !== link.id && existing.scope === scope(changed))) throw new HttpError(409, 'This link and date range already exist.');
          const next = { ...changed, id: link.id, scope: scope(changed), status: 'idle' };
          await store.put(next);
          if (scheduleSettings().enabled) {
            const parts = localScheduleParts(now());
            await enqueue(next, { useCandidate: true, scheduledDate: `${parts.year}-${parts.month}-${parts.day}` });
          }
          return json(res, await view(next));
        }
        if (req.method === 'DELETE') {
          requireAdmin(session);
          if ((await store.jobs()).some(job => job.linkId === link.id && ['running', 'queued'].includes(job.status))) throw new HttpError(409, 'Wait for the current sync to finish before deleting this source.');
          await store.remove(link.id);
          return json(res, { ok: true, snapshotsRetained: true });
        }
      }
      const retryMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
      if (req.method === 'POST' && retryMatch) {
        requireAdmin(session);
        const previous = (await store.jobs()).find(job => job.id === decodeURIComponent(retryMatch[1]));
        const link = previous && await store.get(previous.linkId);
        if (!link) throw new HttpError(404, 'Job source not found.');
        return json(res, await enqueue(link, { useCandidate: true }), 202);
      }
      throw new HttpError(404, 'API route not found.');
    }
    throw new HttpError(404, 'Route not found.');
  }

  const server = createServer((req, res) => {
    handler(req, res).catch(error => {
      if (res.headersSent) { res.end(); return; }
      const status = error.status === 'auth_required' ? 401 : error.status || (error instanceof HttpError ? error.status : 500);
      json(res, { error: safeError(error) }, status);
    });
  });
  async function listen(port = Number(process.env.PORT || 8787), host = process.env.HOST || '0.0.0.0') {
    await ready;
    return new Promise((resolveListen, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(port, host, () => { server.off('error', onError); resolveListen(server.address()); });
    });
  }
  async function scheduleCheck() {
    if (checkingSchedule || shuttingDown || !scheduleSettings().enabled) return;
    checkingSchedule = true;
    try {
      await ensureGoogleSources();
      const parts = localScheduleParts(now());
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      const time = `${parts.hour}:${parts.minute}`;
      if (time < scheduleSettings().time || await store.getMetadata('last-scheduled-date') === date) return;
      const jobs = await store.jobs();
      const alreadyScheduled = new Set(jobs.filter(job => job.scheduledDate === date).map(job => job.linkId));
      for (const link of await store.list()) {
        // Do not turn monthly source creation into a background Google Ads
        // request; manual collection still uses the same bounded queue.
        if (link.connector === GOOGLE_CONNECTOR) continue;
        if (link.needsDates || alreadyScheduled.has(link.id)) continue;
        await enqueue(link, { useCandidate: true, scheduledDate: date });
        alreadyScheduled.add(link.id);
      }
      await store.setMetadata('last-scheduled-date', date);
    } finally { checkingSchedule = false; }
  }
  const ready = (async () => {
    await Promise.all([store.ready, auth.ready].filter(Boolean));
    let enabled = await store.getMetadata('auto-sync-enabled');
    let syncTime = await store.getMetadata('auto-sync-time');
    if (enabled == null) {
      enabled = initialScheduleEnabled ? '1' : '0';
      await store.setMetadata('auto-sync-enabled', enabled);
    }
    if (syncTime == null) {
      syncTime = DEFAULT_SCHEDULE_TIME;
      await store.setMetadata('auto-sync-time', syncTime);
    }
    schedule = { enabled: enabled === '1', time: syncTime };
    try {
      housekeepingSettings = housekeepingConfig();
    } catch {
      housekeepingSettings = { enabled: false, intervalMinutes: 360, snapshotRetain: 3, jobRetentionDays: 90, cacheEnabled: true };
      process.stderr.write('Housekeeping configuration is invalid; automatic cleanup is disabled.\n');
    }

    const jobs = await store.jobs();
    for (const job of jobs) {
      if (['running', 'waiting_login'].includes(job.status)) {
        job.status = 'error';
        job.message = 'Máy chủ khởi động lại khi tác vụ đang chạy; hãy chạy lại khi sẵn sàng.';
        job.finishedAt = now().toISOString();
        await store.putJob(job);
      }
    }
    for (const job of jobs.filter(item => item.status === 'queued')) {
      const link = await store.get(job.linkId);
      if (link) queue.push({ link, job });
      else {
        job.status = 'error';
        job.message = 'Không tìm thấy nguồn của tác vụ đang chờ.';
        job.finishedAt = now().toISOString();
        await store.putJob(job);
      }
    }
    if (queue.length) void drain();

    const parts = localScheduleParts(now());
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (scheduleSettings().enabled && await store.getMetadata('last-startup-catchup-date') !== date) {
      await queueUnsyncedSources();
      await store.setMetadata('last-startup-catchup-date', date);
    }
    if (!shuttingDown) {
      scheduleTimer = setInterval(() => { void scheduleCheck().catch(() => {}); }, 30_000);
      scheduleTimer.unref();
      if (scheduleSettings().enabled) await scheduleCheck();
      if (housekeepingSettings.enabled) {
        housekeepingTimer = setInterval(() => { void performHousekeeping(); }, housekeepingSettings.intervalMinutes * 60_000);
        housekeepingTimer.unref();
        void performHousekeeping();
      }
    }
  })();
  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      shuttingDown = true;
      if (scheduleTimer) clearInterval(scheduleTimer);
      if (housekeepingTimer) clearInterval(housekeepingTimer);
      await ready.catch(() => {});
      if (housekeepingPromise) await housekeepingPromise.catch(() => {});
      if (server.listening) await new Promise(resolveClose => server.close(() => resolveClose()));
      await closeBrowserContexts();
      if (workerPromise) await workerPromise;
      for (const { job } of queue) {
        job.status = 'queued';
        job.message = 'Đã lưu vào hàng đợi; sẽ tiếp tục sau khi máy chủ khởi động lại.';
        await store.putJob(job);
      }
      await Promise.all([store.close(), auth.close()]);
      if (postgresPool) await postgresPool.end();
    })();
    return closePromise;
  }
  return { server, listen, close, ready, stores: { store, auth } };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(root, 'source-app.mjs') || invokedPath === resolve(root, 'app.mjs')) {
  loadLocalConfig(root);
  const app = createApp();
  let address;
  try { address = await app.listen(); }
  catch (error) { await app.close(); throw error; }
  const shownHost = address.address === '0.0.0.0' || address.address === '::' ? 'localhost' : address.address;
  process.stdout.write(`Admicro reports listening at http://${shownHost}:${address.port}\n`);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void app.close().finally(() => process.exit(0)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
