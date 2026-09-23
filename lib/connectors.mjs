import { chromium } from 'playwright';
import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir as makeDirectory, rm as removeDirectory } from 'node:fs/promises';
import { days,reconcile } from './links.mjs';
import { source24hAutoLoginEnabled, source24hConfig, source24hAllowInsecureHttp, sourceAdmicroAutoLoginEnabled, sourceAdmicroConfig } from './config.mjs';
import { authCircuit, promoteVerifiedProfile, recoverProfilePromotion, resetAuthCircuit, tripAuthCircuit, withProfileLock } from './source-session.mjs';
import { collectGoogleAds } from './google-ads.mjs';
import { collectMetaAds, META_CONNECTOR } from './meta-ads.mjs';
import { SourceError } from './source-error.mjs';
import { browserLaunchOptions, BrowserRuntimeError } from './browser-runtime.mjs';

export { SourceError };
function configured24hAutoLogin() {
  try { return source24hAutoLoginEnabled(); }
  catch (error) { throw new SourceError(error.message, 'config_error'); }
}
function configured24hAllowInsecureHttp() {
  try { return source24hAllowInsecureHttp(); }
  catch (error) { throw new SourceError(error.message, 'config_error'); }
}
function configuredAdmicroAutoLogin() {
  try { return sourceAdmicroAutoLoginEnabled(); }
  catch (error) { throw new SourceError(error.message, 'config_error'); }
}
function sourceAutoLoginEnabled(connector) {
  return connector === '24h' ? configured24hAutoLogin() : connector === 'admicro-pc' || connector === 'admicro-mobile' ? configuredAdmicroAutoLogin() : false;
}
export const sourceProfileDirectory=(directory,connector)=>join(directory,'sessions',connector==='admicro-pc'||connector==='admicro-mobile'?'admicro':connector);
const transientCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','ENOTFOUND']);
const AUTH_CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000;
const TEMPORARY_24H_AUTH_REASONS = new Set(['login_in_progress', 'authentication_pending', 'authentication_failed']);
export function isTransientNetworkError(error){
  if(!error||error instanceof SourceError||error.status!=null)return false;
  if(transientCodes.has(error.code))return true;
  if(error.name==='TimeoutError')return true;
  return /(?:net::ERR_(?:CONNECTION_(?:RESET|CLOSED|REFUSED)|TIMED_OUT|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)|\b(?:timed? ?out|timeout)\b)/i.test(String(error.message||''));
}
function temporary24hCircuit(circuit, now = Date.now()) {
  if (!circuit?.open || !TEMPORARY_24H_AUTH_REASONS.has(circuit.reason)) return null;
  if (typeof circuit.at !== 'string') return { valid: false };
  const timestamp = Date.parse(circuit.at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== circuit.at) return { valid: false };
  const remainingMs = AUTH_CIRCUIT_COOLDOWN_MS - (now - timestamp);
  return { valid: true, fresh: remainingMs > 0, remainingMs: Math.max(0, remainingMs) };
}
function blocked24hCircuitError(circuit, temporary) {
  if (temporary?.fresh) {
    const minutes = Math.max(1, Math.ceil(temporary.remainingMs / 60_000));
    return new SourceError(`Tự đăng nhập 24h đang tạm dừng sau lỗi xác thực; thử lại sau khoảng ${minutes} phút hoặc dùng phiên thủ công.`, 'auth_blocked');
  }
  if (circuit?.reason === 'invalid_credentials') {
    return new SourceError('Tự đăng nhập 24h đang bị khóa sau khi credentials bị từ chối. Sửa credentials rồi reset mạch xác thực.', 'auth_blocked');
  }
  if (circuit?.reason === 'interactive_auth_required') {
    return new SourceError('Tự đăng nhập 24h đang bị khóa vì nguồn yêu cầu OTP, CAPTCHA hoặc xác nhận thiết bị. Hoàn tất xác thực rồi reset mạch xác thực.', 'auth_blocked');
  }
  return new SourceError('Tự đăng nhập 24h đang bị khóa bởi trạng thái xác thực không an toàn; kiểm tra mạch xác thực và reset thủ công nếu phù hợp.', 'auth_blocked');
}
const openContexts = new Set();
export async function closeBrowserContexts() {
  await Promise.allSettled([...openContexts].map(context => context.close()));
  openContexts.clear();
}
const count=s=>{if(s==null)return null;const value=String(s).trim();if(!value||/^(?:N\/A|—|-)$/i.test(value))return null;const normalized=value.replace(/,/g,'').replace(/\s/g,'');if(!/^-?\d+(?:\.\d+)?$/.test(normalized))return null;const n=Number(normalized);return Number.isFinite(n)?n:null;};
const countText=s=>{if(s==null)return null;const value=String(s).trim();if(!value||/^(?:N\/A|—|-)$/i.test(value))return null;const match=value.replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);if(!match)return null;const n=Number(match[0]);return Number.isFinite(n)?n:null;};
const keyOf=(row,tests)=>Object.keys(row).find(k=>tests.some(t=>k.toLowerCase().includes(t)));
function valueOf(row,tests){const k=keyOf(row,tests);return k?row[k]:null;}
function findRows(node){if(Array.isArray(node))return node.filter(x=>x&&typeof x==='object'&&!Array.isArray(x));if(node&&typeof node==='object'){for(const key of ['data','rows','items','results','aaData','records']){const rows=findRows(node[key]);if(rows.length)return rows;}for(const value of Object.values(node)){const rows=findRows(value);if(rows.length)return rows;}}return [];} 
const exact=(row,keys)=>{for(const key of keys)if(Object.prototype.hasOwnProperty.call(row,key))return row[key];return null;};
const is24ReportRow = row => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const keys = Object.keys(row).map(key => key.toLowerCase());
  return keys.some(key => ['c_date', 'date', 'day', 'pk_dfp_lineitem', 'lineitem_id', 'c_impressions', 'c_sum_impressions', 'impressions', 'c_clicks', 'c_sum_clicks', 'clicks', 'c_spend', 'c_sum_spend', 'spend'].includes(key));
};
const normalize24Date=value=>{const s=String(value??'').trim();const m=s.match(/^(\d{2})-(\d{2})-(\d{4})/);return m?`${m[3]}-${m[2]}-${m[1]}`:/^\d{4}-\d{2}-\d{2}/.test(s)?s.slice(0,10):s||null;};
function metric24(row,{daily=false}={}){
  // 24h returns both lifetime/period fields (c_impressions/c_clicks) and
  // selected-day fields (c_sum_impressions/c_sum_clicks). The latter must
  // be used whenever c_date is present; using c_impressions repeats the
  // period total once for every day.
  const impressions=count(String(exact(row,daily?['c_sum_impressions','sum_impressions']:['c_impressions','impressions'])??valueOf(row,['impression','display','view','hiển thị','hienthi'])??''));
  const clicks=count(String(exact(row,daily?['c_sum_clicks','sum_clicks']:['c_clicks','clicks'])??valueOf(row,['click','clicks'])??''));
  const spend=count(String(exact(row,daily?['c_sum_spend','sum_spend','c_spend']:['c_spend','spend','cost','amount','money','tiền'])??''));
  const engagement=count(String(valueOf(row,['engagement','tương tác','tuong tac'])??''));
  const viewers=count(String(valueOf(row,['unique','viewer','người xem','nguoi xem'])??''));
  return {impressions,clicks,spend,engagement,viewers,ctr:impressions&&clicks!=null?clicks/impressions*100:null};
}
function merge24(rows){
  const merge=items=>{const out={};for(const k of ['impressions','clicks','spend','engagement','viewers']){const values=items.map(x=>x[k]);out[k]=values.length&&values.every(v=>v!=null)?values.reduce((a,v)=>a+v,0):null;}out.ctr=out.impressions&&out.clicks!=null?out.clicks/out.impressions*100:null;return out;};
  const dated=rows.filter(x=>x.date);
  const byDate=new Map();for(const row of dated){if(!byDate.has(row.date))byDate.set(row.date,[]);byDate.get(row.date).push(row.metric);}
  const daily=[...byDate.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,items])=>({date,...merge(items)}));
  const detailMap=new Map();for(const row of (dated.length?dated:rows)){const key=JSON.stringify([row.id,row.creative,row.position]);if(!detailMap.has(key))detailMap.set(key,[]);detailMap.get(key).push(row);}
  const details=[...detailMap.values()].map(items=>{const first=items[0];return {...merge(items.map(x=>x.metric)),creativeId:first.id,creative:first.creative,position:first.position,extra:first.raw};});
  const dailyDetails=dated.map(row=>({...row.metric,date:row.date,creativeId:row.id,creative:row.creative,position:row.position,extra:row.raw}));
  return {total:daily.length?merge(daily):merge(rows.map(x=>x.metric)),details,daily,dailyDetails};
}
function parse24Payload(payload){const rows=findRows(payload);if(!rows.length)throw new SourceError('Response 24h không có danh sách dữ liệu.','schema_error');const normalized=rows.map((row,i)=>{const date=normalize24Date(exact(row,['c_date','date','ngày','ngay','day']));const id=exact(row,['pk_dfp_lineitem','lineitem_id','lineitem','line_item','id'])??String(i+1);const creative=exact(row,['c_name','name','campaign','creative','lineitem','line_item'])??null;const position=exact(row,['c_website','position','site','placement','ad_unit','vị trí','vi tri'])??null;return {raw:row,metric:metric24(row,{daily:Boolean(date)}),date,id,creative,position};});return merge24(normalized);}
export function normalize24Payload(payload){ return parse24Payload(payload); }
export function classify24Response({status = 200, redirectedToLogin = false, passwordForm = false, contentType = '', html = false, invalidJson = false, accessDenied = false, transportSecurity = false} = {}) {
  if (transportSecurity) return {
    status: 'transport_security', message: 'Nguồn 24h chuyển hướng từ HTTPS xuống HTTP; đã dừng trước khi gửi thông tin xác thực.'
  };
  if (accessDenied) return {
    status: 'access_denied', message: 'Tài khoản 24h không có quyền đọc báo cáo này.'
  };
  if (status === 401 || redirectedToLogin || passwordForm) return {
    status: 'auth_required', message: 'Phiên đăng nhập 24h không còn hợp lệ. Cập nhật phiên nguồn rồi chạy lại.'
  };
  if (status === 403) return {
    status: 'access_denied', message: '24h từ chối quyền truy cập (HTTP 403). Kiểm tra tài khoản, quyền xem báo cáo và đường dẫn nguồn.'
  };
  if (status < 200 || status >= 300) return {
    status: 'http_error', message: `Endpoint báo cáo 24h trả về HTTP ${status}. Kiểm tra quyền truy cập và thử lại sau.`
  };
  if (/text\/html/i.test(contentType) || html || invalidJson) return {
    status: 'schema_error', message: '24h trả về HTML hoặc JSON không đúng định dạng báo cáo. Kiểm tra trang đăng nhập và cấu trúc báo cáo nguồn.'
  };
  return null;
}
const isAmbiguous24hAccessDenied = (failure, response = failure) => failure?.status === 'access_denied' && response?.status === 200 && response?.accessDenied && (response?.html || /text\/html/i.test(response?.contentType || ''));
const query24h = (link, from, to) => ({
    ...link.query,
    c_statistic_from_date: from.split('-').reverse().join('-'),
    c_statistic_to_date: to.split('-').reverse().join('-'),
    c_view_statistic_by_date: '1',
    c_view_statistic_data_only: '1'
  });

