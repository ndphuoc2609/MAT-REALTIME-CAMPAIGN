import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeAdmicroRaw } from '../lib/connectors.mjs';

const fixture = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/admicro-mobile-report.json'), 'utf8'));

test('Admicro mobile one-page report keeps overview and summary tabs', () => {
  const result = normalizeAdmicroRaw(fixture);
  assert.deepEqual(result.total, {
    impressions: 2883371,
    clicks: 7129,
    spend: 11883165,
    engagement: null,
    viewers: 1027267,
    ctr: 7129 / 2883371 * 100
  });
  assert.equal(result.details.length, 4);
  assert.equal(result.details[0].creative, '300-x-250');
  assert.equal(result.details[0].clicks, 71);
  assert.equal(result.details[0].impressions, 49893);
  assert.equal(result.details[0].viewers, 32784);
  assert.equal(result.details[0].spend, 106038);
  assert.equal(result.details[0].bid, 1500);
  assert.equal(result.details[0].avgPrice, 1493);
  assert.equal(result.daily.length, 2);
  assert.equal(result.daily[0].date, '2026-09-04');
  assert.equal(result.daily[0].clicks, 502);
  assert.equal(result.daily[0].viewers, null, 'daily source table has no viewers column');
  assert.equal(result.total.viewers, 1027267, 'period viewers remain available from the source total');
  assert.equal(result.summary.campaigns[0].campaign, 'Hyundai KMBH T9.26');
  assert.equal(result.summary.campaigns[0].contract, 'QC2910326');
  assert.equal(result.summary.regions[0]['% Click Bắc'], '42%');
  assert.equal(result.summary.domains[0].domain, 'm.thethao247.vn');
  assert.equal(result.summary.domains[0].clicks, 1761);
});
