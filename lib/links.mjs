import { createHash } from 'node:crypto';

export function date(value) {
  if (!value) return null;
  let s = String(value).trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) s = s.split('-').reverse().join('-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0,10) !== s) throw Error('Ngày không hợp lệ.');
  return s;
}
export function month(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(`${s}-01`))) throw Error('Tháng báo cáo không hợp lệ.');
  return s;
}
function nestedValues(searchParams) {
  const values = [];
  for (const raw of searchParams.values()) {
    const candidates = [raw];
    try { candidates.push(decodeURIComponent(raw)); } catch { /* Keep the original value. */ }
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        values.push(parsed);
      } catch { /* Most report URL values are not JSON. */ }
    }
  }
  return values;
}
function findNested(value, predicate) {
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = Array.isArray(child) ? child.map(item => findNested(item, predicate)).find(Boolean) : findNested(child, predicate);
    if (found) return found;
  }
  return null;
}
function identifyMetaReport(url, input = {}) {
  const all = [Object.fromEntries(url.searchParams), ...nestedValues(url.searchParams)];
  const flat = Object.fromEntries(url.searchParams);
  const accountId = flat.act || flat.account_id || flat.accountId || findNested(all, value => typeof value.act === 'string')?.act;
  if (!accountId) throw Error('Link Meta Ads thiếu mã tài khoản act.');
  const account = String(accountId).replace(/^act_/, '');
  if (!/^\d{5,20}$/.test(account)) throw Error('Mã tài khoản Meta Ads trong link không hợp lệ.');

  // Ads Manager can link to a server-side saved report by ID without including
  // its filters, columns or date range in the URL. Resolve its configuration
  // through the configured Graph API token and use form dates as the override.
  const hasInlineDefinition = ['since', 'from', 'until', 'to', 'time_range', 'breakdowns', 'metrics', 'filter_set', 'filtering', 'filters']
    .some(key => flat[key] != null);
  if (flat.selected_report_id && !hasInlineDefinition) {
    const savedReportId = String(flat.selected_report_id);
    if (!/^\d{5,20}$/.test(savedReportId)) throw Error('Mã saved report Meta Ads không hợp lệ.');
    let from = input.from ? date(input.from) : null;
    let to = input.to ? date(input.to) : null;
    if (!from && !to && input.reportMonth) {
      const reportMonth = month(input.reportMonth);
      const [year, monthNumber] = reportMonth.split('-').map(Number);
      from = `${reportMonth}-01`;
      to = `${reportMonth}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, '0')}`;
    }
    if (from && to && from > to) throw Error('Ngày bắt đầu phải trước ngày kết thúc.');
    if (from && to && (Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw Error('Mỗi link tối đa 367 ngày.');
    return { account, savedReportId, filters: null, metrics: null, from, to };
  }

  const dateRange = findNested(all, value => (value.since || value.start_date) && (value.until || value.end_date));
  const range = String(flat.time_range || '').replace(/,$/, '').match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/);
  let from = flat.since || flat.from || dateRange?.since || dateRange?.start_date || range?.[1];
  let to = flat.until || flat.to || dateRange?.until || dateRange?.end_date || range?.[2];
  if (!from || !to) throw Error('Link Meta Ads cần khoảng ngày since/until.');
  from = date(from); to = date(to);
  if (from > to) throw Error('Ngày bắt đầu phải trước ngày kết thúc.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw Error('Mỗi link tối đa 367 ngày.');

  const breakdown = flat.breakdowns || findNested(all, value => value.breakdowns)?.breakdowns;
  const breakdownText = Array.isArray(breakdown) ? breakdown.join(',') : String(breakdown || '');
  if (breakdownText !== 'days_1') throw Error('Chỉ hỗ trợ báo cáo Meta Ads theo ngày (breakdowns=days_1).');
  const metrics = String(flat.metrics || '').split(',').filter(Boolean);
  if (metrics.length !== 3 || new Set(metrics).size !== 3 || !['clicks', 'impressions', 'ctr'].every(metric => metrics.includes(metric))) throw Error('Báo cáo Meta Ads chỉ hỗ trợ clicks, impressions và CTR.');
  const filters = [];
  for (const value of all) {
    const list = Array.isArray(value) ? value : value?.filtering || value?.filters || [];
    for (const filter of Array.isArray(list) ? list : []) if (filter && typeof filter === 'object') filters.push(filter);
  }
  const rawFilterSet = flat.filter_set;
  if (rawFilterSet) {
    for (const record of rawFilterSet.split('\u001d').filter(Boolean)) {
      const parts = record.split('\u001e');
      const match = parts[0]?.match(/^(.+?)-(STRING|STRING_SET)$/);
      if (!match || parts.length !== 3 || !['campaign_name', 'objective', 'had_delivery'].includes(match[1])) throw Error('Link Meta Ads chứa bộ lọc chưa được hỗ trợ.');
      let value;
      try { value = JSON.parse(parts[2]); } catch { throw Error('Link Meta Ads chứa giá trị bộ lọc không hợp lệ.'); }
      filters.push({ field: match[1], type: match[2], operator: parts[1], value });
    }
  }
  const campaignFilter = filters.find(filter => filter.field === 'campaign_name');
  const objectiveFilter = filters.find(filter => filter.field === 'objective');
  const deliveryFilter = filters.find(filter => filter.field === 'had_delivery');
  const campaignName = campaignFilter?.value ?? flat.campaign_name ?? null;
  const objective = objectiveFilter?.value ?? null;
  const hadDelivery = deliveryFilter?.value ?? flat.had_delivery ?? null;
  if (filters.some(filter => !['campaign_name', 'objective', 'had_delivery'].includes(filter.field))) throw Error('Link Meta Ads chứa bộ lọc chưa được hỗ trợ.');
  if (typeof campaignName !== 'string' || !campaignName.trim() || campaignFilter?.operator !== 'CONTAIN' || campaignFilter.type !== 'STRING') throw Error('Link Meta Ads cần bộ lọc campaign_name CONTAIN với giá trị không rỗng.');
  if (objectiveFilter && (!Array.isArray(objective) || !objective.length || objective.some(item => typeof item !== 'string' || !item.trim()) || objectiveFilter.operator !== 'IN' || objectiveFilter.type !== 'STRING_SET')) throw Error('Link Meta Ads cần bộ lọc objective IN với danh sách giá trị không rỗng.');
  if (String(hadDelivery) !== '1' || deliveryFilter?.operator !== 'EQUAL' || deliveryFilter.type !== 'STRING') throw Error('Link Meta Ads cần bộ lọc had_delivery = 1.');
  if (![2, 3].includes(filters.length) || new Set(filters.map(filter => filter.field)).size !== filters.length) throw Error('Link Meta Ads phải có đúng một giá trị cho mỗi bộ lọc được hỗ trợ.');
  return {
    account,
    filters: {
      campaignName,
      campaignOperator: campaignFilter?.operator ?? null,
      objective,
      hadDelivery
    },
    metrics,
    from, to
  };
}
export function identify(input) {
  // Markdown/chat clients sometimes escape query separators as `\&`. Clean
  // only that transport artefact; keep backslashes in every other URL part.
  const inputUrl = String(input?.url ?? '').trim().replace(/\\&/g, '&');
  let u; try { u = new URL(inputUrl); } catch { throw Error('Hãy nhập URL đầy đủ.'); }
  if (!['https:','http:'].includes(u.protocol) || u.username || u.password) throw Error('URL không hợp lệ.');
  if (['facebook.com', 'www.facebook.com', 'adsmanager.facebook.com'].includes(u.hostname) && [...u.searchParams.keys()].some(key => /(?:token|secret|password|cookie|authorization|api[_-]?key|credential|session|^auth$)/i.test(key))) throw Error('URL Meta Ads không được chứa thông tin xác thực.');
  let connector, campaign = null, device = null, from, to, metaReport = null;
  if (u.hostname === 'facebook.com' || u.hostname === 'www.facebook.com' || u.hostname === 'adsmanager.facebook.com') {
    if (u.hostname === 'adsmanager.facebook.com' ? !/^\/adsmanager\/reporting\/view\/?$/.test(u.pathname) : !/^\/ads\/manager\/reporting\/?$/.test(u.pathname)) throw Error('Cần URL báo cáo Meta Ads Manager.');
    connector = 'meta-ads';
    metaReport = identifyMetaReport(u, input);
    from = metaReport.from; to = metaReport.to; campaign = metaReport.filters?.campaignName ?? null;
  } else if (u.hostname === 'adx.admicro.vn') {
    const m = u.pathname.match(/^\/(mobile\/)?vn\/campaign\/detail\/(\d+)\/?$/);
    if (!m) throw Error('Cần link chi tiết campaign Admicro PC hoặc Mobile.');
    connector = m[1] ? 'admicro-mobile' : 'admicro-pc'; campaign=m[2]; device=m[1]?'Mobile':'PC';
    from=u.searchParams.get('fd'); to=u.searchParams.get('td');
  } else if (u.hostname === 'khachhang.24h.com.vn') {
    connector='24h'; from=u.searchParams.get('c_statistic_from_date'); to=u.searchParams.get('c_statistic_to_date');
  } else if (u.hostname === 'news.fptonline.net') {
    if (u.protocol !== 'https:' || u.pathname !== '/api/get-report' || u.search || u.hash) throw Error('Link VnExpress phải là HTTPS https://news.fptonline.net/api/get-report, không có query hoặc fragment.');
    connector='fpt'; from=input.from; to=input.to;
  }
  else throw Error('Hỗ trợ link Meta Ads Manager, Admicro, khachhang.24h.com.vn và news.fptonline.net.');
  from=date(from || input.from); to=date(to || input.to);
  if (from && to && from>to) throw Error('Ngày bắt đầu phải trước ngày kết thúc.');
  if (from && to && (Date.parse(to)-Date.parse(from))/86400000>366) throw Error('Mỗi link tối đa 367 ngày.');
  const reportMonth=month(input.reportMonth || (from ? from.slice(0,7) : null));
  return {url:u.href,query:Object.fromEntries(u.searchParams),connector,source:connector==='meta-ads'?'Meta Ads':connector.startsWith('admicro')?'Admicro':connector==='24h'?'24h':'FPT/VnExpress',campaign,device,account:metaReport?.account||null,metaReport,from,to,reportMonth,name:String(input.name||'').trim().slice(0,150)||`${connector==='fpt'?'FPT/VnExpress':connector} ${campaign||''}`.trim(),needsDates:!from||!to};
}
export function scope(link) { return createHash('sha256').update(JSON.stringify([link.url,link.from,link.to])).digest('hex'); }
export function safeLink(link) {
  const {url,query,...rest}=link;
  if (link.connector === 'google-ads') return {...rest,displayUrl:'Google Ads API'};
  if (link.connector === 'meta-ads') return {...rest,url:undefined,query:undefined,metaReport:link.metaReport,account:link.account,displayUrl:'Meta Ads Manager report'};
  const u=new URL(url);
  return {...rest,displayUrl:u.origin+u.pathname};
}
export function days(from,to) {const result=[];for(let d=Date.parse(from);d<=Date.parse(to);d+=86400000)result.push(new Date(d).toISOString().slice(0,10));return result;}
export const fields=['impressions','clicks','spend','engagement'];
export function total(rows) {
  const out=Object.fromEntries(fields.map(k=>[k,rows.length && rows.every(r=>r[k]!=null)?rows.reduce((a,r)=>a+r[k],0):null]));
  out.ctr=out.impressions && out.clicks!=null?out.clicks/out.impressions*100:null;
  return out;
}
export function reconcile(source, daily) {
  const sum=total(daily); const differences=Object.fromEntries(fields.map(k=>[k,source[k]!=null&&sum[k]!=null?sum[k]-source[k]:null]));
  const comparable=Object.values(differences).filter(v=>v!=null);
  return {dailyTotal:sum,differences,status:!comparable.length?'incomplete':comparable.some(v=>Math.abs(v)>0.01)?'mismatch':'matched'};
}
export function groups(links) {
  const grouped=new Map();
  for(const l of links){const k=JSON.stringify([l.source,l.reportMonth||null,l.from,l.to]);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(l);}
  return [...grouped.values()].map(items=>{
    const campaigns=items.filter(l=>l.campaign).map(l=>`${l.connector}:${l.campaign}`);
    const overlapping=new Set(campaigns).size!==campaigns.length;
    // 24h/FPT links can overlap by placement; no proven common aggregation definition yet.
    const canSum=items[0].source==='Admicro'&&!overlapping;
    return {source:items[0].source,reportMonth:items[0].reportMonth||null,from:items[0].from,to:items[0].to,items,canSum,total:canSum?total(items.map(l=>l.result?.total||{})):total([])};
  });
}

const aggregateFields = ['impressions', 'clicks'];
function aggregateMetrics(rows) {
  const out = Object.fromEntries(aggregateFields.map(key => [key, rows.length && rows.every(row => row?.[key] != null) ? rows.reduce((sum, row) => sum + row[key], 0) : null]));
  out.ctr = out.impressions ? out.clicks == null ? null : out.clicks / out.impressions * 100 : null;
  return out;
}

function aggregateGroupKey(link) {
  return JSON.stringify([link.source || null, link.reportMonth || link.from?.slice?.(0, 7) || null, link.from || null, link.to || null]);
}

function aggregateItemKey(link) {
  return link.campaign ? `${link.connector || ''}:${link.campaign}` : link.scope || `${link.connector || ''}:${link.id || link.name || ''}`;
}

function latestWithResult(items) {
  return [...items].filter(item => item.result).sort((left, right) => String(right.result?.fetchedAt || '').localeCompare(String(left.result?.fetchedAt || '')))[0] || items[0];
}

function dailyForItems(items) {
  const byDate = new Map();
  for (const item of items) for (const row of item.result?.daily || []) {
    if (!row?.date) continue;
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }
  return [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, rows]) => ({ date, ...aggregateMetrics(rows) }));
}