export function endpoint24hPath(value) {
  let url;
  try { url = new URL(value); } catch { throw new SourceError('Link báo cáo 24h không hợp lệ.', 'needs_inspection'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'khachhang.24h.com.vn') {
    throw new SourceError('Endpoint báo cáo 24h không thuộc transport hoặc host đã xác minh.', 'transport_security');
  }
  const pathname = url.pathname || '/';
  // Older callers and fixtures may carry a generic report URL while the
  // provider's established default endpoint remains lineitem. Real /ocm
  // report paths are resolved below so order and lineitem links stay distinct.
  if (!pathname.startsWith('/ocm/')) return '/ocm/ajax/lineitem/index/';
  if (!/^\/ocm\/(?:ajax\/)?[^/]+\/index\/?$/.test(pathname)) {
    throw new SourceError('Không xác định được pathname endpoint báo cáo 24h từ link nguồn.', 'needs_inspection');
  }
  return pathname.startsWith('/ocm/ajax/') ? pathname : pathname.replace(/^\/ocm\//, '/ocm/ajax/');
}

async function probe24hReport(page, link, { allowInsecureHttp = false, accessDeniedAsAuth = false } = {}) {
  const endpointPath = endpoint24hPath(link.url);
  const result = await page.evaluate(async ({ query, allowInsecureHttp, endpointPath }) => {
    const endpoint = new URL(endpointPath, location.origin).href;
    const url = new URL(endpoint);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url.href, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ params: [], take: 1, skip: 0, page: 1, pageSize: 1, group: [] }), credentials: 'include'
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    const finalUrl = new URL(response.url);
    const redirectedToLogin = response.redirected && /\/(?:login|signin|authenticate)(?:\/|$)/i.test(finalUrl.pathname);
    const passwordForm = /<input\b[^>]*type\s*=\s*["']password["']/i.test(text) && /(?:đăng nhập|log\s*in|password|mật khẩu)/i.test(text);
    const html = /^\s*(?:<!doctype\s+html|<html)/i.test(text);
    const accessDenied = /bạn\s+không\s+có\s+quyền\s+thực\s+hiện\s+chức\s+năng\s+này|không\s+có\s+quyền/i.test(text);
    const transportSecurity = !allowInsecureHttp && finalUrl.protocol !== 'https:';
    if (!response.ok || redirectedToLogin || passwordForm || html || accessDenied || transportSecurity) return { failure: { status: response.status, contentType, redirectedToLogin, passwordForm, html, accessDenied, transportSecurity } };
    try { return { payload: JSON.parse(text) }; } catch { return { failure: { status: response.status, contentType, invalidJson: true } }; }
  }, { query: query24h(link, link.from, link.to), allowInsecureHttp, endpointPath });
  if (result.failure) {
    const failure = classify24Response(result.failure);
    if (failure?.status === 'access_denied' && accessDeniedAsAuth) {
      throw new SourceError('Phiên đăng nhập 24h không còn hợp lệ. Cập nhật phiên nguồn rồi chạy lại.', 'auth_required');
    }
    if (failure) {
      const error = new SourceError(failure.message, failure.status);
      // The provider's unauthenticated endpoint can return HTTP 200 with an
      // HTML permission alert. Keep this marker internal so the coordinator
      // can distinguish that ambiguous session response from genuine HTTP
      // access denial without changing the public status contract.
      if (isAmbiguous24hAccessDenied(failure, result.failure)) {
        error.ambiguousSession = true;
      }
      throw error;
    }
  }
  if (!findRows(result.payload).some(is24ReportRow)) throw new SourceError('24h không trả về dữ liệu report hợp lệ để xác minh quyền.', 'schema_error');
  return true;
}

async function read24h(page, link, from, to, { secureTransport = false } = {}) {
  const query = query24h(link, from, to);
  const endpointPath = endpoint24hPath(link.url);
  const result = await page.evaluate(async ({ query, secureTransport, endpointPath }) => {
    const endpoint = new URL(endpointPath, location.origin).href;
    const pages = [];
    let skip = 0, page = 1, totalCount = null;
    for (let i = 0; i < 200; i++) {
      const url = new URL(endpoint);
      Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
      const response = await fetch(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ params: [], take: 50, skip, page, pageSize: 50, group: [] }),
        credentials: 'include'
      });
      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();
      const finalUrl = new URL(response.url);
      const finalPath = finalUrl.pathname;
      const redirectedToLogin = response.redirected && /\/(?:login|signin|authenticate)(?:\/|$)/i.test(finalPath);
      const passwordForm = /<input\b[^>]*type\s*=\s*["']password["']/i.test(text) && /(?:đăng nhập|log\s*in|password|mật khẩu)/i.test(text);
      const html = /^\s*(?:<!doctype\s+html|<html)/i.test(text);
      const accessDenied = /bạn\s+không\s+có\s+quyền\s+thực\s+hiện\s+chức\s+năng\s+này|không\s+có\s+quyền/i.test(text);
      const transportSecurity = secureTransport && finalUrl.protocol !== 'https:';
      const failure = { status: response.status, contentType, redirectedToLogin, passwordForm, html, accessDenied, transportSecurity };
      if (!response.ok || redirectedToLogin || passwordForm || /text\/html/i.test(contentType) || html) return { failure };
      let payload;
      try { payload = JSON.parse(text); }
      catch { return { failure: { ...failure, invalidJson: true } }; }
      pages.push(payload);
      const rows = payload.data || payload.rows || payload.items || payload.results || payload.aaData || [];
      if (totalCount == null) {
        const find = value => {
          if (!value || typeof value !== 'object') return null;
          for (const key of ['recordsTotal', 'totalCount', 'total_rows', 'totalRows', 'count']) {
            if (Number.isFinite(Number(value[key]))) return Number(value[key]);
          }
          for (const child of Object.values(value)) {
            const found = find(child);
            if (found != null) return found;
          }
          return null;
        };
        totalCount = find(payload);
      }
      if (!Array.isArray(rows) || rows.length < 50 || totalCount != null && skip + rows.length >= totalCount) break;
      skip += rows.length;
      page++;
    }
    return { pages, totalCount };
  }, { query, secureTransport, endpointPath });

  if (result.failure) {
    const failure = classify24Response(result.failure);
    if (failure) {
      const error = new SourceError(failure.message, failure.status);
      if (isAmbiguous24hAccessDenied(failure, result.failure)) error.ambiguousSession = true;
      throw error;
    }
  }
  if (!result.pages?.length) throw new SourceError('24h không trả về dòng dữ liệu báo cáo. Kiểm tra quyền truy cập và cấu trúc nguồn.', 'schema_error');
  const parsed = result.pages.map(parse24Payload);
  const dailyDetails = parsed.flatMap(item => item.dailyDetails || []);
  const detailRows = parsed.flatMap(item => item.details || []);
  const asRows = items => items.map(item => ({
    ...item,
    metric: { impressions: item.impressions, clicks: item.clicks, spend: item.spend, engagement: item.engagement, viewers: item.viewers },
    raw: item.extra, id: item.creativeId, creative: item.creative, position: item.position
  }));
  const merged = merge24(dailyDetails.length
    ? asRows(dailyDetails)
    : detailRows.map(item => ({ ...item, metric: item, date: null, id: item.creativeId, creative: item.creative, position: item.position, raw: item.extra })));
  return { total: merged.total, details: merged.details, daily: merged.daily, dailyDetails: merged.dailyDetails };
}
const normalizedDate = value => {
  const s = String(value ?? '').trim();
  let match = s.match(/^(\d{2})[\\/-](\d{2})[\\/-](\d{4})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : (s || null);
};
const headerIndex = (headers, patterns) => {
  const lower = headers.map(value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim());
  const exact = lower.findIndex(value => patterns.some(pattern => value === pattern));
  return exact >= 0 ? exact : lower.findIndex(value => patterns.some(pattern => value.includes(pattern)));
};
const cellAt = (headers, row, patterns) => {
  const index = headerIndex(headers, patterns);
  return index < 0 ? null : row[index] ?? null;
};
function normalizedMetric(headers, row) {
  const impressions = count(cellAt(headers, row, ['lượt hiển thị', 'impressions', 'impression', 'view']));
  const clicks = count(cellAt(headers, row, ['click']));
  const spend = count(cellAt(headers, row, ['tiền', 'spend', 'cost', 'amount']));
  const viewers = count(cellAt(headers, row, ['người xem', 'viewers', 'unique viewer', 'unique']));
  const engagement = count(cellAt(headers, row, ['engagement', 'tương tác']));
  return { impressions, clicks, spend, engagement, viewers, ctr: impressions && clicks != null ? clicks / impressions * 100 : null };
}
const rawExtra = (headers, values) => Object.fromEntries(headers.map((header, index) => [header, values[index]]).filter(([header]) => header && !['Preview', ''].includes(header)));
export function normalizeTable(raw) {
  const headers = raw?.headers || [];
  const metric = row => normalizedMetric(headers, row || []);
  const result = metric(raw?.total || []);
  const details = (raw?.rows || []).map(row => {
    const values = row.values || [];
    const item = metric(values);
    return {
      ...item,
      creativeId: row.id || null,
      creative: cellAt(headers, values, ['quảng cáo', 'creative', 'ad']) || null,
      position: cellAt(headers, values, ['vùng miền', 'position', 'placement']) || null,
      status: cellAt(headers, values, ['trạng thái', 'status']) || null,
      bid: countText(cellAt(headers, values, ['bid'])),
      avgPrice: count(cellAt(headers, values, ['giá tb', 'average price', 'avg price'])),
      preview: cellAt(headers, values, ['preview']) || null,
      extra: rawExtra(headers, values)
    };
  });
  return { total: result, details };
}
export function normalizeAdmicroRaw(raw) {
  const overview = normalizeTable(raw.overview || raw);
  const tables = raw.summary?.tables || [];
  const summary = { tables: tables.map(table => ({ ...table, rows: table.rows || [] })) };
  const dailyTable = tables.find(table => {
    const headers = table.headers || [];
    return headerIndex(headers, ['ngày', 'date', 'day']) >= 0 && headerIndex(headers, ['click']) >= 0 && headerIndex(headers, ['lượt hiển thị', 'impressions']) >= 0;
  });
  const daily = dailyTable ? dailyTable.rows.filter(row => !/^tổng/i.test(String(row.values?.join(' ') || ''))).map(row => ({ date: normalizedDate(cellAt(dailyTable.headers, row.values, ['ngày', 'date', 'day'])), ...normalizedMetric(dailyTable.headers, row.values), extra: rawExtra(dailyTable.headers, row.values) })).filter(row => row.date) : [];
  const dailyTotal = dailyTable?.total ? normalizedMetric(dailyTable.headers, dailyTable.total) : null;
  if (dailyTotal && daily.length) {
    const source = dailyTotal;
    // The report footer is the authoritative period total; daily totals are
    // retained separately so rounding/partial pages do not alter it.
    if (source.impressions != null || source.clicks != null || source.spend != null) summary.dailyTotal = source;
    if (overview.total.impressions == null && source.impressions != null) overview.total = source;
  }
  const campaignTable = tables.find(table => headerIndex(table.headers || [], ['chiến dịch', 'campaign']) >= 0 && headerIndex(table.headers || [], ['hợp đồng', 'contract']) >= 0);
  const campaignRows = campaignTable ? campaignTable.rows.filter(row => !/^tổng/i.test(String(row.values?.join(' ') || ''))).map(row => ({
    ...normalizedMetric(campaignTable.headers, row.values),
    campaign: cellAt(campaignTable.headers, row.values, ['chiến dịch', 'campaign']) || null,
    status: cellAt(campaignTable.headers, row.values, ['trạng thái', 'status']) || null,
    contract: cellAt(campaignTable.headers, row.values, ['hợp đồng', 'contract']) || null,
    extra: rawExtra(campaignTable.headers, row.values)
  })) : [];
  summary.campaigns = campaignRows;
  summary.regions = tables.filter(table => table.title === 'region').flatMap(table => table.rows.map(row => ({ date: normalizedDate(cellAt(table.headers, row.values, ['ngày', 'date', 'day'])), ...Object.fromEntries(table.headers.map((header, index) => [header, row.values[index]])), extra: rawExtra(table.headers, row.values) })));
  summary.domains = tables.filter(table => table.title === 'domain').flatMap(table => table.rows.map(row => ({ domain: cellAt(table.headers, row.values, ['domain']) || null, ...normalizedMetric(table.headers, row.values), extra: rawExtra(table.headers, row.values) })));
  return { total: overview.total, details: overview.details, daily, dailyDetails: daily.map(row => ({ ...row })), overview: { ...overview, raw: raw.overview || null }, summary };
}
async function loginPage(page){return page.evaluate(()=> /\/login|\/signin|\/authenticate\/sign/i.test(location.pathname)||[...document.querySelectorAll('input[type=password]')].some(x=>x.getClientRects().length));}

const securePage24h = (page, allowInsecureHttp = false) => {
  const url = new URL(page.url());
  const protocolOk = url.protocol === 'https:' || (allowInsecureHttp && url.protocol === 'http:');
  if (!protocolOk || url.hostname !== 'khachhang.24h.com.vn') throw new SourceError('Nguồn 24h chuyển hướng khỏi transport được phép hoặc khỏi host đã xác minh; đã dừng trước khi gửi thông tin xác thực.', 'transport_security');
};

const secure24hUrl = value => {
  const url = new URL(value);
  if (url.hostname !== 'khachhang.24h.com.vn') throw new SourceError('Link báo cáo 24h không thuộc host nguồn đã xác minh.', 'needs_inspection');
  url.protocol = 'https:';
  return url.href;
};
const source24hUrl = (value, allowInsecureHttp = false) => {
  const url = new URL(value);
  if (url.hostname !== 'khachhang.24h.com.vn') throw new SourceError('Link báo cáo 24h không thuộc host nguồn đã xác minh.', 'needs_inspection');
  if (!allowInsecureHttp) url.protocol = 'https:';
  else if (!['http:', 'https:'].includes(url.protocol)) throw new SourceError('Link báo cáo 24h dùng transport không được phép.', 'transport_security');
  return url.href;
};

async function visibleText(page) {
  const texts = [await page.locator('body').innerText().catch(() => '')];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    texts.push(await frame.locator('body').innerText().catch(() => ''));
  }
  return texts.join('\n');
}

