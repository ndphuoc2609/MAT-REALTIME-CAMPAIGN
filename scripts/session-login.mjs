import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright';
import { loadLocalConfig, source24hAllowInsecureHttp } from '../lib/config.mjs';
import { openStore } from '../lib/link-store.mjs';
import { acquireProfileLock, recoverProfilePromotion } from '../lib/source-session.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadLocalConfig(root);
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
const connector = process.argv[2];
const connectors = {
  'admicro-pc': ['admicro', 'https://adx.admicro.vn/'],
  'admicro-mobile': ['admicro', 'https://adx.admicro.vn/'],
  '24h': ['24h', 'https://khachhang.24h.com.vn/ocm/user/login?login=1'],
  'fpt': ['fpt', 'https://news.fptonline.net/']
};

if (!connectors[connector]) {
  process.stderr.write('Usage: npm run session:login -- admicro-pc|admicro-mobile|24h|fpt\n');
  process.exit(1);
}

const [profileName, defaultUrl] = connectors[connector];
const profile = join(dataDir, 'sessions', profileName);
let target = defaultUrl;
const store = openStore(dataDir);
try {
  const saved = (await store.list()).find(link => link.connector === connector);
  if (saved?.url) target = saved.url;
} finally { await store.close(); }
if (connector === '24h') {
  const allowInsecureHttp = source24hAllowInsecureHttp();
  const protocol = allowInsecureHttp ? 'http:' : 'https:';
  target = new URL('/ocm/user/login?login=1', `${protocol}//khachhang.24h.com.vn`).href;
}

let context;
let profileLock;
let closeOnLockLoss;
try {
  profileLock = await acquireProfileLock(dataDir, connector);
  await recoverProfilePromotion(profile);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  const launch = { headless: false, viewport: { width: 1440, height: 950 } };
  if (process.env.CHROME_BIN) launch.executablePath = process.env.CHROME_BIN;
  context = await chromium.launchPersistentContext(profile, launch);
  closeOnLockLoss = profileLock.lost.then(() => context?.close().catch(() => {})).catch(() => {});
  const page = context.pages()[0] || await context.newPage();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  process.stdout.write(`A browser opened for ${connector}. Sign in directly with the source, then return to this terminal.\n`);
  process.stdout.write('The profile is stored in the configured data directory. Press Enter here to save and close the browser.\n');
  const prompt = createInterface({ input: stdin, output: stdout });
  await prompt.question('Press Enter when the signed-in page is ready… ');
  prompt.close();
} catch (error) {
  process.stderr.write(`Could not refresh ${connector} session: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  try { if (context) await context.close(); }
  finally {
    try { if (profileLock) profileLock.assertHeld(); }
    finally { if (profileLock) await profileLock.release(); }
  }
}
