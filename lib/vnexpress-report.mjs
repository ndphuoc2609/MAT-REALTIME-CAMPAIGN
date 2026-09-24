import { createHmac } from 'node:crypto';
import { reconcile } from './links.mjs';
import { SourceError } from './source-error.mjs';

export const VNEXPRESS_CONNECTOR = 'fpt';
export const VNEXPRESS_REPORT_ENDPOINT = 'https://news.fptonline.net/api/get-report';
const DEFAULT_TIMEOUT_MS = 30_000;
const QUOTA_METADATA_KEY = 'source-vnexpress-request-timestamps';
const QUOTA_LIMIT = 100;
const QUOTA_WINDOW_MS = 60 * 60 * 1000;

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function required(env, key) {
  const value = String(env?.[key] ?? '').trim();
  if (!value) throw new SourceError(`Thiếu cấu hình ${key} cho báo cáo VnExpress.`, 'config_error');
  return value;
}

export function vnexpressReportConfig(env = process.env) {
  return {
    userName: required(env, 'SOURCE_VNEXPRESS_USER_NAME'),
    apiSecretKey: required(env, 'SOURCE_VNEXPRESS_API_SECRET_KEY')
  };
}

function metric(value, field) {
  if (value == null || value === '') throw new SourceError(`VnExpress trả về dòng thiếu ${field}.`, 'schema_error');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new SourceError(`VnExpress trả về ${field} không hợp lệ.`, 'schema_error');
  return number;
}

function sum(rows, field) {
  return rows.length && rows.every(row => row[field] != null) ? rows.reduce((total, row) => total + row[field], 0) : null;
}

export function vnexpressSignature(fields, secret) {
  const message = Object.keys(fields).filter(key => key !== 'signature').sort().map(key => String(fields[key])).join('|');
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function classifyCode(code) {
  switch (Number(code)) {
    case 400: return new SourceError('VnExpress từ chối dữ liệu yêu cầu (mã 400). Kiểm tra tên người dùng và khoảng ngày.', 'validation_error');
    case 401: return new SourceError('VnExpress yêu cầu xác thực API hợp lệ (mã 401). Kiểm tra cấu hình máy chủ.', 'auth_required');
    case 402: return new SourceError('VnExpress từ chối yêu cầu theo trạng thái tài khoản hoặc thanh toán (mã 402).', 'provider_payment_required');
    case 403: return new SourceError('Tài khoản API VnExpress không có quyền đọc báo cáo này (mã 403).', 'access_denied');
    case 429: return new SourceError('VnExpress đã giới hạn tần suất yêu cầu (mã 429). Hãy chờ trước lần đồng bộ tiếp theo.', 'rate_limited');
    case 500: return new SourceError('VnExpress gặp lỗi máy chủ (mã 500).', 'provider_error');
    default: return new SourceError(`VnExpress từ chối yêu cầu (mã ${Number.isFinite(Number(code)) ? Number(code) : 'không xác định'}).`, 'provider_error');
  }
}

function safeKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value).slice(0, 100).map(key => /(?:password|token|secret|signature|authorization|credential|user[_-]?name|api[_-]?key)/i.test(key) ? '[redacted-key]' : key);
}

