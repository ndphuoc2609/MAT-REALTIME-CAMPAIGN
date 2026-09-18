import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { openAuthStore } from '../lib/auth-store.mjs';
if (!process.env.DATA_DIR || resolve(process.env.DATA_DIR) === resolve('data')) throw Error('Set DATA_DIR to a disposable test directory before running the browser smoke test.');
if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL to an isolated PostgreSQL test database before running the browser smoke test.');
const base = process.env.TEST_URL || 'http://localhost:8792';
const auth = openAuthStore(resolve(process.env.DATA_DIR), { databaseUrl: process.env.TEST_DATABASE_URL });
const username = `ui-test-${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
await auth.createUser(username, password, 'admin', { bootstrap: await auth.adminCount() === 0 });
await auth.close();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.locator('#username').fill(username); await page.locator('#password').fill(password); await page.getByRole('button', { name: 'Sign in' }).click(); await page.getByRole('button', { name: '+ Thêm link' }).waitFor();
  for (const [name, url] of [
    ['Test PC', 'https://adx.admicro.vn/vn/campaign/detail/103592?fd=2026-09-01&td=2026-09-08'],
    ['Test Mobile', 'https://adx.admicro.vn/mobile/vn/campaign/detail/49891?fd=2026-09-01&td=2026-09-08'],
    ['Test 24h', 'http://khachhang.24h.com.vn/ocm/lineitem/index/?c_statistic_from_date=07-08-2026&c_statistic_to_date=31-08-2026'],
    ['Test FPT', 'https://news.fptonline.net/report/detail-banner-report?token=DEMO_ONLY']
  ]) {
    await page.getByRole('button', { name: '+ Thêm link' }).click(); await page.locator('#url').fill(url); await page.locator('#name').fill(name);
    await page.getByRole('button', { name: 'Nhận diện link', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#previewText').textContent.length > 0);
    if (name === 'Test FPT') { await page.locator('#from').fill('2026-08-07'); await page.locator('#to').fill('2026-08-31'); }
    await page.getByRole('button', { name: 'Lưu link', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('#editor').open);
  }
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
  assert.equal(await page.locator('.card').count(), 4); assert.ok(!(await page.locator('body').innerText()).includes('DEMO_ONLY'));
  await page.locator('#monthFilter').selectOption('2026-08'); await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
  assert.equal(await page.locator('#all').textContent(), 'Lấy tất cả trong tháng'); assert.equal(await page.locator('#monthFilter').inputValue(), '2026-08');
  let collectUrl = ''; await page.route('**/api/links/collect-all*', async route => { collectUrl = route.request().url(); await route.fulfill({ status: 202, contentType: 'application/json', body: '{"jobs":[]}' }) }); await page.locator('#all').click(); assert.match(collectUrl, /month=2026-08/);
  await page.reload(); await page.waitForFunction(() => document.querySelectorAll('.card').length === 2); assert.equal(await page.locator('#monthFilter').inputValue(), '2026-08');
  await page.locator('#monthFilter').selectOption(''); await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
  const pc = page.locator('.card').filter({ hasText: 'Test PC' }); await pc.getByRole('button', { name: 'Sửa', exact: true }).click();
  await page.locator('#url').fill('https://adx.admicro.vn/vn/campaign/detail/103593?fd=2026-09-02&td=2026-09-07');
  await page.getByRole('button', { name: 'Nhận diện link', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#previewText').textContent.includes('103593'));
  await page.getByRole('button', { name: 'Lưu link', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('#editor').open);
  await pc.getByRole('button', { name: 'Xem chi tiết' }).click(); assert.equal(await page.locator('#detail').isVisible(), true);
  assert.match(await page.locator('#detail').innerText(), /2026-09-02/); assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/admicro-links-ui.png', fullPage: true });
  console.log('PASS: four links / three sources; preview; persistence; edit dates; details; token masking; no JS errors.');
} finally { await browser.close(); }
