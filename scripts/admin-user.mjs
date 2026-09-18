import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from '../lib/config.mjs';
import { openAuthStore } from '../lib/auth-store.mjs';
import { postgresPoolConfig } from '../lib/postgres-persistence.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadLocalConfig(root);
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const [command, username, roleArg] = process.argv.slice(2);
const role = command === 'create-admin' ? 'admin' : roleArg;

function readSecret(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw Error('Run this command in an interactive terminal so the password is not exposed in shell history or process arguments.');
  return new Promise((resolveSecret, reject) => {
    let value = '';
    const stdin = process.stdin;
    const cleanup = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { cleanup(); process.stderr.write('\n'); reject(Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); process.stderr.write('\n'); resolveSecret(value); return; }
        if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); continue; }
        if (char >= ' ') value += char;
      }
    };
    process.stderr.write(label);
    stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume(); stdin.on('data', onData);
  });
}

try {
  if (!['create-admin', 'create-user', 'reset-password'].includes(command) || !username || (command === 'create-user' && !['admin', 'viewer'].includes(role))) {
    throw Error('Usage: npm run admin:create -- USERNAME\n       npm run user:create -- USERNAME viewer\n       npm run admin:reset-password -- USERNAME');
  }
  postgresPoolConfig(process.env.DATABASE_URL);
  const password = await readSecret('New password (14+ characters): ');
  const confirmation = await readSecret('Confirm password: ');
  if (password !== confirmation) throw Error('Passwords do not match.');
  const store = openAuthStore(dataDir);
  try {
    if (command === 'reset-password') {
      const changed = await store.resetAdminPassword(username, password);
      process.stdout.write(`Reset password for administrator ${changed.username}; all existing sessions were revoked.\n`);
    } else {
      const created = await store.createUser(username, password, role, { bootstrap: command === 'create-admin' });
      process.stdout.write(`Created ${created.role} account ${created.username} in the selected database.\n`);
    }
  } finally { await store.close(); }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
