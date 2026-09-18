import { createHash } from 'node:crypto';
import { month } from './links.mjs';
import { SourceError } from './source-error.mjs';

const TOKEN_ENDPOINT = 'https://accounts.google.com/o/oauth2/token';
const ADS_ENDPOINT = 'https://googleads.googleapis.com/v25/customers';
const DEFAULT_TIMEOUT_MS = 30_000;
const GOOGLE_CONNECTOR = 'google-ads';

function monthDays(year, monthNumber) {
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

export function googleAdsMonthBounds(value) {
  const reportMonth = month(value);
  const [year, monthNumber] = reportMonth.split('-').map(Number);
  const lastDay = monthDays(year, monthNumber);
  return {
    month: reportMonth,
    from: `${reportMonth}-01`,
    to: `${reportMonth}-${String(lastDay).padStart(2, '0')}`
  };
}

export function monthInTimeZone(value = new Date(), timeZone = 'Asia/Ho_Chi_Minh') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit'
  }).formatToParts(value).filter(part => part.type !== 'literal');
  const result = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${result.year}-${result.month}`;
}

function requiredConfigValue(env, key) {
  const value = String(env?.[key] ?? '').trim();
  if (!value) throw new SourceError(`Thiếu cấu hình ${key} cho Google Ads.`, 'config_error');
  return value;
}

function optionalConfigValue(env, key) {
  const value = String(env?.[key] ?? '').trim();
  return value || null;
}

function customerId(value, key) {
  const normalized = requiredConfigValue({ [key]: value }, key).replace(/-/g, '');
  if (!/^\d{6,20}$/.test(normalized)) throw new SourceError(`Cấu hình ${key} của Google Ads không hợp lệ.`, 'config_error');
  return normalized;
}

export function googleAdsConfig(env = process.env) {
  return {
    clientId: requiredConfigValue(env, 'GOOGLE_ADS_CLIENT_ID'),
    clientSecret: requiredConfigValue(env, 'GOOGLE_ADS_CLIENT_SECRET'),
    refreshToken: requiredConfigValue(env, 'GOOGLE_ADS_REFRESH_TOKEN'),
    developerToken: optionalConfigValue(env, 'GOOGLE_ADS_DEVELOPER_TOKEN'),
    customerId: customerId(env.GOOGLE_ADS_CUSTOMER_ID, 'GOOGLE_ADS_CUSTOMER_ID'),
    loginCustomerId: customerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, 'GOOGLE_ADS_LOGIN_CUSTOMER_ID')
  };
}

export function googleAdsMonthlyLink(reportMonth) {
  const bounds = googleAdsMonthBounds(reportMonth);
  const identity = `${GOOGLE_CONNECTOR}:${bounds.month}`;
  return {
    id: `google-ads-${bounds.month}`,
    url: `google-ads://monthly/${bounds.month}`,
    query: {},
    connector: GOOGLE_CONNECTOR,
    source: 'Google Ads',
    reportMonth: bounds.month,
    from: bounds.from,
    to: bounds.to,
    name: `Google Ads · ${bounds.month}`,
    needsDates: false,
    scope: createHash('sha256').update(identity).digest('hex'),
    status: 'idle'
  };
}

export async function ensureGoogleAdsMonthlyLinks(store, { requestedMonth = null, now = new Date() } = {}) {
  const existing = await store.list();
  const months = new Set([monthInTimeZone(now)]);
  for (const link of existing) {
    const candidateMonth = link?.reportMonth || (typeof link?.from === 'string' ? link.from.slice(0, 7) : null);
    if (candidateMonth) {
      try { months.add(month(candidateMonth)); } catch { /* Ignore legacy invalid labels. */ }
    }
  }
  if (requestedMonth) months.add(month(requestedMonth));
  const byMonth = new Map(existing.filter(link => link?.connector === GOOGLE_CONNECTOR && link.reportMonth).map(link => [link.reportMonth, link]));
  const created = [];
  for (const reportMonth of [...months].sort()) {
    if (byMonth.has(reportMonth)) continue;
    const link = googleAdsMonthlyLink(reportMonth);
    await store.put(link);
    created.push(link);
  }
  return { links: [...existing, ...created], created };
}

function responseStatus(response) {
  return Number(response?.status || 0);
}