function fieldType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function logInvalidResponse({ response, contentType, payload = null, parsed = false, validationReason = null, requestedDateRange = null }) {
  const isObject = parsed && payload !== null && typeof payload === 'object' && !Array.isArray(payload);
  const fields = ['error', 'code', 'msg', 'total', 'data', 'arrData'];
  const requiredFields = parsed
    ? Object.fromEntries(fields.map(key => [key, { present: isObject && Object.hasOwn(payload, key), type: isObject && Object.hasOwn(payload, key) ? fieldType(payload[key]) : 'missing' }]))
    : Object.fromEntries(fields.map(key => [key, { present: null, type: 'unavailable' }]));
  const dataRows = isObject && Array.isArray(payload.data) ? payload.data : null;
  const arrDataRows = isObject && Array.isArray(payload.arrData) ? payload.arrData : null;
  const rowsField = dataRows ? 'data' : arrDataRows ? 'arrData' : null;
  const rows = rowsField === 'data' ? dataRows : rowsField === 'arrData' ? arrDataRows : null;
  const firstRow = rows?.[0];
  const contractFields = ['banner_name', 'order_id', 'from_date', 'to_date', 'clicks', 'impression', 'ctr'];
  const firstRowContractFields = firstRow && typeof firstRow === 'object' && !Array.isArray(firstRow)
    ? Object.fromEntries(contractFields.map(key => [key, {
      present: Object.hasOwn(firstRow, key),
      type: Object.hasOwn(firstRow, key) ? fieldType(firstRow[key]) : 'missing'
    }]))
    : null;
  const firstRowDateRange = firstRow && typeof firstRow === 'object' && !Array.isArray(firstRow)
    ? Object.fromEntries(['from_date', 'to_date'].map(key => [key, typeof firstRow[key] === 'string' ? firstRow[key].slice(0, 32) : null]))
    : null;
  console.error('[VnExpress] Invalid report response', {
    httpStatus: response.status,
    contentType,
    parsed,
    topLevelType: parsed ? fieldType(payload) : 'unavailable',
    topLevelKeys: safeKeys(payload),
    requiredFields,
    acceptedRowsFields: ['data', 'arrData'],
    rowsField,
    rowsIsArray: rows !== null,
    rowsLength: rows?.length ?? null,
    firstRowKeys: safeKeys(rows?.[0]),
    firstRowContractFields,
    requestedDateRange,
    firstRowDateRange,
    validationReason,
    dataIsArray: dataRows !== null,
    dataLength: dataRows?.length ?? null,
    firstDataRowKeys: safeKeys(dataRows?.[0]),
    arrDataIsArray: arrDataRows !== null,
    arrDataLength: arrDataRows?.length ?? null,
    firstArrDataRowKeys: safeKeys(arrDataRows?.[0])
  });
}

async function consumeRequestQuota(store, nowMs) {
  if (!store || typeof store.getMetadata !== 'function' || typeof store.setMetadata !== 'function') {
    throw new SourceError('Không thể kiểm tra giới hạn yêu cầu VnExpress đã lưu; chưa gửi request.', 'config_error');
  }
  let recorded;
  try {
    const value = await store.getMetadata(QUOTA_METADATA_KEY);
    recorded = value == null ? [] : JSON.parse(value);
  } catch {
    throw new SourceError('Không thể đọc bộ đếm giới hạn yêu cầu VnExpress; chưa gửi request.', 'config_error');
  }
  if (!Array.isArray(recorded) || recorded.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new SourceError('Bộ đếm giới hạn yêu cầu VnExpress sai cấu trúc; chưa gửi request.', 'config_error');
  }
  const recent = recorded.filter(timestamp => timestamp > nowMs - QUOTA_WINDOW_MS);
  if (recent.length >= QUOTA_LIMIT) {
    const retryAt = Math.min(...recent) + QUOTA_WINDOW_MS;
    const waitMinutes = Math.max(1, Math.ceil((retryAt - nowMs) / 60_000));
    throw new SourceError(`Đã dùng đủ 100 yêu cầu VnExpress trong 60 phút gần nhất. Thử lại sau khoảng ${waitMinutes} phút (từ ${new Date(retryAt).toISOString()}).`, 'rate_limited');
  }
  recent.push(nowMs);
  try { await store.setMetadata(QUOTA_METADATA_KEY, JSON.stringify(recent)); }
  catch { throw new SourceError('Không thể lưu bộ đếm giới hạn yêu cầu VnExpress; chưa gửi request.', 'config_error'); }
}

