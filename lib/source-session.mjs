import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_WAIT_MS = 30_000;
const PYTHON_LOCK_HELPER = `
import fcntl, os, sys, time
path = sys.argv[1]
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    deadline = time.monotonic() + float(sys.argv[2])
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                sys.exit(75)
            time.sleep(0.1)
    sys.stdout.write('ready\\n')
    sys.stdout.flush()
    sys.stdin.read()
finally:
    try: fcntl.flock(fd, fcntl.LOCK_UN)
    finally: os.close(fd)
`;

export class ProfileLockError extends Error {
  constructor(message = 'Đang có tác vụ khác sử dụng phiên nguồn. Hãy thử lại sau.') {
    super(message);
    this.name = 'ProfileLockError';
    this.status = 'session_busy';
  }
}

function profileName(connector) {
  return connector === 'admicro-pc' || connector === 'admicro-mobile' ? 'admicro' : connector;
}

function lockPath(directory, connector) { return join(resolve(directory), 'session-locks', `${profileName(connector)}.lock`); }

export async function acquireProfileLock(directory, connector, { timeoutMs = DEFAULT_WAIT_MS } = {}) {
  const path = lockPath(directory, connector);
  const lockDirectory = join(resolve(directory), 'session-locks');
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  chmodSync(lockDirectory, 0o700);
  const python = process.env.PYTHON_BIN || 'python3';
  const child = spawn(python, ['-c', PYTHON_LOCK_HELPER, path, String(Math.max(0, timeoutMs) / 1000)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let ready = false;
  let intentionalRelease = false;
  let lostError = null;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const loss = new Promise(resolveLoss => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!ready && output.includes('ready\n')) { ready = true; readyResolve(); }
    });
    child.once('error', error => { if (!ready) readyReject(error); resolveLoss(error); });
    child.once('exit', (code, signal) => {
      if (!ready) readyReject(code === 75 ? new ProfileLockError() : new Error(`Profile lock helper exited before acquiring the lock (${code ?? signal}).`));
      if (!intentionalRelease) { lostError = new ProfileLockError('Khóa phiên nguồn đã mất; tác vụ được dừng để tránh ghi đồng thời profile.'); resolveLoss(lostError); }
    });
  });
  const timer = setTimeout(() => { if (!ready) child.kill('SIGTERM'); }, Math.max(1, timeoutMs) + 250);
  timer.unref?.();
  try { await readyPromise; }
  catch (error) {
    clearTimeout(timer);
    child.kill('SIGKILL');
    throw error;
  }
  clearTimeout(timer);
  let released = false;
  return {
    path,
    pid: child.pid,
    lost: loss,
    assertHeld() { if (lostError || child.exitCode != null) throw lostError || new ProfileLockError(); },
    async release() {
      if (released) return;
      released = true;
      intentionalRelease = true;
      child.stdin.end();
      if (child.exitCode == null && child.signalCode == null) {
        await Promise.race([
          new Promise(resolveExit => child.once('exit', resolveExit)),
          new Promise(resolveTimeout => setTimeout(resolveTimeout, 1_000))
        ]);
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
      }
    }
  };
}

export async function withProfileLock(directory, connector, operation, options = {}) {
  const lock = await acquireProfileLock(directory, connector, options);
  const operationPromise = Promise.resolve().then(() => operation(lock));
  try {
    const outcome = await Promise.race([
      operationPromise.then(value => ({ done: true, value })),
      lock.lost.then(error => ({ done: false, error }))
    ]);
    if (!outcome.done) {
      // The operation owns browser/database cleanup. Wait for it to finish
      // after the lock-loss handler closes its context before surfacing the
      // failure, so no old worker continues writing after another acquires.
      await operationPromise.catch(() => {});
      throw outcome.error;
    }
    return outcome.value;
  }
  finally { await lock.release(); }
}

