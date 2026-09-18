import { Pool } from 'pg';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const linkSchemaPromises = new WeakMap();
const authSchemaPromises = new WeakMap();
const DEFAULT_TERMINAL_SYNC_STATUSES = Object.freeze([
  'success', 'partial', 'error', 'network_error', 'auth_required', 'auth_blocked',
  'authentication_failed', 'authentication_pending', 'invalid_credentials', 'config_error', 'schema_error',
  'access_denied', 'http_error', 'needs_inspection', 'transport_security',
  'interactive_auth_required', 'debug_unsafe'
]);

export function requireDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is required. Set it to a PostgreSQL connection URL before starting the app or running database commands.');
  }
  return databaseUrl.trim();
}

export function postgresPoolConfig(databaseUrl) {
  let parsed;
  const requiredUrl = requireDatabaseUrl(databaseUrl);
  try { parsed = new URL(requiredUrl); }
  catch { throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme.');
  const channelBinding = parsed.searchParams.get('channel_binding') || 'prefer';
  if (!['disable', 'prefer', 'require'].includes(channelBinding)) throw new Error('DATABASE_URL has an unsupported channel_binding setting.');
  if (channelBinding === 'require' && parsed.searchParams.get('sslmode') === 'disable') {
    throw new Error('DATABASE_URL cannot require channel binding while sslmode=disable.');
  }
  // pg currently treats `require` as full certificate verification; spelling
  // that mode explicitly preserves the current secure behavior across pg v9.
  if (parsed.searchParams.get('sslmode') === 'require') parsed.searchParams.set('sslmode', 'verify-full');
  return {
    connectionString: parsed.toString(),
    enableChannelBinding: channelBinding !== 'disable',
    ...(channelBinding === 'require' && !parsed.searchParams.has('sslmode') && !parsed.searchParams.has('ssl') ? { ssl: true } : {}),
    connectionTimeoutMillis: 5000,
    max: 8,
    application_name: 'admicro-crawler'
  };
}

export function createPostgresPool(databaseUrl) {
  const pool = new Pool(postgresPoolConfig(databaseUrl));
  pool.on('error', error => {
    const code = typeof error?.code === 'string' ? ` (${error.code})` : '';
    process.stderr.write(`PostgreSQL pool connection error${code}.\n`);
  });
  return pool;
}

const linkSchema = `
  CREATE TABLE IF NOT EXISTS report_links (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS report_snapshots (
    sequence BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    link_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    data JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS report_snapshots_latest ON report_snapshots(link_id, scope, sequence DESC);
  CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const authSchema = `
  CREATE TABLE IF NOT EXISTS app_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'viewer')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS report_grants (
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    link_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, link_id)
  );