function responseOk(response) {
  const status = responseStatus(response);
  return response?.ok === undefined ? status >= 200 && status < 300 : response.ok;
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

function networkError(error) {
  return error && !(error instanceof SourceError) && (
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND'].includes(error.code) ||
    error.name === 'AbortError' || /(?:timed? ?out|timeout|network|socket|fetch failed)/i.test(String(error.message || ''))
  );
}

async function wait(delayMs) {
  if (delayMs <= 0) return;
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

async function readJson(response) {
  try {
    const text = typeof response?.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}

async function requestWithRetry(request, { maxRetries = 2, sleep = wait, retryDelayMs = 250 } = {}) {
  const retries = Math.max(0, Number.isInteger(maxRetries) ? maxRetries : 2);
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request();
      if (retryableStatus(responseStatus(response)) && attempt < retries) {
        await sleep(retryDelayMs * (2 ** attempt));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt < retries && networkError(error)) {
        await sleep(retryDelayMs * (2 ** attempt));
        continue;
      }
      throw new SourceError('Không thể kết nối Google Ads hoặc yêu cầu đã hết thời gian chờ.', 'network_error');
    }
  }
}

function requestSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortController === 'undefined') return {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

function classifyHttpError(status, endpoint) {
  if (endpoint === 'OAuth Google Ads' && status === 400) return new SourceError('OAuth Google Ads từ chối thông tin xác thực đã cấu hình.', 'auth_required');
  if (status === 401) return new SourceError(`${endpoint} yêu cầu xác thực Google Ads hợp lệ.`, 'auth_required');
  if (status === 403) return new SourceError(`Tài khoản Google Ads không có quyền truy cập ${endpoint}.`, 'access_denied');
  if (retryableStatus(status)) return new SourceError(`${endpoint} đang tạm thời không khả dụng sau các lần thử giới hạn.`, 'network_error');
  return new SourceError(`${endpoint} trả về lỗi HTTP ${status || 'không xác định'}.`, 'http_error');
}

async function fetchJson(fetchImpl, url, options, { endpoint, maxRetries, sleep, retryDelayMs, timeoutMs }) {
  const response = await requestWithRetry(async () => {
    const signal = requestSignal(timeoutMs);
    try { return await fetchImpl(url, { ...options, ...(signal.signal ? { signal: signal.signal } : {}) }); }
    finally { signal.cleanup?.(); }
  }, { maxRetries, sleep, retryDelayMs });
  const payload = await readJson(response);
  if (!responseOk(response)) throw classifyHttpError(responseStatus(response), endpoint);
  return payload;
}

async function accessToken(config, options) {
  const payload = await fetchJson(options.fetchImpl, TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token'
    })
  }, { ...options, endpoint: 'OAuth Google Ads' });
  if (!payload?.access_token || typeof payload.access_token !== 'string') throw new SourceError('OAuth Google Ads không trả về access token hợp lệ.', 'auth_required');
  return payload.access_token;
}

const DATE_FILTER = ' WHERE segments.date BETWEEN @from AND @to';
export const GOOGLE_ADS_QUERY = `SELECT segments.date, metrics.impressions, metrics.clicks FROM campaign${DATE_FILTER}`;
export const GOOGLE_ADS_BREAKDOWN_QUERIES = Object.freeze({
  keywords: `SELECT segments.date, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.impressions, metrics.clicks FROM keyword_view${DATE_FILTER}`,
  genders: `SELECT segments.date, ad_group_criterion.gender.type, metrics.impressions, metrics.clicks FROM gender_view${DATE_FILTER}`,
  ages: `SELECT segments.date, ad_group_criterion.age_range.type, metrics.impressions, metrics.clicks FROM age_range_view${DATE_FILTER}`
});

export function flattenGoogleAdsRows(payload) {
  const chunks = Array.isArray(payload) ? payload : [payload];
  return chunks.flatMap(chunk => Array.isArray(chunk?.results) ? chunk.results : []);
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function numeric(value) {
  if (value == null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function sumKnown(rows, key) {
  if (!rows.length || rows.some(row => row[key] == null)) return null;
  return rows.reduce((sum, row) => sum + row[key], 0);
}

export function aggregateGoogleAdsRows(rows, { from, to } = {}) {
  const filtered = (rows || []).map(row => ({
    date: row?.segments?.date,
    impressions: numeric(row?.metrics?.impressions),
    clicks: numeric(row?.metrics?.clicks)
  })).filter(row => validDate(row.date) && (!from || row.date >= from) && (!to || row.date <= to));
  const grouped = new Map();
  for (const row of filtered) {
    if (!grouped.has(row.date)) grouped.set(row.date, []);
    grouped.get(row.date).push(row);
  }
  const daily = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, dayRows]) => {
    const impressions = sumKnown(dayRows, 'impressions');
    const clicks = sumKnown(dayRows, 'clicks');
    return { date, impressions, clicks, ctr: impressions ? clicks == null ? null : clicks / impressions * 100 : null };
  });
  const impressions = sumKnown(daily, 'impressions');
  const clicks = sumKnown(daily, 'clicks');
  return {
    total: { impressions, clicks, ctr: impressions ? clicks == null ? null : clicks / impressions * 100 : null },
    daily,
    details: []
  };
}