export function aggregateReports(links, { reportMonth = null } = {}) {
  const scopedLinks = reportMonth
    ? (links || []).filter(link => (link.reportMonth || link.from?.slice?.(0, 7)) === reportMonth)
    : (links || []);
  const grouped = new Map();
  for (const link of scopedLinks) {
    const key = aggregateGroupKey(link);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(link);
  }
  const sourceRows = [...grouped.values()].sort((left, right) => {
    const a = aggregateGroupKey(left[0]), b = aggregateGroupKey(right[0]);
    return a < b ? -1 : a > b ? 1 : 0;
  }).map(items => {
    const seen = new Set();
    const distinct = items.filter(item => {
      const key = aggregateItemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const source = items[0].source || 'Không xác định';
    const canSumDistinctCampaigns = source === 'Admicro' && distinct.length > 1 && distinct.every(item => item.campaign);
    const contributors = canSumDistinctCampaigns ? distinct : [latestWithResult(distinct)];
    const totals = contributors.map(item => item.result?.total || {});
    const daily = dailyForItems(contributors);
    return {
      source,
      reportMonth: items[0].reportMonth || items[0].from?.slice?.(0, 7) || null,
      from: items[0].from || null,
      to: items[0].to || null,
      linkCount: items.length,
      snapshotCount: items.filter(item => item.result).length,
      total: aggregateMetrics(totals),
      daily
    };
  });
  const total = aggregateMetrics(sourceRows.map(row => row.total));
  const dailyMap = new Map();
  for (const sourceRow of sourceRows) for (const row of sourceRow.daily) {
    if (!dailyMap.has(row.date)) dailyMap.set(row.date, []);
    dailyMap.get(row.date).push(row);
  }
  const daily = [...dailyMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, rows]) => ({ date, ...aggregateMetrics(rows) }));
  const period = reportMonth || ([...new Set(sourceRows.map(row => row.reportMonth).filter(Boolean))].sort().join(', ') || 'Các tháng đang hiển thị');
  const complete = sourceRows.length > 0 && sourceRows.every(row => row.snapshotCount > 0);
  const result = {
    label: reportMonth ? `Report · Tổng hợp · Tháng ${reportMonth}` : 'Report · Tổng hợp',
    period,
    reportMonth,
    hasSnapshot: sourceRows.some(row => row.snapshotCount > 0),
    complete,
    total,
    sourceRows: sourceRows.map(({ daily: _daily, ...row }) => row),
    sourceGroups: sourceRows.map(({ daily: _daily, ...row }) => row),
    daily,
    dailyTotal: complete ? aggregateMetrics(daily) : aggregateMetrics([])
  };
  return result;
}
