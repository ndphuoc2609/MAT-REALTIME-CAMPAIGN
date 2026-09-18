import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadLocalConfig } from '../lib/config.mjs';
import { acquireProfileLock, recoverProfilePromotion } from '../lib/source-session.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadLocalConfig(root);
const directory = resolve(process.env.DATA_DIR || join(root, 'data'));
const [operation, connector, fileArg] = process.argv.slice(2);
const profiles = {
  'admicro-pc': { profile: 'admicro', domain: 'admicro.vn' },
  'admicro-mobile': { profile: 'admicro', domain: 'admicro.vn' },
  '24h': { profile: '24h', domain: '24h.com.vn' },
  fpt: { profile: 'fpt', domain: 'fptonline.net' }
};

function usage() {
  process.stderr.write('Usage: npm run session:state -- export CONNECTOR FILE\n       npm run session:state -- import CONNECTOR PRIVATE_FILE\n');
  process.exit(2);
}
function hostAllowed(host, base) { return host === base || host.endsWith(`.${base}`); }
function browserLaunch() { const options = { headless: true }; if (process.env.CHROME_BIN) options.executablePath = process.env.CHROME_BIN; return options; }

if (!['export', 'import'].includes(operation) || !profiles[connector] || !fileArg) usage();
const profile = resolve(directory, 'sessions', profiles[connector].profile);
const file = resolve(fileArg);

const profileLock = await acquireProfileLock(directory, connector);
try {
await recoverProfilePromotion(profile);
mkdirSync(resolve(directory, 'sessions'), { recursive: true, mode: 0o700 });
chmodSync(resolve(directory, 'sessions'), 0o700);
if (operation === 'export') {
  if (!existsSync(profile)) throw Error('No persistent profile exists yet. Sign in with `npm run session:login -- CONNECTOR` first.');
  if (existsSync(file)) throw Error('Refusing to overwrite an existing state file. Choose a new private path.');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, browserLaunch());
  try {
    const state = await context.storageState();
    for (const cookie of state.cookies) {
      const host = cookie.domain.replace(/^\./, '');
      if (!hostAllowed(host, profiles[connector].domain)) throw Error('Profile contains a cookie outside the selected connector; state was not exported.');
    }
    for (const origin of state.origins) {
      if (!hostAllowed(new URL(origin.origin).hostname, profiles[connector].domain)) throw Error('Profile contains local storage outside the selected connector; state was not exported.');
    }
    // The export is a credential file. Create it exclusively, then restrict it.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    chmodSync(file, 0o600);
  } finally { await context.close(); }
  process.stdout.write(`Protected storage state exported for ${connector}. Transfer it with SSH/SFTP and remove it after import.\n`);
} else {
  const fileStat = statSync(file);
  if (!fileStat.isFile() || fileStat.size > 5_000_000 || (fileStat.mode & 0o077) !== 0) throw Error('State file must be under 5 MB and private to its owner (chmod 600).');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw Error('Invalid Playwright storage-state format.');
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') throw Error('Invalid cookie entry in storage state.');
    if (!hostAllowed(cookie.domain.replace(/^\./, ''), profiles[connector].domain)) throw Error('State file contains a cookie outside the selected connector.');
  }
  for (const origin of state.origins) {
    const host = new URL(origin.origin).hostname;
    if (!hostAllowed(host, profiles[connector].domain) || !Array.isArray(origin.localStorage)) throw Error('State file contains local storage outside the selected connector.');
  }
  const candidate = `${profile}.pending`;
  if (existsSync(candidate)) throw Error('A pending candidate already exists. Review or resolve it before importing another state file.');
  const staging = `${candidate}.stage-${randomUUID()}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(staging, 0o700);
  const context = await chromium.launchPersistentContext(staging, browserLaunch());
  try {
    if (state.cookies.length) await context.addCookies(state.cookies);
    for (const entry of state.origins) {
      const page = await context.newPage();
      await page.goto(entry.origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.evaluate(items => { for (const item of items) localStorage.setItem(item.name, item.value); }, entry.localStorage);
      await page.close();
    }
  } finally { await context.close(); }
  profileLock.assertHeld();
  await rename(staging, candidate);
  chmodSync(candidate, 0o700);
  process.stdout.write(`Protected storage state staged for ${connector}. The active profile is unchanged; the next admin-triggered sync will test this candidate and promote it only after a report is parsed.\n`);
}
} finally {
  try { profileLock.assertHeld(); }
  finally { await profileLock.release(); }
}