function normalizePayload(payload, link) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'error') || !Object.hasOwn(payload, 'code') || !Object.hasOwn(payload, 'msg') || !Object.hasOwn(payload, 'total') || (!Array.isArray(payload.data) && !Array.isArray(payload.arrData))) {
    throw new SourceError('VnExpress trả về JSON sai cấu trúc; cần error, code, msg, total và data hoặc arrData dạng mảng.', 'schema_error');
  }
  const rows = Array.isArray(payload.data) ? payload.data : payload.arrData;
  const errorFlag = payload.error;
  const hasError = !(errorFlag === false || errorFlag === 0 || typeof errorFlag === 'string' && errorFlag.trim() === '0');
  if (hasError) throw classifyCode(payload.code);
  if (Number(payload.code) !== 200 && Number(payload.code) !== 0) throw classifyCode(payload.code);
  if (payload.total == null || !Number.isFinite(Number(payload.total)) || Number(payload.total) < 0) throw new SourceError('VnExpress trả về total không hợp lệ.', 'schema_error');
  const details = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SourceError(`VnExpress trả về dòng ${index + 1} sai cấu trúc.`, 'schema_error');
    for (const field of ['banner_name', 'order_id', 'from_date', 'to_date']) {
      if (!Object.hasOwn(row, field) || row[field] == null || String(row[field]).trim() === '') throw new SourceError(`VnExpress trả về dòng thiếu ${field}.`, 'schema_error');
    }
    const fromDate = String(row.from_date), toDate = String(row.to_date);
    if (!validDate(fromDate)) throw new SourceError('VnExpress trả về from_date không hợp lệ.', 'schema_error');
    if (!validDate(toDate)) throw new SourceError('VnExpress trả về to_date không hợp lệ.', 'schema_error');
    if (fromDate > toDate) throw new SourceError('VnExpress trả về from_date sau to_date.', 'schema_error');
    if (fromDate < link.from || fromDate > link.to || toDate < link.from || toDate > link.to) {
      throw new SourceError('VnExpress trả về khoảng ngày nằm ngoài khoảng báo cáo được yêu cầu.', 'schema_error');
    }
    const impressions = metric(row.impression, 'impression');
    const clicks = metric(row.clicks, 'clicks');
    metric(row.ctr, 'ctr');
    return { bannerName: String(row.banner_name), orderId: String(row.order_id), from: fromDate, to: toDate, impressions, clicks, ctr: impressions > 0 ? clicks / impressions * 100 : null };
  });
  const impressions = sum(details, 'impressions');
  const clicks = sum(details, 'clicks');
  const total = { impressions, clicks, ctr: impressions > 0 && clicks != null ? clicks / impressions * 100 : null };
  const hasDailyDetails = rows.some(row => Object.hasOwn(row, 'detail'));
  if (hasDailyDetails && rows.some(row => !Array.isArray(row.detail))) throw new SourceError('VnExpress trả về detail không phải mảng.', 'schema_error');
  const dailyDetails = hasDailyDetails ? rows.flatMap((row, index) => row.detail.map((dailyRow, dailyIndex) => {
    if (!dailyRow || typeof dailyRow !== 'object' || Array.isArray(dailyRow)) throw new SourceError(`VnExpress trả về detail dòng ${dailyIndex + 1} của banner/order ${index + 1} sai cấu trúc.`, 'schema_error');
    if (!validDate(dailyRow.Date) || dailyRow.Date < link.from || dailyRow.Date > link.to) throw new SourceError('VnExpress trả về ngày detail không hợp lệ hoặc nằm ngoài khoảng báo cáo được yêu cầu.', 'schema_error');
    if (dailyRow.Date < String(row.from_date) || dailyRow.Date > String(row.to_date)) throw new SourceError('VnExpress trả về ngày detail nằm ngoài khoảng banner/order.', 'schema_error');
    const impressions = metric(dailyRow.Impression, 'detail.Impression');
    const clicks = metric(dailyRow.Click, 'detail.Click');
    metric(dailyRow.CTR, 'detail.CTR');
    return {
      date: dailyRow.Date, impressions, clicks,
      ctr: impressions > 0 ? clicks / impressions * 100 : null,
      bannerName: String(row.banner_name), orderId: String(row.order_id),
      from: String(row.from_date), to: String(row.to_date)
    };
  })) : [];
  const dailyMap = new Map();
  for (const row of dailyDetails) {
    const day = dailyMap.get(row.date) || { impressions: 0, clicks: 0 };
    day.impressions += row.impressions;
    day.clicks += row.clicks;
    dailyMap.set(row.date, day);
  }
  const daily = [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, metrics]) => ({
    date, ...metrics, ctr: metrics.impressions > 0 ? metrics.clicks / metrics.impressions * 100 : null
  }));
  const reconciliation = hasDailyDetails && daily.length
    ? reconcile(total, daily)
    : { dailyTotal: { impressions: null, clicks: null, ctr: null }, differences: { impressions: null, clicks: null }, status: 'not_available' };
  const warnings = hasDailyDetails && daily.length
    ? reconciliation.status === 'matched' ? [] : ['Tổng số liệu theo ngày chưa khớp tổng kỳ; snapshot trước được giữ lại.']
    : ['API VnExpress chưa trả về dữ liệu theo ngày; chỉ lưu tổng kỳ.'];
  return {
    total, details, daily, dailyDetails,
    reconciliation,
    complete: reconciliation.status === 'matched' || reconciliation.status === 'not_available', fetchedAt: new Date().toISOString(), from: link.from, to: link.to, timezone: null,
    method: 'VnExpress report API · một yêu cầu theo khoảng ngày', verification: 'live',
    warnings,
    viewerDefinition: 'Tổng impressions/clicks là tổng các dòng banner/order trả về; CTR tính theo tổng clicks / impressions.'
  };
}

