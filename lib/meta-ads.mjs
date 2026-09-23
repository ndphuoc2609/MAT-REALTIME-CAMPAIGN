import { metaAdsConfig } from './config.mjs';
import { SourceError } from './source-error.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 613]);
export const META_CONNECTOR = 'meta-ads';

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function metric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new SourceError('Meta Ads trả về metric không hợp lệ.', 'schema_error');
  return number;
}

function sum(rows, key) {
  return rows.length && rows.every(row => row[key] != null) ? rows.reduce((total, row) => total + row[key], 0) : null;
}

function metrics(impressions, clicks) {
  return { impressions, clicks, ctr: impressions ? clicks == null ? null : clicks / impressions * 100 : null };
}

export function aggregateMetaAdsRows(rows, { from, to } = {}) {
  const grouped = new Map();
  for (const row of rows) {
    const date = row.date_start;
    if (!validDate(date) || from && date < from || to && date > to) throw new SourceError('Meta Ads trả về ngày ngoài khoảng hoặc sai định dạng.', 'schema_error');
    const normalized = { impressions: metric(row.impressions), clicks: metric(row.clicks) };
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(normalized);
  }
  const daily = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => ({ date, ...metrics(sum(items, 'impressions'), sum(items, 'clicks')) }));
  const total = metrics(sum(daily, 'impressions'), sum(daily, 'clicks'));
  return { total, daily };
}

function retryable(error) {
  return error && !(error instanceof SourceError) && (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(error.code) || error.name === 'AbortError' || /timeout|fetch failed|network|socket/i.test(String(error.message || '')));
}

async function responseJson(response) {
  try {
    const text = await response.text();
    return JSON.parse(text);
  } catch {
    throw new SourceError('Meta Ads trả về phản hồi không phải JSON hợp lệ.', 'schema_error');
  }
}

function validateNext(value, origin, graphVersion) {
  let next;
  try { next = new URL(value); } catch { throw new SourceError('Meta Ads trả về liên kết phân trang không hợp lệ.', 'schema_error'); }
  if (next.protocol !== 'https:' || next.origin !== origin || !next.pathname.startsWith(`/${graphVersion}/`)) throw new SourceError('Meta Ads trả về liên kết phân trang ngoài Graph API đã cấu hình.', 'schema_error');
  next.searchParams.delete('access_token');
  return next;
}

function apiError(payload, status) {
  const code = Number(payload?.error?.code);
  if (code === 190 || status === 401) return new SourceError('Meta Ads yêu cầu META_ACCESS_TOKEN hợp lệ.', 'auth_required');
  if (code === 10 || code === 200 || status === 403) return new SourceError('Token Meta Ads không có quyền đọc tài khoản hoặc báo cáo này.', 'access_denied');
  if (status === 429 || status >= 500 || TRANSIENT_GRAPH_CODES.has(code)) return new SourceError('Meta Graph API tạm thời không khả dụng sau các lần thử giới hạn.', 'network_error');
  return new SourceError(`Meta Graph API từ chối yêu cầu (HTTP ${status || 'không xác định'}).`, 'http_error');
}