export function classify24LoginText(text) {
  const value = String(text || '');
  if (/(?:otp|one[- ]time|captcha|mã xác nhận|xác nhận thiết bị|verification code)/i.test(value)) return 'interactive_auth_required';
  if (/(?:sai|không đúng|không chính xác).*(?:mật khẩu|tài khoản)|(?:invalid|incorrect).*(?:password|credential)/i.test(value)) return 'invalid_credentials';
  return 'authentication_failed';
}

function checkedLoginRedirect(value, expected, { allowInsecureHttp = false } = {}) {
  if (!value) return null;
  const target = new URL(value, expected.href);
  const protocolOk = target.protocol === 'https:' || (allowInsecureHttp && target.protocol === 'http:');
  if (!protocolOk || target.hostname !== 'khachhang.24h.com.vn' || target.port !== expected.port || target.pathname !== expected.pathname) {
    throw new SourceError('Endpoint đăng nhập 24h chuyển hướng khỏi transport được phép hoặc khỏi action đã xác minh; đã dừng trước khi gửi thông tin xác thực.', 'transport_security');
  }
  return target;
}

async function preflightLoginAction(page, action, { allowInsecureHttp = false } = {}) {
  const expected = new URL(action);
  const protocolOk = expected.protocol === 'https:' || (allowInsecureHttp && expected.protocol === 'http:');
  if (!protocolOk || expected.hostname !== 'khachhang.24h.com.vn' || expected.port) {
    throw new SourceError('Endpoint đăng nhập 24h không dùng transport được phép cùng host và cổng mặc định đã xác minh.', 'transport_security');
  }
  const request = page.request || page.context?.().request;
  if (!request?.fetch) throw new SourceError('Không thể kiểm tra an toàn endpoint đăng nhập 24h trước khi gửi thông tin xác thực.', 'needs_inspection');
  let response = await request.fetch(expected.href, { method: 'HEAD', maxRedirects: 0, timeout: 10000 });
  if ([405, 501].includes(response.status())) response = await request.fetch(expected.href, { method: 'GET', maxRedirects: 0, timeout: 10000 });
  const location = response.headers()['location'];
  checkedLoginRedirect(location, expected, { allowInsecureHttp });
  const responseUrl = new URL(response.url());
  const responseProtocolOk = responseUrl.protocol === 'https:' || (allowInsecureHttp && responseUrl.protocol === 'http:');
  if (!responseProtocolOk || responseUrl.hostname !== expected.hostname || responseUrl.port) {
    throw new SourceError('Endpoint đăng nhập 24h phản hồi qua URL không an toàn; đã dừng trước khi gửi thông tin xác thực.', 'transport_security');
  }
  return expected;
}

