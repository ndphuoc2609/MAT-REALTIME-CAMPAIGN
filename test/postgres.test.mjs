import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresPoolConfig } from '../lib/postgres-persistence.mjs';
import { openStore } from '../lib/link-store.mjs';
import { openAuthStore } from '../lib/auth-store.mjs';
import { createApp } from '../source-app.mjs';

test('application and store factories fail clearly without a PostgreSQL URL', () => {
  assert.throws(() => createApp({ databaseUrl: '' }), /DATABASE_URL is required/);
  assert.throws(() => openStore(undefined, { databaseUrl: '' }), /DATABASE_URL is required/);
  assert.throws(() => openAuthStore(undefined, { databaseUrl: '' }), /DATABASE_URL is required/);
  assert.throws(() => createApp({ databaseUrl: 'file:local.db' }), /postgres/);
});

test('PostgreSQL config explicitly enables required TLS channel binding', () => {
  const config = postgresPoolConfig('postgresql://test:test@db.example.invalid/reports?sslmode=require&channel_binding=require');
  assert.equal(config.enableChannelBinding, true);
  assert.equal(new URL(config.connectionString).searchParams.get('sslmode'), 'verify-full');
  assert.equal(config.connectionTimeoutMillis, 5000);
  assert.equal(config.max, 8);
});

test('PostgreSQL config rejects unsupported or insecure connection settings', () => {
  assert.throws(() => postgresPoolConfig('mysql://db.example.invalid/reports'), /postgres/);
  assert.throws(() => postgresPoolConfig('postgresql://db.example.invalid/reports?channel_binding=unknown'), /channel_binding/);
  assert.throws(() => postgresPoolConfig('postgresql://db.example.invalid/reports?sslmode=disable&channel_binding=require'), /sslmode/);
});

test('PostgreSQL snapshot commit is transactional and releases its client', async () => {
  const clientQueries = [];
  const pool = {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(sql, values) { clientQueries.push({ sql, values }); return { rows: [] }; },
        release() { clientQueries.push({ sql: 'RELEASE' }); }
      };
    }
  };
  const { openPostgresLinkStore } = await import('../lib/postgres-persistence.mjs');
  const store = openPostgresLinkStore('postgresql://test:test@db.example.invalid/reports?sslmode=require', pool);
  await store.ready;
  await store.commit(
    { id: 'link-id', scope: 'scope', name: 'test' },
    { complete: true, fetchedAt: '2026-09-15T00:00:00.000Z', total: { impressions: 0 } },
    { id: 'job-id', status: 'success' }
  );
  assert.deepEqual(clientQueries.map(query => query.sql), [
    'BEGIN',
    'INSERT INTO report_snapshots(id,link_id,scope,data) VALUES($1,$2,$3,$4::jsonb)',
    'INSERT INTO report_links(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',
    'INSERT INTO sync_jobs(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data',
    'COMMIT',
    'RELEASE'
  ]);
  assert.equal(JSON.parse(clientQueries[1].values[3]).total.impressions, 0);
});

test('PostgreSQL housekeeping uses one transaction and parameterized retention inputs', async () => {
  const clientQueries = [];
  const pool = {
    async query() { return { rows: [] }; },
    async connect() {
      return {
        async query(sql, values) {
          clientQueries.push({ sql, values });
          return { rowCount: sql.startsWith('WITH ranked') ? 2 : sql.startsWith('DELETE FROM sync_jobs') ? 1 : 0, rows: [] };
        },
        release() { clientQueries.push({ sql: 'RELEASE' }); }
      };
    }
  };
  const { openPostgresLinkStore } = await import('../lib/postgres-persistence.mjs');
  const store = openPostgresLinkStore('postgresql://test:test@db.example.invalid/reports?sslmode=require', pool);
  const result = await store.pruneHousekeeping({ keepSnapshots: 3, jobCutoff: new Date('2026-06-01T00:00:00.000Z'), terminalStatuses: ['success'] });
  assert.deepEqual(result, { snapshotsRemoved: 2, jobsRemoved: 1 });
  assert.deepEqual(clientQueries.map(query => query.sql.startsWith('WITH ranked') ? 'SNAPSHOTS' : query.sql.startsWith('DELETE FROM sync_jobs') ? 'JOBS' : query.sql), ['BEGIN', 'SNAPSHOTS', 'JOBS', 'COMMIT', 'RELEASE']);
  assert.equal(clientQueries[1].values[0], 3);
  assert.deepEqual(clientQueries[2].values[0], ['success']);
  assert.equal(clientQueries[2].values[1], '2026-06-01T00:00:00.000Z');
});

test('both store factories use the injected PostgreSQL pool', async () => {
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); return { rows: [] }; } };
  const databaseUrl = 'postgresql://test:test@db.example.invalid/reports?sslmode=require';
  const links = openStore(undefined, { databaseUrl, pool });
  const auth = openAuthStore(undefined, { databaseUrl, pool });
  try {
    await Promise.all([links.ready, auth.ready]);
    assert.equal(queries.length, 2);
    assert.match(queries[0], /report_links/);
    assert.match(queries[1], /app_users/);
  } finally {
    await links.close();
    await auth.close();
  }
});
