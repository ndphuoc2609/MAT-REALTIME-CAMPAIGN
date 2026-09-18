import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const clone = value => value == null ? value : structuredClone(value);
const hashToken = value => createHash('sha256').update(value).digest('hex');
const validUsername = value => /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(value);
const passwordHash = (password, salt) => scryptSync(password, salt, 64).toString('hex');

export function createMemoryPersistence() {
  const links = new Map();
  const snapshots = [];
  let snapshotSequence = 0;
  const jobs = new Map();
  const metadata = new Map();
  const users = new Map();
  const usernames = new Map();
  const sessions = new Map();
  const grants = new Map();

  const store = {
    ready: Promise.resolve(),
    list: () => [...links.values()].map(clone),
    get: id => clone(links.get(id)),
    put: link => { links.set(link.id, clone(link)); },
    jobs: () => [...jobs.values()].map(clone),
    putJob: job => { jobs.set(job.id, clone(job)); },
    remove: id => { links.delete(id); },
    getMetadata: key => metadata.get(key),
    setMetadata: (key, value) => { metadata.set(key, String(value)); },
    result(link) {
      const result = snapshots.filter(item => item.linkId === link.id && item.scope === link.scope).at(-1)?.data;
      return result === undefined ? null : clone(result);
    },
    commit(link, result, job) {
      snapshots.push({ sequence: ++snapshotSequence, linkId: link.id, scope: link.scope, data: clone(result) });
      this.put({ ...link, status: result.complete ? 'success' : 'partial', updatedAt: result.fetchedAt });
      this.putJob(job);
    },
    pruneHousekeeping({ keepSnapshots = 3, jobCutoff = new Date(), terminalStatuses = [] } = {}) {
      const keep = Math.max(3, Number(keepSnapshots) || 3);
      const grouped = new Map();
      for (const snapshot of snapshots) {
        const key = `${snapshot.linkId}\u0000${snapshot.scope}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(snapshot);
      }
      const remove = new Set();
      for (const group of grouped.values()) for (const snapshot of [...group].sort((a, b) => b.sequence - a.sequence).slice(keep)) remove.add(snapshot);
      for (let index = snapshots.length - 1; index >= 0; index--) if (remove.has(snapshots[index])) snapshots.splice(index, 1);
      const cutoff = new Date(jobCutoff).getTime();
      const statuses = new Set((terminalStatuses || []).map(String));
      let jobsRemoved = 0;
      for (const [id, job] of jobs) {
        const finished = Date.parse(job.finishedAt || '');
        if (statuses.has(String(job.status || '')) && Number.isFinite(finished) && finished < cutoff) { jobs.delete(id); jobsRemoved++; }
      }
      return { snapshotsRemoved: remove.size, jobsRemoved };
    },
    snapshotCount: () => snapshots.length,
    close() {}
  };

  const auth = {
    ready: Promise.resolve(),
    adminCount: () => [...users.values()].filter(user => user.role === 'admin').length,
    createUser(username, password, role = 'viewer', { bootstrap = false } = {}) {
      const name = String(username || '').trim();
      if (!validUsername(name)) throw Error('Username must be 3–64 characters: letters, numbers, dot, underscore, or hyphen.');
      if (typeof password !== 'string' || password.length < 14 || password.length > 1024) throw Error('Password must be at least 14 characters.');
      if (!['admin', 'viewer'].includes(role)) throw Error('Role must be admin or viewer.');
      const key = name.toLowerCase();
      if (usernames.has(key)) throw Error('That username already exists.');
      if (bootstrap && (role !== 'admin' || this.adminCount() !== 0)) throw Error('First-admin setup is only available before an admin exists.');
      if (!bootstrap && this.adminCount() === 0) throw Error('Create the first administrator before adding users.');
      const salt = randomBytes(16).toString('hex');
      const user = { id: randomBytes(16).toString('hex'), username: name, role, salt, passwordHash: passwordHash(password, salt), createdAt: new Date().toISOString() };
      users.set(user.id, user);
      usernames.set(key, user.id);
      return { id: user.id, username: user.username, role: user.role };
    },
    resetAdminPassword(username, password) {
      const name = String(username || '').trim();
      if (typeof password !== 'string' || password.length < 14 || password.length > 1024) throw Error('Password must be at least 14 characters.');
      const user = users.get(usernames.get(name.toLowerCase()));
      if (!user || user.role !== 'admin') throw Error('Administrator account not found.');
      user.salt = randomBytes(16).toString('hex');
      user.passwordHash = passwordHash(password, user.salt);
      for (const [key, session] of sessions) if (session.userId === user.id) sessions.delete(key);
      return { id: user.id, username: user.username, role: user.role };
    },
    verify(username, password) {
      const user = users.get(usernames.get(String(username || '').trim().toLowerCase()));
      if (!user) {
        passwordHash(String(password || ''), 'f2a3d6c87b1e4a5f');
        return null;
      }
      const actual = Buffer.from(passwordHash(String(password || ''), user.salt), 'hex');
      const expected = Buffer.from(user.passwordHash, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected)
        ? { id: user.id, username: user.username, role: user.role }
        : null;
    },
    issueSession(userId, lifetimeMs = 24 * 60 * 60 * 1000) {
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + lifetimeMs;
      sessions.set(hashToken(token), { userId, csrfToken, expiresAt });
      return { token, csrfToken, expiresAt };
    },
    authenticate(token) {
      if (!token) return null;
      const key = hashToken(token);
      const session = sessions.get(key);
      if (!session) return null;
      if (session.expiresAt <= Date.now()) { sessions.delete(key); return null; }
      const user = users.get(session.userId);
      return user ? { user: { id: user.id, username: user.username, role: user.role }, csrfToken: session.csrfToken, expiresAt: session.expiresAt } : null;
    },
    revoke(token) { if (token) sessions.delete(hashToken(token)); },
    listUsers: () => [...users.values()]
      .map(user => ({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt }))
      .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' })),
    grantsForUser: userId => [...(grants.get(userId) || [])].sort(),
    replaceGrants(userId, linkIds) {
      const user = users.get(userId);
      if (!user) throw Error('User not found.');
      if (user.role !== 'viewer') throw Error('Report grants apply to viewer accounts only.');
      if (!Array.isArray(linkIds) || linkIds.some(id => typeof id !== 'string' || id.length > 100)) throw Error('Provide a list of valid source IDs.');
      const unique = [...new Set(linkIds)];
      grants.set(userId, new Set(unique));
      return unique;
    },
    close() {}
  };

  return { store, auth };
}