async function installInsecureRequestGuard(page) {
  if (!page.route) throw new SourceError('Không thể chặn tài nguyên HTTP không an toàn trên trang đăng nhập 24h.', 'needs_inspection');
  await page.route('**/*', async route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.protocol === 'http:') return route.abort('blockedbyclient');
    return route.continue();
  });
}

async function installLoginTransportGuard(page, action, { allowInsecureHttp = false } = {}) {
  if (!page.route) throw new SourceError('Không thể chặn request không an toàn trên trang đăng nhập 24h.', 'needs_inspection');
  const actionUrl = new URL(action);
  const submit = async route => {
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
      checkedLoginRedirect(response.headers()['location'], actionUrl, { allowInsecureHttp });
      const responseUrl = new URL(response.url());
      const responseProtocolOk = responseUrl.protocol === 'https:' || (allowInsecureHttp && responseUrl.protocol === 'http:');
      if (!responseProtocolOk || responseUrl.hostname !== actionUrl.hostname || responseUrl.port) {
        throw new SourceError('Phản hồi đăng nhập 24h không còn ở transport được phép cùng host đã xác minh.', 'transport_security');
      }
      page.__loginRouteResponse = true;
      await route.fulfill({ response });
    } catch (error) {
      page.__loginRouteError = error;
      await route.abort('blockedbyclient').catch(() => {});
    }
  };
  await page.route(actionUrl.href, submit);
  return async () => {
    await page.unroute(actionUrl.href, submit).catch(() => {});
  };
}