const dimensionSpec = Object.freeze({
  keywords: { fields: ['keyword', 'matchType'], read: row => [row?.adGroupCriterion?.keyword?.text ?? null, row?.adGroupCriterion?.keyword?.matchType ?? null] },
  genders: { fields: ['gender'], read: row => [row?.adGroupCriterion?.gender?.type ?? null] },
  ages: { fields: ['ageRange'], read: row => [row?.adGroupCriterion?.ageRange?.type ?? null] }
});

function compareText(left, right) {
  const a = left == null ? '' : String(left);
  const b = right == null ? '' : String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function dimensionMetric(impressions, clicks) {
  return { impressions, clicks, ctr: impressions ? clicks == null ? null : clicks / impressions * 100 : null };
}

export function aggregateGoogleAdsDimensionRows(rows, dimension, { from, to } = {}) {
  const spec = dimensionSpec[dimension];
  if (!spec) throw new Error(`Unknown Google Ads dimension: ${dimension}`);
  const grouped = new Map();
  for (const row of rows || []) {
    const date = row?.segments?.date;
    if (!validDate(date) || from && date < from || to && date > to) continue;
    const values = spec.read(row);
    const key = JSON.stringify(values);
    if (!grouped.has(key)) grouped.set(key, { values, rows: [] });
    grouped.get(key).rows.push({
      impressions: numeric(row?.metrics?.impressions),
      clicks: numeric(row?.metrics?.clicks)
    });
  }
  return [...grouped.values()]
    .sort((left, right) => left.values.reduce((result, value, index) => result || compareText(value, right.values[index]), 0))
    .map(group => {
      const impressions = sumKnown(group.rows, 'impressions');
      const clicks = sumKnown(group.rows, 'clicks');
      return Object.fromEntries([
        ...group.values.map((value, index) => [spec.fields[index], value]),
        ...Object.entries(dimensionMetric(impressions, clicks))
      ]);
    });
}

export async function collectGoogleAds(link, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  maxRetries = 2,
  retryDelayMs = 250,
  sleep = wait,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(),
  update = async () => {},
  job = {}
} = {}) {
  if (typeof fetchImpl !== 'function') throw new SourceError('Máy chủ không hỗ trợ fetch cho Google Ads.', 'config_error');
  const config = googleAdsConfig(env);
  const bounds = googleAdsMonthBounds(link.reportMonth || link.from?.slice(0, 7));
  job.status = 'running';
  job.message = 'Đang lấy dữ liệu Google Ads';
  await update();
  const token = await accessToken(config, { fetchImpl, maxRetries, sleep, retryDelayMs, timeoutMs });
  const endpoint = `${ADS_ENDPOINT}/${encodeURIComponent(config.customerId)}/googleAds:searchStream`;
  const headers = {
    authorization: `Bearer ${token}`,
    'login-customer-id': config.loginCustomerId,
    'content-type': 'application/json',
    ...(config.developerToken ? { 'developer-token': config.developerToken } : {})
  };
  const queryForBounds = query => query.replace('@from', `'${bounds.from}'`).replace('@to', `'${bounds.to}'`);
  const readQuery = async query => flattenGoogleAdsRows(await fetchJson(fetchImpl, endpoint, {
    method: 'POST', headers, body: JSON.stringify({ query: queryForBounds(query) })
  }, { endpoint: 'Google Ads SearchStream', maxRetries, sleep, retryDelayMs, timeoutMs }));
  const campaignRows = await readQuery(GOOGLE_ADS_QUERY);
  const breakdownRows = Object.fromEntries(await Promise.all(Object.entries(GOOGLE_ADS_BREAKDOWN_QUERIES).map(async ([dimension, query]) => [dimension, await readQuery(query)])));
  const aggregate = aggregateGoogleAdsRows(campaignRows, bounds);
  const empty = aggregate.daily.length === 0;
  return {
    ...aggregate,
    keywords: aggregateGoogleAdsDimensionRows(breakdownRows.keywords, 'keywords', bounds),
    genders: aggregateGoogleAdsDimensionRows(breakdownRows.genders, 'genders', bounds),
    ages: aggregateGoogleAdsDimensionRows(breakdownRows.ages, 'ages', bounds),
    reconciliation: { dailyTotal: aggregate.total, differences: { impressions: null, clicks: null }, status: 'matched' },
    complete: true,
    fetchedAt: now().toISOString(),
    from: bounds.from,
    to: bounds.to,
    timezone: 'Asia/Ho_Chi_Minh',
    method: 'Google Ads API v25 SearchStream theo ngày',
    verification: 'live',
    warnings: empty ? ['Google Ads không có dòng dữ liệu trong tháng này; số liệu được giữ là chưa xác định, không đổi thành 0.'] : [],
    viewerDefinition: 'Google Ads metrics tổng theo ngày và breakdown theo từ khóa, giới tính, độ tuổi; không hiển thị chi tiết campaign.'
  };
}

export { GOOGLE_CONNECTOR };