async function writePromotionJournal(path, state, renameFn = rename) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  try { await renameFn(temporary, path); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function recoverProfilePromotion(activeProfile, { renameFn = rename } = {}) {
  const candidate = `${activeProfile}.pending`;
  const journal = `${activeProfile}.promotion.json`;
  if (!existsSync(journal)) return false;
  let state;
  try { state = JSON.parse(await readFile(journal, 'utf8')); }
  catch (error) { throw new ProfileLockError(`Không đọc được nhật ký chuyển profile; dừng để bảo toàn phiên nguồn (${error.message}).`); }
  const previous = state.previous;
  if (!['prepared', 'active-moved', 'candidate-promoted'].includes(state.phase)) {
    throw new ProfileLockError('Nhật ký chuyển profile có trạng thái không xác định; giữ nguyên profile và candidate để quản trị viên xử lý.');
  }
  let restoredPrevious = false;
  if (!existsSync(activeProfile) && previous && existsSync(previous)) {
    await renameFn(previous, activeProfile);
    restoredPrevious = true;
  }
  if (!existsSync(activeProfile)) {
    throw new ProfileLockError('Không thể khôi phục profile active từ nhật ký chuyển profile; giữ nguyên candidate và nhật ký.');
  }
  // If the active profile exists and the candidate is gone, the candidate
  // rename completed before the journal phase update (or promotion had
  // already completed). Keep the active profile and only clear the journal.
  if (existsSync(activeProfile) && !existsSync(candidate)) {
    if (state.phase === 'prepared') throw new ProfileLockError('Nhật ký chuyển profile dở dang không có candidate; giữ nguyên profile và nhật ký.');
    await rm(journal, { force: true });
    return true;
  }
  // A prepared journal with both profiles still present means no rename was
  // committed. Retain both and clear only the stale journal.
  if (existsSync(activeProfile) && existsSync(candidate) && state.phase === 'active-moved' && previous && !existsSync(previous) && !restoredPrevious) {
    throw new ProfileLockError('Không xác định được trạng thái chuyển profile sau khi active đã di chuyển; giữ nguyên profile, candidate và nhật ký.');
  }
  if (existsSync(activeProfile) && existsSync(candidate)) {
    await rm(journal, { force: true });
    return true;
  }
  return false;
}

export async function promoteVerifiedProfile(activeProfile, { renameFn = rename } = {}) {
  const candidate = `${activeProfile}.pending`;
  const journal = `${activeProfile}.promotion.json`;
  await recoverProfilePromotion(activeProfile, { renameFn });
  if (!existsSync(candidate)) return false;
  const previous = `${activeProfile}.previous-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const hadActive = existsSync(activeProfile);
  let movedPrevious = false;
  await writePromotionJournal(journal, { active: activeProfile, candidate, previous: hadActive ? previous : null, phase: 'prepared' }, renameFn);
  try {
    if (hadActive) { await renameFn(activeProfile, previous); movedPrevious = true; }
    await writePromotionJournal(journal, { active: activeProfile, candidate, previous: hadActive ? previous : null, phase: 'active-moved' }, renameFn);
    await renameFn(candidate, activeProfile);
    await writePromotionJournal(journal, { active: activeProfile, candidate, previous: hadActive ? previous : null, phase: 'candidate-promoted' }, renameFn);
    await rm(journal, { force: true });
    return true;
  } catch (error) {
    // A failed promotion must leave the last usable profile available. The
    // candidate is also retained when possible so an administrator can retry.
    if (movedPrevious && existsSync(previous) && !existsSync(activeProfile)) {
      try { await renameFn(previous, activeProfile); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Promotion failed and rollback failed; promotion journal retained.'); }
    }
    throw error;
  }
}

const circuitFile = directory => join(resolve(directory), 'source-auth-circuit.json');

async function readCircuit(directory) {
  try {
    const parsed = JSON.parse(await readFile(circuitFile(directory), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function writeCircuit(directory, state) {
  const target = circuitFile(directory);
  await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  try { await rename(temporary, target); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}

export async function authCircuit(directory, connector) {
  const state = await readCircuit(directory);
  return state[profileName(connector)] || null;
}

export async function tripAuthCircuit(directory, connector, reason = 'authentication_failed', { scheduledDate } = {}) {
  const state = await readCircuit(directory);
  const profile = profileName(connector);
  const previous = state[profile];
  const circuit = { open: true, reason, at: new Date().toISOString() };
  // This marker records that a scheduled job has crossed the credential
  // submission boundary. Preserve it through subsequent auth failures so an
  // ambiguous result cannot trigger another credential submission that day.
  const scheduledTimestamp = typeof scheduledDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)
    ? Date.parse(`${scheduledDate}T00:00:00.000Z`)
    : Number.NaN;
  if (Number.isFinite(scheduledTimestamp) && new Date(scheduledTimestamp).toISOString().slice(0, 10) === scheduledDate) {
    circuit.lastScheduledDate = scheduledDate;
  } else if (typeof previous?.lastScheduledDate === 'string') {
    circuit.lastScheduledDate = previous.lastScheduledDate;
  }
  state[profile] = circuit;
  await writeCircuit(directory, state);
}

export async function resetAuthCircuit(directory, connector) {
  const state = await readCircuit(directory);
  delete state[profileName(connector)];
  await writeCircuit(directory, state);
}
