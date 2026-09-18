import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseNumber, normalizeMetric, aggregate, completion } from '../lib/metrics.mjs';

test('parseNumber handles Vietnamese and missing values', () => {
  assert.equal(parseNumber('1,000,866'), 1000866);
  assert.equal(parseNumber('1.315.958'), 1315958);
  assert.equal(parseNumber('0.154'), 0.154);
  assert.equal(parseNumber('N/A'), null);
});

test('CSV parser preserves quoted commas', () => {
  const rows = parseCsv('\uFEFF"Quảng cáo","Click","Lượt hiển thị"\n"A, B","12","1,000"');
  assert.deepEqual(rows[0], { 'Quảng cáo': 'A, B', Click: '12', 'Lượt hiển thị': '1,000' });
});

test('normalization and aggregate calculate weighted CTR', () => {
  const facts = [
    normalizeMetric({ Click: '512', 'Lượt hiển thị': '1.016.514' }, { source: 'fixture' }),
    normalizeMetric({ Click: '100', 'Lượt hiển thị': '1000' }, { source: 'fixture' })
  ];
  const a = aggregate(facts);
  assert.equal(a.clicks, 612);
  assert.equal(a.impressions, 1017514);
  assert.ok(Math.abs(a.ctr - 0.06015) < 0.0001);
});

test('total rows are marked and KPI completion is explicit', () => {
  assert.equal(normalizeMetric({ label: 'Tổng', Click: '99' }, { source: 'fixture' }).skip, true);
  assert.equal(completion(11895, null), null);
  assert.equal(Math.round(completion(11895, 10000) * 100) / 100, 118.95);
});