export async function collectVnExpressReport(link, {
  env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date(), job = {}, update = async () => {}, quotaStore
} = {}) {
  if (typeof fetchImpl !== 'function') throw new SourceError('Máy chủ không hỗ trợ fetch cho báo cáo VnExpress.', 'config_error');
  let config;
  try { config = vnexpressReportConfig(env); }
  catch (error) { if (error instanceof SourceError) throw error; throw new SourceError(error.message, 'config_error'); }
  if (!validDate(link.from) || !validDate(link.to) || link.from > link.to) throw new SourceError('Khoảng ngày VnExpress không hợp lệ.', 'config_error');
  const timestamp = Math.floor(now().getTime() / 1000);
  const fields = { user_name: config.userName, from_date: link.from, to_date: link.to, timestamp };
  const body = { ...fields, signature: vnexpressSignature(fields, config.apiSecretKey) };
  job.status = 'running'; job.message = 'Đang lấy báo cáo VnExpress'; await update();
  await consumeRequestQuota(quotaStore, now().getTime());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  let response, text, contentType;
  try {
    response = await fetchImpl(VNEXPRESS_REPORT_ENDPOINT, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: controller.signal, redirect: 'manual'
    });
    contentType = response.headers?.get?.('content-type') || '';
    text = await response.text();
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(error?.name === 'AbortError' ? 'Yêu cầu VnExpress đã hết thời gian chờ.' : 'Không thể kết nối VnExpress.', 'network_error');
  } finally { clearTimeout(timer); }
  if (response.status >= 300 && response.status < 400) throw new SourceError(`VnExpress chuyển hướng request (HTTP ${response.status}); đã dừng để bảo vệ thông tin API.`, 'transport_security');
  if (response.status === 429) throw classifyCode(429);
  if (response.status === 401) throw classifyCode(401);
  if (response.status === 403) throw classifyCode(403);
  if (response.status === 400) throw classifyCode(400);
  if (response.status === 402) throw classifyCode(402);
  if (response.status >= 500) throw classifyCode(500);
  if (!response.ok) throw new SourceError(`VnExpress trả về lỗi HTTP ${response.status}.`, 'http_error');
  let payload;
  try { payload = JSON.parse(text); }
  catch {
    logInvalidResponse({ response, contentType, parsed: false, requestedDateRange: { from: link.from, to: link.to } });
    throw new SourceError('VnExpress trả về phản hồi không phải JSON hợp lệ.', 'schema_error');
  }
  let result;
  try { result = normalizePayload(payload, link); }
  catch (error) {
    if (error instanceof SourceError && error.status === 'schema_error') logInvalidResponse({
      response, contentType, payload, parsed: true, validationReason: error.message,
      requestedDateRange: { from: link.from, to: link.to }
    });
    throw error;
  }
  result.fetchedAt = now().toISOString();
  return result;
}
