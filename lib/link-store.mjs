import { openPostgresLinkStore, requireDatabaseUrl } from './postgres-persistence.mjs';

export function openStore(_directory, options = {}) {
  const databaseUrl = Object.prototype.hasOwnProperty.call(options, 'databaseUrl')
    ? options.databaseUrl
    : process.env.DATABASE_URL;
  return openPostgresLinkStore(requireDatabaseUrl(databaseUrl), options.pool || null);
}