async function login24h(page, link, { directory, job, update } = {}) {
  const debugEnabled = /^(?:1|true|yes|on)$/i.test(String(process.env.PWDEBUG || '')) || /(?:pw:api|playwright|trace)/i.test(String(process.env.DEBUG || ''));
  if (debugEnabled) throw new SourceError('Tự đăng nhập 24h bị khóa khi chế độ debug/tracing đang bật để tránh lộ thông tin xác thực.', 'debug_unsafe');
  const config = source24hConfig();
  const allowInsecureHttp = configured24hAllowInsecureHttp();
  if (!config.username || !config.password) {
    throw new SourceError('Bật SOURCE_24H_AUTO_LOGIN nhưng chưa cấu hình đủ SOURCE_24H_USERNAME và SOURCE_24H_PASSWORD trên máy chủ.', 'config_error');
  }
  const circuit = await authCircuit(directory, '24h');
  if (circuit?.open) {
    const temporary = temporary24hCircuit(circuit);
    if (!temporary?.valid || temporary.fresh) throw blocked24hCircuitError(circuit, temporary);
  }
  job.status = 'running';
  job.message = 'Đang đăng nhập nguồn 24h bằng cấu hình máy chủ';
  if (update) await update();
  // Public form evidence: /ocm/user/login?login=1, #loginform, #username,
  // #password and #btn-login. By default the published HTTP action is upgraded
  // to HTTPS before entering a secret; the explicit opt-in preserves it.
  // Install the HTTPS-only request guard before navigation in the default mode.
  if (!allowInsecureHttp) await installInsecureRequestGuard(page);
  await page.goto(`${allowInsecureHttp ? 'http' : 'https'}://khachhang.24h.com.vn/ocm/user/login?login=1`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  securePage24h(page, allowInsecureHttp);
  const form = page.locator('#loginform');
  const fields = await form.count().catch(() => 0);
  if (!fields || !await page.locator('#username').count() || !await page.locator('#password').count() || !await page.locator('#btn-login').count()) {
    throw new SourceError('Không xác định được biểu mẫu đăng nhập 24h theo trang công khai; cần khảo sát lại nguồn.', 'needs_inspection');
  }
  let action;
  try {
    action = await form.evaluate((node, allowHttp) => {
      const action = new URL(node.getAttribute('action') || location.href, location.href);
      if (action.hostname !== 'khachhang.24h.com.vn') throw new Error('Login action host is not verified.');
      if (!allowHttp) action.protocol = 'https:';
      node.setAttribute('action', action.href);
      return action.href;
    }, allowInsecureHttp);
  } catch {
    throw new SourceError('Biểu mẫu đăng nhập 24h không có action cùng host đã xác minh.', 'needs_inspection');
  }
  await preflightLoginAction(page, action, { allowInsecureHttp });
  const removeTransportGuard = await installLoginTransportGuard(page, action, { allowInsecureHttp });
  page.__loginRouteError = null;
  page.__loginRouteResponse = false;
  const dialogTexts = [];
  const dialogHandler = async dialog => { dialogTexts.push(dialog.message()); await dialog.dismiss().catch(() => {}); };
  page.on?.('dialog', dialogHandler);
  try {
  const preSubmitText = await visibleText(page);
  const preSubmitInteractive = await page.locator('input').evaluateAll(inputs => inputs.some(input => /otp|captcha|verification|mã.?xác.?nhận/i.test(`${input.name} ${input.id} ${input.placeholder}`))).catch(() => false);
  if (preSubmitInteractive || /(?:otp|one[- ]time|captcha|mã xác nhận|xác nhận thiết bị|verification code)/i.test(preSubmitText)) {
    await tripAuthCircuit(directory, '24h', 'interactive_auth_required');
    throw new SourceError('Nguồn 24h yêu cầu OTP, CAPTCHA hoặc xác nhận thiết bị trước khi đăng nhập tự động.', 'interactive_auth_required');
  }
  await page.locator('#username').fill(config.username);
  await page.locator('#password').fill(config.password);
  // The public page's link handler depends on an HTTP jQuery asset and can be
  // blocked after HTTPS upgrade. Submit the same verified form natively so its
  // official fields/action/target are preserved without executing source JS.
  await tripAuthCircuit(directory, '24h', 'login_in_progress');
  const frameNavigation = page.waitForEvent('framenavigated', { timeout: 10_000, predicate: frame => frame.name() === 'frm_submit' }).catch(() => null);
  await form.evaluate(node => HTMLFormElement.prototype.submit.call(node));
  const navigated = await frameNavigation;
  if (page.__loginRouteError) throw page.__loginRouteError;
  if (!navigated && !page.__loginRouteResponse && !dialogTexts.length) {
    throw new SourceError('Không xác minh được phản hồi submit đăng nhập 24h; không thử lại tự động để tránh gửi lặp thông tin xác thực.', 'authentication_pending');
  }
  const text = `${await visibleText(page)}\n${dialogTexts.join('\n')}`;
  const loginResult = classify24LoginText(text);
  if (loginResult === 'interactive_auth_required') {
    await tripAuthCircuit(directory, '24h', 'interactive_auth_required');
    throw new SourceError('Nguồn 24h yêu cầu OTP, CAPTCHA hoặc xác nhận thiết bị. Hoàn tất xác thực thủ công rồi cập nhật phiên nguồn.', 'interactive_auth_required');
  }
  if (loginResult === 'invalid_credentials') {
    await tripAuthCircuit(directory, '24h', 'invalid_credentials');
    throw new SourceError('24h từ chối username/password đã cấu hình. Sửa credentials rồi reset mạch xác thực.', 'invalid_credentials');
  }
  await page.goto(allowInsecureHttp ? link.url : secure24hUrl(link.url), { waitUntil: 'domcontentloaded', timeout: 45000 });
  securePage24h(page, allowInsecureHttp);
  if (await loginPage(page)) {
    await tripAuthCircuit(directory, '24h', 'authentication_failed');
    throw new SourceError('Kết quả đăng nhập 24h chưa được xác minh; trang nguồn vẫn yêu cầu đăng nhập. Kiểm tra credentials hoặc xác thực tương tác rồi reset mạch.', 'authentication_failed');
  }
  return true;
  } finally {
    page.off?.('dialog', dialogHandler);
    await removeTransportGuard();
  }
}

const admicroLoginHosts = new Set(['adx.admicro.vn', 'sso.admicro.vn']);
const secureAdmicroPage = page => {
  const url = new URL(page.url());
  if (url.protocol !== 'https:' || !admicroLoginHosts.has(url.hostname)) throw new SourceError('Nguồn Admicro chuyển hướng khỏi HTTPS hoặc khỏi host đã xác minh.', 'transport_security');
};
const classifyAdmicroLoginText = text => {
  const value = String(text || '');
  if (/(?:otp|one[- ]time|captcha|mã xác nhận|xác nhận thiết bị|verification code|recaptcha)/i.test(value)) return 'interactive_auth_required';
  if (/(?:sai|không đúng|không chính xác).*(?:mật khẩu|tài khoản)|(?:mật khẩu|tài khoản).*(?:sai|không đúng|không chính xác)|(?:invalid|incorrect|wrong).*(?:password|credential|username)|(?:password|credential|username).*(?:invalid|incorrect|wrong)/i.test(value)) return 'invalid_credentials';
  return 'authentication_failed';
};
export { classifyAdmicroLoginText };
function checkedAdmicroRedirect(value, expected) {
  if (!value) return null;
  const target = new URL(value, expected.href);
  if (target.protocol !== 'https:' || !admicroLoginHosts.has(target.hostname)) throw new SourceError('Endpoint đăng nhập Admicro chuyển hướng khỏi HTTPS hoặc khỏi host đã xác minh.', 'transport_security');
  return target;
}
async function preflightAdmicroLoginAction(page, action) {
  const expected = new URL(action);
  if (expected.protocol !== 'https:' || !admicroLoginHosts.has(expected.hostname) || expected.port) throw new SourceError('Endpoint đăng nhập Admicro không dùng HTTPS cùng host đã xác minh.', 'transport_security');
  const request = page.request || page.context?.().request;
  if (!request?.fetch) throw new SourceError('Không thể kiểm tra an toàn endpoint đăng nhập Admicro trước khi gửi thông tin xác thực.', 'needs_inspection');
  let response = await request.fetch(expected.href, { method: 'HEAD', maxRedirects: 0, timeout: 10000 });
  if ([405, 501].includes(response.status())) response = await request.fetch(expected.href, { method: 'GET', maxRedirects: 0, timeout: 10000 });
  checkedAdmicroRedirect(response.headers()['location'], expected);
  const responseUrl = new URL(response.url());
  if (responseUrl.protocol !== 'https:' || !admicroLoginHosts.has(responseUrl.hostname) || responseUrl.port) throw new SourceError('Phản hồi đăng nhập Admicro không còn ở HTTPS cùng host đã xác minh.', 'transport_security');
}
async function installAdmicroLoginTransportGuard(page, action) {
  if (!page.route) throw new SourceError('Không thể chặn request không an toàn trên trang đăng nhập Admicro.', 'needs_inspection');
  const actionUrl = new URL(action);
  const submit = async route => {
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 15000 });
      checkedAdmicroRedirect(response.headers()['location'], actionUrl);
      const responseUrl = new URL(response.url());
      if (responseUrl.protocol !== 'https:' || !admicroLoginHosts.has(responseUrl.hostname) || responseUrl.port) throw new SourceError('Phản hồi đăng nhập Admicro không còn ở HTTPS cùng host đã xác minh.', 'transport_security');
      page.__loginRouteResponse = true;
      await route.fulfill({ response });
    } catch (error) {
      page.__loginRouteError = error;
      await route.abort('blockedbyclient').catch(() => {});
    }
  };
  await page.route(actionUrl.href, submit);
  return async () => { await page.unroute(actionUrl.href, submit).catch(() => {}); };
}
async function loginAdmicro(page, link, { directory, job, update } = {}) {
  const debugEnabled = /^(?:1|true|yes|on)$/i.test(String(process.env.PWDEBUG || '')) || /(?:pw:api|playwright|trace)/i.test(String(process.env.DEBUG || ''));
  if (debugEnabled) throw new SourceError('Tự đăng nhập Admicro bị khóa khi chế độ debug/tracing đang bật để tránh lộ thông tin xác thực.', 'debug_unsafe');
  const config = sourceAdmicroConfig();
  if (!config.username || !config.password) throw new SourceError('Bật SOURCE_ADMICRO_AUTO_LOGIN nhưng chưa cấu hình đủ SOURCE_ADMICRO_USERNAME và SOURCE_ADMICRO_PASSWORD trên máy chủ.', 'config_error');
  const circuit = await authCircuit(directory, 'admicro-mobile');
  if (circuit?.open) throw new SourceError('Tự đăng nhập Admicro đang tạm dừng sau lỗi xác thực trước đó. Sửa credentials hoặc hoàn tất xác thực tương tác rồi đặt lại mạch xác thực.', 'auth_blocked');
  job.status = 'running'; job.message = 'Đang đăng nhập nguồn Admicro bằng cấu hình máy chủ'; if (update) await update();
  secureAdmicroPage(page);
  const form = page.locator('#frmLogin').first();
  const fallbackForm = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first();
  const selectedForm = await form.count().catch(() => 0) ? form : fallbackForm;
  if (!await selectedForm.count().catch(() => 0)) throw new SourceError('Không xác định được biểu mẫu đăng nhập Admicro theo trang công khai; cần khảo sát lại nguồn.', 'needs_inspection');
  const user = page.locator('#txtUser, input[name="txtUser"], input[name="username"], input[type="email"]').first();
  const password = page.locator('#txtPass, input[name="txtPass"], input[name="password"], input[type="password"]').first();
  if (!await user.count() || !await password.count()) throw new SourceError('Biểu mẫu đăng nhập Admicro thiếu trường tài khoản hoặc mật khẩu.', 'needs_inspection');
  const interactive = await page.locator('input,iframe').evaluateAll(nodes => nodes.some(node => node.getClientRects().length && /(?:otp|captcha|verification|mã.?xác.?nhận|recaptcha)/i.test(`${node.name || ''} ${node.id || ''} ${node.getAttribute('src') || ''} ${node.getAttribute('title') || ''}`))).catch(() => false);
  if (interactive) { await tripAuthCircuit(directory, 'admicro-mobile', 'interactive_auth_required'); throw new SourceError('Nguồn Admicro yêu cầu OTP, CAPTCHA hoặc xác nhận thiết bị trước khi đăng nhập tự động.', 'interactive_auth_required'); }
  let action;
  try {
    action = await selectedForm.evaluate(node => new URL(node.getAttribute('action') || location.href, location.href).href);
    const parsed = new URL(action); if (parsed.protocol !== 'https:' || !admicroLoginHosts.has(parsed.hostname)) throw Error('unverified action');
  } catch { throw new SourceError('Biểu mẫu đăng nhập Admicro không có action HTTPS cùng host đã xác minh.', 'needs_inspection'); }
  await preflightAdmicroLoginAction(page, action);
  const removeGuard = await installAdmicroLoginTransportGuard(page, action);
  page.__loginRouteError = null; page.__loginRouteResponse = false;
  const dialogs = [], dialogHandler = async dialog => { dialogs.push(dialog.message()); await dialog.dismiss().catch(() => {}); };
  page.on?.('dialog', dialogHandler);
  try {
    await user.fill(config.username); await password.fill(config.password); await tripAuthCircuit(directory, 'admicro-mobile', 'login_in_progress');
    const navigation = page.waitForNavigation?.({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
    await selectedForm.evaluate(node => HTMLFormElement.prototype.submit.call(node));
    const navigated = await navigation;
    if (page.__loginRouteError) throw page.__loginRouteError;
    if (!navigated && !page.__loginRouteResponse && !dialogs.length) throw new SourceError('Không xác minh được phản hồi submit đăng nhập Admicro; dừng để tránh gửi lặp thông tin xác thực.', 'authentication_pending');
    const text = `${await visibleText(page)}\n${dialogs.join('\n')}`;
    const outcome = classifyAdmicroLoginText(text);
    if (outcome === 'interactive_auth_required') { await tripAuthCircuit(directory, 'admicro-mobile', outcome); throw new SourceError('Nguồn Admicro yêu cầu OTP, CAPTCHA hoặc xác nhận thiết bị.', outcome); }
    if (outcome === 'invalid_credentials') { await tripAuthCircuit(directory, 'admicro-mobile', outcome); throw new SourceError('Admicro từ chối username/password đã cấu hình. Sửa credentials rồi đặt lại mạch xác thực.', outcome); }
    await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); secureAdmicroPage(page);
    if (await loginPage(page)) { await tripAuthCircuit(directory, 'admicro-mobile', 'authentication_failed'); throw new SourceError('Kết quả đăng nhập Admicro chưa được xác minh; trang nguồn vẫn yêu cầu đăng nhập.', 'authentication_failed'); }
  } finally { page.off?.('dialog', dialogHandler); await removeGuard(); }
}

export async function ensureAuthenticatedSession(page, link, { directory, job = {}, update = async () => {}, force = false, login = false, probe = true, loginHandler = login24h, beforeLogin = async currentPage => currentPage } = {}) {
  let currentPage = page;
  let probeAuthError = null;
  const autoLoginEnabled = sourceAutoLoginEnabled(link.connector);
  const allowInsecureHttp = link.connector === '24h' && autoLoginEnabled && configured24hAllowInsecureHttp();
  // A forced or explicitly requested login must go straight to the login
  // handler. The report endpoint is intentionally inaccessible before a
  // login, so probing it here would turn a normal login into access_denied.
  if (probe && !force && !login && autoLoginEnabled) {
    try {
      await currentPage.goto(link.connector === '24h' ? source24hUrl(link.url, allowInsecureHttp) : link.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (link.connector === '24h') {
        securePage24h(currentPage, allowInsecureHttp);
        await probe24hReport(currentPage, link, { allowInsecureHttp, accessDeniedAsAuth: true });
      } else if (link.connector.startsWith('admicro-')) secureAdmicroPage(currentPage);
    } catch (error) {
      if (error?.status !== 'auth_required') throw error;
      probeAuthError = error;
    }
  }
  const needsLogin = force || login || probeAuthError || await loginPage(currentPage);
  if (!needsLogin) {
    if (autoLoginEnabled) await resetAuthCircuit(directory, link.connector === '24h' ? '24h' : 'admicro-mobile');
    return { authenticated: true, refreshed: false };
  }
  if (!['24h', 'admicro-pc', 'admicro-mobile'].includes(link.connector) || !autoLoginEnabled) {
    throw new SourceError(`Phiên nguồn ${link.connector} cần đăng nhập hoặc làm mới bằng lệnh quản trị session:login.`, 'auth_required');
  }
  // The caller owns profile lifecycle. It must close the active browser and
  // return a page backed by a candidate profile before credentials are read or
  // submitted. This also covers an AJAX auth expiry where the visible report
  // page has no login form.
  try {
    const handler = link.connector.startsWith('admicro-') && loginHandler === login24h ? loginAdmicro : loginHandler;
    const loginAndVerify = async () => {
      const pageBeforeLogin = currentPage;
      currentPage = await beforeLogin(currentPage) || currentPage;
      // An earlier submit may have succeeded even when its response was
      // ambiguous. Prove a supplied pending candidate before another submit.
      if (link.connector === '24h') {
        const circuit = await authCircuit(directory, '24h');
        const temporary = temporary24hCircuit(circuit);
        const replacementPage = currentPage !== pageBeforeLogin || job?.useCandidate === true || job?.promoteCandidate === true;
        if (circuit?.open && temporary && !temporary.valid) throw blocked24hCircuitError(circuit, temporary);
        if (circuit?.open && temporary && replacementPage) {
          try {
            await probe24hReport(currentPage, link, { allowInsecureHttp });
            await resetAuthCircuit(directory, '24h');
            return true;
          } catch (error) {
            // Only a known auth response permits a stale circuit to submit
            // once. Preserve genuine provider denials and unknown browser,
            // transport, schema and network failures unchanged.
            const retryableAuthProbe = error?.status === 'auth_required' || (error?.status === 'access_denied' && error?.ambiguousSession === true);
            if (!retryableAuthProbe) throw error;
            if (temporary.fresh) throw blocked24hCircuitError(circuit, temporary);
          }
        }
        if (circuit?.open && temporary?.fresh) throw blocked24hCircuitError(circuit, temporary);
        if (circuit?.open && !temporary) throw blocked24hCircuitError(circuit, temporary);
      }
      await handler(currentPage, link, { directory, job, update });
      return false;
    };
    const verifiedCandidate = await loginAndVerify();
    if (verifiedCandidate) return { authenticated: true, refreshed: true };
    if (link.connector === '24h') {
      try {
        await probe24hReport(currentPage, link, { allowInsecureHttp });
      } catch (error) {
        // A 200 HTML access-denied response can mean that the provider has
        // not established the refreshed session yet. Re-probe once without
        // submitting credentials again; preserve the provider denial if it
        // remains. The second probe is intentionally outside this recovery
        // catch so this cannot become an auth retry loop.
        if (!error?.ambiguousSession || !autoLoginEnabled) throw error;
        await probe24hReport(currentPage, link, { allowInsecureHttp });
      }
    }
    await resetAuthCircuit(directory, link.connector === '24h' ? '24h' : 'admicro-mobile');
  } catch (error) {
    if (error?.status === 'auth_required') {
      await tripAuthCircuit(directory, link.connector === '24h' ? '24h' : 'admicro-mobile', 'authentication_failed');
      throw new SourceError(`Kết quả đăng nhập ${link.connector.startsWith('admicro-') ? 'Admicro' : '24h'} chưa được xác minh bằng báo cáo được bảo vệ.`, 'authentication_failed');
    }
    throw error;
  }
  return { authenticated: true, refreshed: true };
}
async function readAdmicro(page,link,from,to,pc) {
  const url=new URL(link.url);url.searchParams.set('fd',from);url.searchParams.set('td',to);
  await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:45000});
  if(await loginPage(page))throw new SourceError('Cần đăng nhập lại. Bấm Đăng nhập tại link này.','auth_required');
  try{await page.waitForFunction(()=>{
    const table=document.querySelector('#tabledata');
    return table?.querySelector('tfoot')?.innerText.includes('Tổng') && table?.querySelector('thead')?.innerText.includes('Lượt hiển thị');
  },null,{timeout:45000});}catch{if(await loginPage(page))throw new SourceError('Cần đăng nhập lại.','auth_required');throw new SourceError('Chưa tải được bảng báo cáo và dòng Tổng.');}
  // Stable DOM plus explicit remote-completion flags on PC when present.
  let before='',stable=0;
  for(let i=0;i<45&&stable<3;i++) {await page.waitForTimeout(1000);const txt=await page.locator('#tabledata').innerText();stable=txt===before?stable+1:0;before=txt;}
  if(stable<3)throw new SourceError('Bảng vẫn thay đổi, dữ liệu chưa hoàn tất.');
  const extract = async () => page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const cellValue = cell => {
      const text = clean(cell.innerText);
      if (text) return text;
      const label = [...cell.querySelectorAll('[title],[alt]')].map(node => node.getAttribute('title') || node.getAttribute('alt')).filter(Boolean).join(' | ');
      return label || clean(cell.getAttribute('data-value'));
    };
    const grid = table => {
      const rows = [...table.rows].filter(visible), cells = [];
      rows.forEach((row, rowIndex) => {
        cells[rowIndex] ||= [];
        let column = 0;
        for (const cell of row.cells) {
          while (cells[rowIndex][column] !== undefined) column++;
          const rowSpan = cell.rowSpan || 1, colSpan = cell.colSpan || 1;
          for (let dr = 0; dr < rowSpan; dr++) {
            cells[rowIndex + dr] ||= [];
            for (let dc = 0; dc < colSpan; dc++) cells[rowIndex + dr][column + dc] = dr === 0 && dc === 0 ? cellValue(cell) : '';
          }
          column += colSpan;
        }
      });
      const width = Math.max(0, ...cells.map(row => row.length));
      return cells.map(row => Array.from({ length: width }, (_, index) => row[index] ?? ''));
    };
    const tableData = table => {
      const rows = grid(table), head = table.querySelector('thead tr');
      const headers = head ? grid({ rows: [head] })[0] || [] : rows[0] || [];
      const footer = [...table.querySelectorAll('tfoot tr')].find(row => /tổng|total/i.test(clean(row.innerText)));
      const bodyRows = [...table.querySelectorAll('tbody tr')].filter(visible).filter(row => !/^(?:tổng|total)\b/i.test(clean(row.innerText))).map(row => ({ id: row.id || null, values: grid({ rows: [row] })[0] || [] }));
      return { headers, total: footer ? grid({ rows: [footer] })[0] || [] : [], rows: bodyRows };
    };
    const tables = [...document.querySelectorAll('table')].filter(visible).map(table => {
      const value = tableData(table), text = clean(table.parentElement?.innerText || table.innerText).toLowerCase();
      const headers = value.headers.map(header => clean(header).toLowerCase());
      const title = headers.some(header => header.includes('domain')) ? 'domain' : headers.some(header => header.includes('click bắc') || header.includes('click trung')) ? 'region' : headers.some(header => header.includes('ngày') || header.includes('date')) && headers.some(header => header.includes('lượt hiển thị')) ? 'daily' : headers.some(header => header.includes('chiến dịch') || header.includes('campaign')) ? 'campaign' : text.includes('quảng cáo') ? 'overview' : 'other';
      return { ...value, title };
    }).filter(table => table.headers.length && (table.rows.length || table.total.length));
    return { tables };
  });
  const rawOverview = await page.evaluate(() => {
    const table = document.querySelector('#tabledata');
    if (!table) return null;
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const cellValue = cell => clean(cell.innerText) || [...cell.querySelectorAll('[title],[alt]')].map(node => node.getAttribute('title') || node.getAttribute('alt')).filter(Boolean).join(' | ') || clean(cell.getAttribute('data-value'));
    const expand = row => row ? [...row.cells].flatMap(cell => [cellValue(cell), ...Array(Math.max(0, (cell.colSpan || 1) - 1)).fill('')]) : [];
    const header = table.querySelector('thead tr'), foot = [...table.querySelectorAll('tfoot tr')].find(row => /tổng|total/i.test(clean(row.innerText)));
    return { headers: expand(header), total: expand(foot), rows: [...table.querySelectorAll('tbody tr')].filter(visible).filter(row => !/^(?:tổng|total)\b/i.test(clean(row.innerText))).map(row => ({ id: row.id || null, values: expand(row) })) };
  });
  if (!rawOverview) throw new SourceError('Không tìm thấy bảng Tổng quan Admicro.','schema_error');
  const flags=await page.evaluate(()=>window.rmtData);
  if(pc&&flags?.rpt!==undefined&&(String(flags.rpt)!=='1'||String(flags.total)!=='1'))throw new SourceError('Nguồn chưa hoàn tất báo cáo.','schema_error');
  const values = await page.evaluate(() => ({ from: [...document.querySelectorAll('input[name="fromdate"]')].map(node => node.value), to: [...document.querySelectorAll('input[name="todate"]')].map(node => node.value), url: location.href }));
  const expected = value => normalizedDate(value);
  if ((values.from.length && values.from.some(value => expected(value) !== from)) || (values.to.length && values.to.some(value => expected(value) !== to))) throw new SourceError('Bộ lọc ngày trên nguồn không khớp link.','schema_error');
  let summary = { tables: [] }, previous = '';
  const mergeTables = snapshot => {
    for (const table of snapshot.tables || []) {
      const key = `${table.title}|${(table.headers || []).join('|')}`;
      const existing = summary.tables.find(item => `${item.title}|${(item.headers || []).join('|')}` === key);
      if (!existing) summary.tables.push({ ...table, rows: [...(table.rows || [])] });
      else {
        const seen = new Set(existing.rows.map(row => JSON.stringify(row.values)));
        existing.rows.push(...(table.rows || []).filter(row => !seen.has(JSON.stringify(row.values))));
        if (!existing.total.length && table.total?.length) existing.total = table.total;
      }
    }
  };
  const reportTab = page.getByText('Báo cáo tổng hợp', { exact: true }).first();
  if (await reportTab.count().catch(() => 0)) {
    await reportTab.click({ noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(500);
    await page.waitForFunction(() => [...document.querySelectorAll('table')].some(table => table.getClientRects().length && /chiến dịch|ngày|domain/i.test(table.innerText)), null, { timeout: 30000 }).catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await extract();
      const signature = JSON.stringify(snapshot.tables?.map(table => [table.title, table.headers, table.rows?.map(row => row.values)]));
      mergeTables(snapshot);
      if (signature === previous) break;
      previous = signature;
      const beforePageText = await page.locator('table').allInnerTexts().catch(() => []);
      const clicked = await page.evaluate(() => {
        const isVisible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
        const candidates = [...document.querySelectorAll('button,a,[role="button"]')].filter(node => isVisible(node) && !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true' && !node.classList.contains('disabled'));
        const next = candidates.find(node => /^(?:>|›|»|next|sau)$/i.test((node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()));
        if (!next) return false;
        next.click();
        return true;
      });
      if (!clicked) break;
      await page.waitForFunction(previousText => {
        const visibleText = [...document.querySelectorAll('table')].filter(table => table.getClientRects().length).map(table => table.innerText);
        return JSON.stringify(visibleText) !== JSON.stringify(previousText);
      }, beforePageText, { timeout: 5000 }).catch(() => page.waitForTimeout(800));
    }
  }
  const normalized = normalizeAdmicroRaw({ overview: rawOverview, summary });
  if (!normalized.daily.length) throw new SourceError('Không tìm thấy bảng Báo cáo theo ngày trong tab Báo cáo tổng hợp; dừng để tránh lưu thiếu dữ liệu.','schema_error');
  normalized.overview.tabs = { overview: rawOverview, summary };
  // A verified date may contain N/A, especially before campaign activation.
  // Keep that day explicitly unknown rather than manufacturing a zero.
  return normalized;
}
const adapters={
  'admicro-pc':{profile:'admicro',read:(p,l,f,t)=>readAdmicro(p,l,f,t,true)},
  'admicro-mobile':{profile:'admicro',read:(p,l,f,t)=>readAdmicro(p,l,f,t,false)},
  '24h':{profile:'24h',read:(p,l,f,t,options)=>read24h(p,l,f,t,options)},
  'fpt':{profile:'fpt',read:async()=>{throw new SourceError('FPT cần link đầy đủ có quyền xem báo cáo và khảo sát bảng; chưa có bộ đọc đã xác minh.','needs_inspection');}}
};
function configuredBrowserLaunchOptions() {
  try {
    return browserLaunchOptions();
  } catch (error) {
    if (error instanceof BrowserRuntimeError) throw new SourceError(error.message, 'config_error');
    throw error;
  }
}
async function collectUnlocked(link,{directory,projectRoot,job = {},update = async () => {},login=false,lockHeld=false,profileLock=null,browser=chromium,adapterMap=adapters,ensureSession=ensureAuthenticatedSession,loginHandler=login24h,retryBudget=2, ...googleOptions}) {
  if (link.connector === 'google-ads') return collectGoogleAds(link, { ...googleOptions, job, update, maxRetries: retryBudget });
  if (link.connector === META_CONNECTOR) return collectMetaAds(link, { ...googleOptions, job, update, maxRetries: retryBudget });
  const adapter=adapterMap[link.connector];
  const autoLoginEnabled = sourceAutoLoginEnabled(link.connector);
  const allowInsecureHttp = link.connector === '24h' && autoLoginEnabled && configured24hAllowInsecureHttp();
  const sourceUrl = link.connector === '24h' ? source24hUrl(link.url, allowInsecureHttp) : link.url;
  const activeProfile=sourceProfileDirectory(directory,link.connector);
  const sessionsRoot = join(directory, 'sessions');
  await makeDirectory(sessionsRoot, { recursive: true, mode: 0o700 });
  chmodSync(sessionsRoot, 0o700);
  await recoverProfilePromotion(activeProfile);
  const candidateProfile=`${activeProfile}.pending`;
  let profile=job?.useCandidate&&existsSync(candidateProfile)?candidateProfile:activeProfile;
  const hadProfile=existsSync(profile);
  await makeDirectory(profile, { recursive: true, mode: 0o700 });
  chmodSync(profile, 0o700);
  // Crawls use the persistent server-side profile in headless mode. Login and
  // refresh happen separately with `npm run session:login -- <connector>`.
  const launchOptions={
    headless:true,
    viewport:{width:1440,height:950},
    timeout:30000,
    ...configuredBrowserLaunchOptions(),
  };
  let context;
  try {
    context=await browser.launchPersistentContext(profile,launchOptions);
  } catch (error) {
    if(/executable|browser.*not found|launch/i.test(String(error?.message||''))) {
      throw new SourceError('Không mở được Chromium. Cài browser runtime bằng `npx playwright install chromium` và kiểm tra quyền chạy của thư mục dữ liệu.');
    }
    throw error;
  }
  openContexts.add(context);
  const closeOnLockLoss = profileLock?.lost.then(async () => { if (context) await context.close().catch(() => {}); }).catch(() => {});
  try {
    let page=context.pages()[0]||await context.newPage();
    await page.goto(link.connector === '24h' && autoLoginEnabled ? sourceUrl : link.url,{waitUntil:'domcontentloaded',timeout:45000});
    if (link.connector === '24h' && autoLoginEnabled) securePage24h(page, allowInsecureHttp);
    if (link.connector.startsWith('admicro-') && autoLoginEnabled) secureAdmicroPage(page);
    const requiresLogin=login||await loginPage(page);
    const switchToCandidate = async () => {
      if (profile !== activeProfile) return page;
      openContexts.delete(context);
      await context.close();
      context=null;
      if (!hadProfile) await removeDirectory(activeProfile, { recursive: true, force: true });
      profile=candidateProfile;
      job.useCandidate=true;
      job.promoteCandidate=true;
      context=await browser.launchPersistentContext(profile,launchOptions);
      openContexts.add(context);
      page=context.pages()[0]||await context.newPage();
      await page.goto(link.connector === '24h' ? sourceUrl : link.url,{waitUntil:'domcontentloaded',timeout:45000});
      if (link.connector === '24h' && autoLoginEnabled) securePage24h(page, allowInsecureHttp);
      if (autoLoginEnabled && link.connector.startsWith('admicro-')) secureAdmicroPage(page);
      return page;
    };
    if (requiresLogin && autoLoginEnabled && profile === activeProfile) {
      // Never mutate a verified active profile while refreshing credentials.
      // Close the context before staging the candidate so Chromium does not
      // retain a lock on the directory during promotion.
      await switchToCandidate();
    }
    try {
      await ensureSession(page, link, { directory, job, update, login: requiresLogin, probe: true, beforeLogin: switchToCandidate, loginHandler });
    } catch (error) {
      // Some sessions return an ordinary report page while the protected AJAX
      // probe reports auth_required. Stage before login in that case too.
      if (error?.status !== 'auth_required' || !autoLoginEnabled || profile !== activeProfile) throw error;
      await switchToCandidate();
      await ensureSession(page, link, { directory, job, update, login: true, probe: true, beforeLogin: switchToCandidate, loginHandler });
    }
    if(!adapter.read)throw new SourceError('Chưa có bộ đọc nguồn.','needs_inspection');
    job.status='running';job.message='Đọc tổng kỳ và chi tiết quảng cáo';await update();
    let authRecoveryUsed = Boolean(job.authRecoveryAttempts);
    const readWithRecovery = async (from, to) => {
      try { return await adapter.read(page,link,from,to,{ secureTransport: autoLoginEnabled && !allowInsecureHttp }); }
      catch (error) {
        const ambiguous24hAccessDenied = link.connector === '24h' && error?.ambiguousSession === true;
        const recoverableAuthFailure = error?.status === 'auth_required' || ambiguous24hAccessDenied;
        if (!recoverableAuthFailure || authRecoveryUsed || !autoLoginEnabled || !['24h', 'admicro-pc', 'admicro-mobile'].includes(link.connector) || Number(job.retries || 0) >= Number(retryBudget)) throw error;
        authRecoveryUsed = true;
        job.retries = Number(job.retries || 0) + 1;
        job.authRecoveryAttempts = Number(job.authRecoveryAttempts || 0) + 1;
        job.message = `Phiên ${link.connector.startsWith('admicro-') ? 'Admicro' : '24h'} hết hạn giữa lúc đọc; đang xác minh và đăng nhập lại (1/1)`;
        await update();
        await switchToCandidate();
        await ensureSession(page, link, { directory, job, update, force: true, probe: true, beforeLogin: switchToCandidate, loginHandler });
        return adapter.read(page,link,from,to,{ secureTransport: autoLoginEnabled && !allowInsecureHttp });
      }
    };
    const period=await readWithRecovery(link.from,link.to);
    const reportReadVerified = true;
    const daily=[], dailyDetails=[];const dates=days(link.from,link.to);
    if(period.daily?.length){daily.push(...period.daily);dailyDetails.push(...(period.dailyDetails||period.details).map(row=>({...row,date:row.date||null})));job.message=`Đã nhận ${daily.length} dòng ngày từ nguồn`;await update();}
    else for(const d of dates){job.message=`Lấy ngày ${d} (${daily.length+1}/${dates.length})`;await update();const r=link.from===link.to?period:await readWithRecovery(d,d);daily.push({date:d,...r.total});dailyDetails.push(...r.details.map(row=>({date:d,...row})))}
    const check=reconcile(period.total,daily);
    const unknown=daily.filter(d=>['impressions','clicks','spend'].some(k=>period.total[k]!=null&&d[k]==null));
    if(unknown.length)check.status='incomplete';
    return {...period,daily,dailyDetails,reconciliation:check,complete:check.status==='matched',sessionVerified:profile===candidateProfile&&reportReadVerified,fetchedAt:new Date().toISOString(),from:link.from,to:link.to,timezone:'Asia/Ho_Chi_Minh',method:link.connector==='24h'?'24h AJAX JSON theo ngày và phân trang':'Bảng HTML một trang Tổng quan + Báo cáo tổng hợp',verification:'live',warnings:unknown.length?[`${unknown.length} ngày có N/A trên nguồn. Không đổi thành 0; chưa thể đối soát đủ tổng ngày.`]:check.status==='mismatch'?['Tổng các ngày khác tổng kỳ. Có thể nguồn cập nhật trong lúc thu thập; cần đối soát lại.']:[],viewerDefinition:'Người xem do nguồn báo cáo trong từng phạm vi; không cộng qua ngày hoặc link.'};
  }finally{if(context){openContexts.delete(context);await context.close();}}
}

export async function collect(link, options = {}) {
  if (link.connector === 'google-ads' || link.connector === META_CONNECTOR) return collectUnlocked(link, options);
  if (options.lockHeld) return collectUnlocked(link, options);
  return withProfileLock(options.directory, link.connector, async lock => {
    const activeProfile = sourceProfileDirectory(options.directory, link.connector);
    await recoverProfilePromotion(activeProfile);
    const result = await collectUnlocked(link, { ...options, lockHeld: true, profileLock: lock });
    lock.assertHeld();
    if (result?.sessionVerified === true) {
      await promoteVerifiedProfile(activeProfile);
      lock.assertHeld();
    }
    return result;
  });
}
