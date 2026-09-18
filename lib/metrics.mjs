import { createHash } from 'node:crypto';

export function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || /^n\/?a$|^-$/i.test(raw)) return null;
  const normalized = raw.includes('.') && !raw.includes(',') && /^[1-9]\d{0,2}(\.\d{3})+$/.test(raw)
    ? raw.replace(/\./g, '')
    : raw.includes(',') && raw.includes('.')
    ? (raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, ''))
    : raw.replace(/,/g, '').replace(/\s/g, '');
  const n = Number(normalized.replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const input = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i], next = input[i + 1];
    if (c === '"' && quoted && next === '"') { cell += '"'; i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && next === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = []; continue;
    }
    cell += c;
  }
  if (cell || row.length) { row.push(cell); if (row.some(v => v.trim() !== '')) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, (values[i] ?? '').trim()])));
}

export function normalizeMetric(row, meta = {}) {
  if (Object.values(row).some(v => /^tổng$|^total$/i.test(String(v).trim()))) return { skip: true };
  const pick = (...names) => {
    const key = Object.keys(row).find(k => names.some(n => k.toLowerCase() === n.toLowerCase()));
    return key ? row[key] : undefined;
  };
  const clicks = parseNumber(pick('clicks', 'click', 'Click'));
  const impressions = parseNumber(pick('impressions', 'impression', 'Lượt hiển thị', 'View Impression'));
  const spend = parseNumber(pick('spend', 'cost', 'Tiền', 'Budget'));
  const engagement = parseNumber(pick('engagement', 'Engagement'));
  const viewers = parseNumber(pick('viewers', 'Người xem', 'Viewers'));
  const date = pick('date', 'Date', 'Ngày') || null;
  const campaignId = pick('campaign_id', 'campaign', 'Campaign ID') || meta.campaignId || null;
  const dimensions = { creative: pick('creative', 'Quảng cáo') || null, device: meta.device || null };
  const level = date ? 'daily' : 'period';
  const key = createHash('sha256').update(JSON.stringify([meta.source, meta.account, campaignId, date, level, dimensions])).digest('hex').slice(0, 24);
  return { key, source: meta.source, account: meta.account || null, campaignId, date, level, dimensions, clicks, impressions, spend, engagement, viewers, raw: row, fetchedAt: new Date().toISOString(), syncRunId: meta.syncRunId || null };
}

export function aggregate(facts) {
  const sum = field => facts.reduce((t, f) => t + (Number(f[field]) || 0), 0);
  const clicks = sum('clicks'), impressions = sum('impressions'), spend = sum('spend'), engagement = sum('engagement');
  return { clicks, impressions, spend, engagement, ctr: impressions ? clicks / impressions * 100 : null, cpc: clicks ? spend / clicks : null, cpm: impressions ? spend / impressions * 1000 : null };
}

export function completion(actual, target) {
  if (actual === null || actual === undefined || target === null || target === undefined || !Number(target)) return null;
  return Number(actual) / Number(target) * 100;
}