`;

export async function ensurePostgresLinkSchema(pool) {
  let ready = linkSchemaPromises.get(pool);
  if (!ready) {
    ready = pool.query(linkSchema).then(() => undefined);
    linkSchemaPromises.set(pool, ready);
  }
  return ready;
}

export async function ensurePostgresAuthSchema(pool) {
  let ready = authSchemaPromises.get(pool);
  if (!ready) {
    ready = pool.query(authSchema).then(() => undefined);
    authSchemaPromises.set(pool, ready);
  }
  return ready;
}

export function openPostgresLinkStore(databaseUrl, providedPool = null) {
  requireDatabaseUrl(databaseUrl);
  const pool = providedPool || createPostgresPool(databaseUrl);
  const ready = ensurePostgresLinkSchema(pool);
  const query = async (text, values = []) => { await ready; return pool.query(text, values); };
  return {
    ready,
    async list() { return (await query('SELECT data FROM report_links')).rows.map(row => row.data); },
    async get(id) { return (await query('SELECT data FROM report_links WHERE id=$1', [id])).rows[0]?.data; },
    async put(link) { await query('INSERT INTO report_links(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [link.id, JSON.stringify(link)]); },
    async remove(id) { await query('DELETE FROM report_links WHERE id=$1', [id]); },
    async jobs() { return (await query('SELECT data FROM sync_jobs')).rows.map(row => row.data); },
    async putJob(job) { await query('INSERT INTO sync_jobs(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [job.id, JSON.stringify(job)]); },
    async getMetadata(key) { return (await query('SELECT value FROM app_metadata WHERE key=$1', [key])).rows[0]?.value; },
    async setMetadata(key, value) { await query('INSERT INTO app_metadata(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, String(value)]); },
    async result(link) { return (await query('SELECT data FROM report_snapshots WHERE link_id=$1 AND scope=$2 ORDER BY sequence DESC LIMIT 1', [link.id, link.scope])).rows[0]?.data; },
    async pruneHousekeeping({ keepSnapshots = 3, jobCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), terminalStatuses = DEFAULT_TERMINAL_SYNC_STATUSES } = {}) {
      const keep = Math.max(3, Math.min(1000, Number(keepSnapshots) || 3));
      const cutoff = jobCutoff instanceof Date ? jobCutoff : new Date(jobCutoff);
      if (!Number.isFinite(cutoff.getTime())) throw new Error('Invalid housekeeping job cutoff.');
      const statuses = Array.isArray(terminalStatuses) && terminalStatuses.length ? terminalStatuses.map(String) : [...DEFAULT_TERMINAL_SYNC_STATUSES];
      await ready;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const snapshots = await client.query(`WITH ranked AS (
          SELECT sequence, row_number() OVER (PARTITION BY link_id, scope ORDER BY sequence DESC) AS rank
          FROM report_snapshots
        )
        DELETE FROM report_snapshots snapshot
        USING ranked
        WHERE snapshot.sequence = ranked.sequence AND ranked.rank > $1`, [keep]);
        const jobs = await client.query(`DELETE FROM sync_jobs
          WHERE data->>'status' = ANY($1::text[])
            AND CASE
              WHEN data->>'finishedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
              THEN (data->>'finishedAt')::timestamptz
              ELSE NULL
            END < $2::timestamptz`, [statuses, cutoff.toISOString()]);
        await client.query('COMMIT');
        return { snapshotsRemoved: snapshots.rowCount || 0, jobsRemoved: jobs.rowCount || 0 };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original transaction failure. */ }
        throw error;
      } finally { client.release(); }
    },
    async commit(link, result, job) {
      await ready;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO report_snapshots(id,link_id,scope,data) VALUES($1,$2,$3,$4::jsonb)', [randomUUID(), link.id, link.scope, JSON.stringify(result)]);
        await client.query('INSERT INTO report_links(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [link.id, JSON.stringify({ ...link, status: result.complete ? 'success' : 'partial', updatedAt: result.fetchedAt })]);
        await client.query('INSERT INTO sync_jobs(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', [job.id, JSON.stringify(job)]);
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original transaction failure. */ }
        throw error;
      } finally { client.release(); }
    },
    async close() { if (!providedPool) await pool.end(); }
  };
}

export function openPostgresAuthStore(databaseUrl, providedPool = null) {
  requireDatabaseUrl(databaseUrl);
  const pool = providedPool || createPostgresPool(databaseUrl);
  const ready = ensurePostgresAuthSchema(pool);
  const query = async (text, values = []) => { await ready; return pool.query(text, values); };
  const publicUser = row => row && ({ id: row.id, username: row.username, role: row.role });
  return {
    ready,
    async adminCount() { return Number((await query("SELECT count(*)::int AS count FROM app_users WHERE role='admin'")).rows[0].count); },
    async createUser(username, password, role = 'viewer', { bootstrap = false } = {}) {
      await ready;
      const name = String(username || '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(name)) throw Error('Username must be 3–64 characters: letters, numbers, dot, underscore, or hyphen.');
      if (typeof password !== 'string' || password.length < 14 || password.length > 1024) throw Error('Password must be at least 14 characters.');
      if (!['admin', 'viewer'].includes(role)) throw Error('Role must be admin or viewer.');
      const salt = randomBytes(16).toString('hex');
      const passwordHash = scryptSync(password, salt, 64).toString('hex');
      const id = randomBytes(16).toString('hex');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE');
        const count = Number((await client.query("SELECT count(*)::int AS count FROM app_users WHERE role='admin'")).rows[0].count);
        if (bootstrap && (role !== 'admin' || count !== 0)) throw Error('First-admin setup is only available before an admin exists.');
        if (!bootstrap && count === 0) throw Error('Create the first administrator before adding users.');
        await client.query('INSERT INTO app_users(id,username,username_key,salt,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, name, name.toLowerCase(), salt, passwordHash, role, new Date().toISOString()]);
        await client.query('COMMIT');
        return { id, username: name, role };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        if (error.code === '23505') throw Error('That username already exists.');
        throw error;
      } finally { client.release(); }
    },
    async resetAdminPassword(username, password) {
      await ready;
      const name = String(username || '').trim();
      if (typeof password !== 'string' || password.length < 14 || password.length > 1024) throw Error('Password must be at least 14 characters.');
      const salt = randomBytes(16).toString('hex');
      const encodedPassword = scryptSync(password, salt, 64).toString('hex');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = (await client.query("SELECT id,username,role FROM app_users WHERE username_key=$1", [name.toLowerCase()])).rows[0];
        if (!existing || existing.role !== 'admin') throw Error('Administrator account not found.');
        await client.query('UPDATE app_users SET salt=$1,password_hash=$2 WHERE id=$3', [salt, encodedPassword, existing.id]);
        await client.query('DELETE FROM app_sessions WHERE user_id=$1', [existing.id]);
        await client.query('COMMIT');
        return publicUser(existing);
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally { client.release(); }
    },
    async verify(username, password) {
      const row = (await query('SELECT id,username,role,salt,password_hash FROM app_users WHERE username_key=$1', [String(username || '').trim().toLowerCase()])).rows[0];
      if (!row) { scryptSync(String(password || ''), 'f2a3d6c87b1e4a5f', 64); return null; }
      const actual = Buffer.from(scryptSync(String(password || ''), row.salt, 64).toString('hex'), 'hex');
      const expected = Buffer.from(row.password_hash, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? publicUser(row) : null;
    },
    async issueSession(userId, lifetimeMs = 24 * 60 * 60 * 1000) {
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + lifetimeMs;
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await query('INSERT INTO app_sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [tokenHash, userId, csrfToken, expiresAt, new Date().toISOString()]);
      return { token, csrfToken, expiresAt };
    },
    async authenticate(token) {
      if (!token) return null;
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const row = (await query(`SELECT u.id,u.username,u.role,s.csrf_token,s.expires_at
        FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1`, [tokenHash])).rows[0];
      if (!row) return null;
      const expiresAt = Number(row.expires_at);
      if (expiresAt <= Date.now()) { await query('DELETE FROM app_sessions WHERE token_hash=$1', [tokenHash]); return null; }
      return { user: publicUser(row), csrfToken: row.csrf_token, expiresAt };
    },
    async revoke(token) {
      if (!token) return;
      await query('DELETE FROM app_sessions WHERE token_hash=$1', [createHash('sha256').update(token).digest('hex')]);
    },
    async listUsers() { return (await query('SELECT id,username,role,created_at AS "createdAt" FROM app_users ORDER BY username_key')).rows; },
    async grantsForUser(userId) { return (await query('SELECT link_id FROM report_grants WHERE user_id=$1 ORDER BY link_id', [userId])).rows.map(row => row.link_id); },
    async replaceGrants(userId, linkIds) {
      await ready;
      if (!Array.isArray(linkIds) || linkIds.some(id => typeof id !== 'string' || id.length > 100)) throw Error('Provide a list of valid source IDs.');
      const unique = [...new Set(linkIds)];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const target = (await client.query('SELECT role FROM app_users WHERE id=$1', [userId])).rows[0];
        if (!target) throw Error('User not found.');
        if (target.role !== 'viewer') throw Error('Report grants apply to viewer accounts only.');
        await client.query('DELETE FROM report_grants WHERE user_id=$1', [userId]);
        for (const linkId of unique) await client.query('INSERT INTO report_grants(user_id,link_id,created_at) VALUES($1,$2,$3)', [userId, linkId, new Date().toISOString()]);
        await client.query('COMMIT');
        return unique;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally { client.release(); }
    },
    async close() { if (!providedPool) await pool.end(); }
  };
}
