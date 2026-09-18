import { openPostgresAuthStore, requireDatabaseUrl } from './postgres-persistence.mjs';

export function openAuthStore(_directory, options = {}) {
  const databaseUrl = Object.prototype.hasOwnProperty.call(options, 'databaseUrl')
    ? options.databaseUrl
    : process.env.DATABASE_URL;
  return openPostgresAuthStore(requireDatabaseUrl(databaseUrl), options.pool || null);
}
