import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from '../lib/config.mjs';
import { openAuthStore } from '../lib/auth-store.mjs';
import { openStore } from '../lib/link-store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadLocalConfig(root);
const directory = resolve(process.env.DATA_DIR || join(root, 'data'));
const [username, ...requestedIds] = process.argv.slice(2);

try {
  if (username === '--list' && requestedIds.length === 0) {
    const store = openStore(directory);
    try {
      for (const link of await store.list()) process.stdout.write(`${link.id}\t${link.name}\t${link.source}\t${link.from || '?'} → ${link.to || '?'}\n`);
    } finally { await store.close(); }
    process.exit(0);
  }
  if (!username || requestedIds.some(id => id.startsWith('-'))) throw Error('Usage: npm run grant:reports -- --list\n       npm run grant:reports -- USERNAME [SOURCE_ID ...]\nPass no source IDs to revoke all report access.');
  const auth = openAuthStore(directory);
  const store = openStore(directory);
  try {
    const user = (await auth.listUsers()).find(item => item.username.toLowerCase() === username.toLowerCase());
    if (!user) throw Error('User not found.');
    if (user.role !== 'viewer') throw Error('Report grants apply to viewer accounts only.');
    const available = new Map((await store.list()).map(link => [link.id, link]));
    for (const id of requestedIds) if (!available.has(id)) throw Error(`Unknown source ID: ${id}`);
    const grants = await auth.replaceGrants(user.id, requestedIds);
    process.stdout.write(`Updated report grants for ${user.username}: ${grants.length} source(s).\n`);
    for (const id of grants) process.stdout.write(`- ${available.get(id).name}\n`);
  } finally { await store.close(); await auth.close(); }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