export async function collectMetaAds(link, {
  env = process.env, fetchImpl = globalThis.fetch, maxRetries = 2, retryDelayMs = 250,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(), update = async () => {}, job = {}
} = {}) {
  if (typeof fetchImpl !== 'function') throw new SourceError('Máy chủ không hỗ trợ fetch cho Meta Ads.', 'config_error');
  let config;
  try { config = metaAdsConfig(env); }
  catch (error) { throw new SourceError(error.message, 'config_error'); }
  if (String(link.account || link.metaReport?.account || '').replace(/^act_/, '') !== config.accountId) throw new SourceError('Tài khoản trong link Meta Ads không khớp META_AD_ACCOUNT_ID.', 'config_error');
  if (!validDate(link.from) || !validDate(link.to) || link.from > link.to) throw new SourceError('Khoảng ngày Meta Ads không hợp lệ.', 'config_error');
  const base = `https://graph.facebook.com/${config.graphVersion}`;
  const endpoint = new URL(`${base}/act_${config.accountId}/insights`);
  const filters = link.metaReport?.filters;
  if (!filters || typeof filters.campaignName !== 'string' || !filters.campaignName.trim() || String(filters.hadDelivery) !== '1' || filters.objective != null && (!Array.isArray(filters.objective) || !filters.objective.length || filters.objective.some(item => typeof item !== 'string' || !item.trim()))) throw new SourceError('Link Meta Ads thiếu bộ lọc báo cáo hợp lệ.', 'config_error');
  endpoint.searchParams.set('level', 'campaign');
  endpoint.searchParams.set('time_increment', '1');
  endpoint.searchParams.set('time_range', JSON.stringify({ since: link.from, until: link.to }));
  endpoint.searchParams.set('fields', 'date_start,campaign_name,clicks,impressions,ctr');
  const filtering = [{ field: 'campaign.name', operator: 'CONTAIN', value: filters.campaignName }];
  if (filters.objective != null) filtering.push({ field: 'campaign.objective', operator: 'IN', value: filters.objective });
  endpoint.searchParams.set('filtering', JSON.stringify(filtering));
  job.status = 'running'; job.message = 'Đang lấy báo cáo Meta Ads'; await update();

  const rows = [];
  const visited = new Set();
  let url = endpoint;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    if (visited.has(url.href)) throw new SourceError('Meta Ads lặp lại liên kết phân trang; đã dừng thu thập.', 'schema_error');
    visited.add(url.href);
    let response, payload;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
      try {
        response = await fetchImpl(url, { headers: { authorization: `Bearer ${config.accessToken}` }, signal: controller.signal });
        payload = await responseJson(response);
      } catch (error) {
        if (error instanceof SourceError) throw error;
        if (attempt < maxRetries && retryable(error)) { await sleep(retryDelayMs * (2 ** attempt)); continue; }
        throw new SourceError('Không thể kết nối Meta Graph API hoặc yêu cầu đã hết thời gian chờ.', 'network_error');
      } finally { clearTimeout(timer); }
      if (response.status === 429 || response.status >= 500 || TRANSIENT_GRAPH_CODES.has(Number(payload?.error?.code))) {
        if (attempt < maxRetries) { await sleep(retryDelayMs * (2 ** attempt)); continue; }
      }
      break;
    }
    if (!response.ok || payload?.error) throw apiError(payload, response.status);
    if (!Array.isArray(payload?.data)) throw new SourceError('Meta Ads không trả về danh sách dòng báo cáo.', 'schema_error');
    for (const row of payload.data) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.date_start !== 'string' || !('clicks' in row) || !('impressions' in row)) throw new SourceError('Meta Ads trả về dòng báo cáo thiếu ngày hoặc metrics cần thiết.', 'schema_error');
      const impressions = metric(row.impressions);
      if (impressions == null) throw new SourceError('Meta Ads thiếu impressions nên không thể áp dụng bộ lọc had_delivery=1.', 'schema_error');
      if (impressions > 0) rows.push(row);
    }
    if (payload.paging?.next) url = validateNext(payload.paging.next, new URL(base).origin, config.graphVersion);
    else url = null;
  }
  if (url) throw new SourceError('Meta Ads vượt giới hạn số trang báo cáo.', 'schema_error');
  const aggregate = aggregateMetaAdsRows(rows, { from: link.from, to: link.to });
  const incomplete = aggregate.daily.some(row => row.clicks == null || row.impressions == null);
  const dailyTotal = aggregate.total;
  return {
    ...aggregate, details: [],
    reconciliation: { dailyTotal, differences: { impressions: aggregate.total.impressions == null ? null : 0, clicks: aggregate.total.clicks == null ? null : 0 }, status: incomplete ? 'incomplete' : 'matched' },
    complete: !incomplete,
    fetchedAt: now().toISOString(), from: link.from, to: link.to, timezone: null,
    method: `Meta Graph API ${config.graphVersion} Insights theo ngày`, verification: 'live',
    warnings: rows.length ? [] : ['Meta Ads không có dòng dữ liệu trong khoảng ngày; số liệu được giữ là chưa xác định, không đổi thành 0.'],
    viewerDefinition: `Báo cáo Meta Ads theo ngày, lọc campaign_name CONTAIN “${filters.campaignName}”${filters.objective == null ? '' : `, objective IN ${filters.objective.join(', ')}`} và chỉ giữ dòng có impressions > 0 (had_delivery=1); CTR tính từ tổng clicks / impressions.`
  };
}
