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
export function identify(input) {
  // Markdown/chat clients sometimes escape query separators as `\&`. Clean
  // only that transport artefact; keep backslashes in every other URL part.
  const inputUrl = String(input?.url ?? '').trim().replace(/\\&/g, '&');
  let u; try { u = new URL(inputUrl); } catch { throw Error('Hãy nhập URL đầy đủ.'); }
  if (!['https:','http:'].includes(u.protocol) || u.username || u.password) throw Error('URL không hợp lệ.');
  let connector, campaign = null, device = null, from, to;
  if (u.hostname === 'adx.admicro.vn') {
    const m = u.pathname.match(/^\/(mobile\/)?vn\/campaign\/detail\/(\d+)\/?$/);
    if (!m) throw Error('Cần link chi tiết campaign Admicro PC hoặc Mobile.');
    connector = m[1] ? 'admicro-mobile' : 'admicro-pc'; campaign=m[2]; device=m[1]?'Mobile':'PC';
    from=u.searchParams.get('fd'); to=u.searchParams.get('td');
  } else if (u.hostname === 'khachhang.24h.com.vn') {
    connector='24h'; from=u.searchParams.get('c_statistic_from_date'); to=u.searchParams.get('c_statistic_to_date');
  } else if (u.hostname === 'news.fptonline.net') { connector='fpt'; }
  else throw Error('Hỗ trợ link Admicro, khachhang.24h.com.vn và news.fptonline.net.');
  from=date(from || input.from); to=date(to || input.to);
  if (from && to && from>to) throw Error('Ngày bắt đầu phải trước ngày kết thúc.');
  if (from && to && (Date.parse(to)-Date.parse(from))/86400000>366) throw Error('Mỗi link tối đa 367 ngày.');
  const reportMonth=month(input.reportMonth || (from ? from.slice(0,7) : null));
  return {url:u.href,query:Object.fromEntries(u.searchParams),connector,source:connector.startsWith('admicro')?'Admicro':connector==='24h'?'24h':'FPT/VnExpress',campaign,device,from,to,reportMonth,name:String(input.name||'').trim().slice(0,150)||`${connector} ${campaign||''}`.trim(),needsDates:!from||!to};
}
export function scope(link) { return createHash('sha256').update(JSON.stringify([link.url,link.from,link.to])).digest('hex'); }
export function safeLink(link) {
  const {url,query,...rest}=link;
  if (link.connector === 'google-ads') return {...rest,displayUrl:'Google Ads API'};
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
