import test from 'node:test';
import assert from 'node:assert/strict';
import {identify,scope,days,total,reconcile,groups,safeLink,aggregateReports} from '../lib/links.mjs';
import {validateDisplayName,normalizedName} from '../lib/name-validation.mjs';
import {endpoint24hPath,normalizeTable,normalize24Payload} from '../lib/connectors.mjs';
import {createMemoryPersistence} from './support/memory-persistence.mjs';
const pc='https://adx.admicro.vn/vn/campaign/detail/103592?fd=2026-09-01&td=2026-09-08';
test('display names are required, bounded, and unique after NFC/case/whitespace normalization',()=>{
  const links=[{id:'a',name:' Báo cáo   A '}];
  assert.equal(validateDisplayName(' Báo cáo A ',links,'a'),'Báo cáo A');
  assert.throws(()=>validateDisplayName(' Ba\u0301o cáo\t a ',links),/đã tồn tại/);
  assert.throws(()=>validateDisplayName('',links),/bắt buộc/);
  assert.throws(()=>validateDisplayName('x'.repeat(151),links),/150/);
  assert.equal(normalizedName(' Báo cáo\nA '),normalizedName('Báo cáo A'));
});
test('URL date is authoritative; distinct PC and Mobile; validates exact host',()=>{
  const l=identify({url:pc,from:'2020-01-01',to:'2020-01-02'});assert.equal(l.from,'2026-09-01');assert.equal(l.campaign,'103592');assert.equal(l.device,'PC');
  assert.equal(l.reportMonth,'2026-09');assert.equal(identify({url:pc,reportMonth:'2026-08'}).reportMonth,'2026-08');assert.throws(()=>identify({url:pc,reportMonth:'2026-13'}));
  assert.equal(identify({url:pc.replace('/vn/','/mobile/vn/')}).connector,'admicro-mobile');
  const escaped=identify({url:'https://adx.admicro.vn/mobile/vn/campaign/detail/49891?fd=2026-09-01\\&td=2026-09-30'});
  assert.equal(escaped.connector,'admicro-mobile');assert.equal(escaped.from,'2026-09-01');assert.equal(escaped.to,'2026-09-30');
  assert.throws(()=>identify({url:pc.replace('adx.admicro.vn','adx.admicro.vn.evil.test')}));
  assert.throws(()=>identify({url:pc.replace('2026-09-01','2026-02-30')}));
  assert.equal(days(l.from,l.to).length,8);
});
test('24h dates, FPT missing dates and sensitive URL masking',()=>{
  const l=identify({url:'http://khachhang.24h.com.vn/ocm/lineitem/index/?c_statistic_from_date=07-08-2026&c_statistic_to_date=31-08-2026'});assert.equal(l.from,'2026-08-07');
  const f=identify({url:'https://news.fptonline.net/report/detail-banner-report?token=private'});assert.equal(f.needsDates,true);assert.ok(!JSON.stringify(safeLink(f)).includes('private'));
});
test('24h AJAX endpoint follows the link pathname without mixing report families',()=>{
  const lineitem=identify({url:'http://khachhang.24h.com.vn/ocm/lineitem/index/?c_statistic_from_date=07-08-2026&c_statistic_to_date=31-08-2026'});
  const order=identify({url:'https://khachhang.24h.com.vn/ocm/order/index/?c_statistic_from_date=01-09-2026&c_statistic_to_date=30-09-2026'});
  const ajaxOrder=identify({url:'https://khachhang.24h.com.vn/ocm/ajax/order/index/?c_statistic_from_date=01-09-2026&c_statistic_to_date=30-09-2026'});
  assert.equal(endpoint24hPath(lineitem.url),'/ocm/ajax/lineitem/index/');
  assert.equal(endpoint24hPath(order.url),'/ocm/ajax/order/index/');
  assert.equal(endpoint24hPath(ajaxOrder.url),'/ocm/ajax/order/index/');
  assert.equal(endpoint24hPath('https://khachhang.24h.com.vn/report?c_statistic_from_date=01-09-2026'),'/ocm/ajax/lineitem/index/');
  assert.throws(()=>endpoint24hPath(order.url.replace('khachhang.24h.com.vn','evil.example')),/host đã xác minh/);
});
test('unknown remains null, weighted CTR and range isolation',()=>{
  assert.equal(total([]).clicks,null);assert.equal(total([{clicks:0},{clicks:null}]).clicks,null);
  const a=total([{clicks:1,impressions:10},{clicks:1,impressions:90}]);assert.equal(a.ctr,2);
  assert.equal(groups([{source:'Admicro',from:'2026-09-01',to:'2026-09-08'},{source:'Admicro',from:'2026-09-01',to:'2026-09-07'}]).length,2);
  assert.equal(reconcile({impressions:101,clicks:1},[{impressions:100,clicks:1}]).status,'mismatch');
  assert.equal(reconcile({impressions:101,clicks:1},[{impressions:null,clicks:null}]).status,'incomplete');
});
test('aggregate dashboard groups source ranges, deduplicates links, and calculates weighted totals',()=>{
  const links=[
    {id:'a1',source:'Admicro',connector:'admicro-pc',campaign:'1',reportMonth:'2026-09',from:'2026-09-01',to:'2026-09-30',scope:'a1',result:{total:{impressions:100,clicks:10},daily:[{date:'2026-09-01',impressions:100,clicks:10}]}},
    {id:'a1-duplicate',source:'Admicro',connector:'admicro-pc',campaign:'1',reportMonth:'2026-09',from:'2026-09-01',to:'2026-09-30',scope:'a1-duplicate',result:{total:{impressions:100,clicks:10},daily:[{date:'2026-09-01',impressions:100,clicks:10}]}},
    {id:'a2',source:'Admicro',connector:'admicro-pc',campaign:'2',reportMonth:'2026-09',from:'2026-09-01',to:'2026-09-30',scope:'a2',result:{total:{impressions:50,clicks:5},daily:[{date:'2026-09-01',impressions:50,clicks:5}]}},
    {id:'g',source:'Google Ads',connector:'google-ads',reportMonth:'2026-09',from:'2026-09-01',to:'2026-09-30',scope:'g',result:{total:{impressions:200,clicks:0},daily:[{date:'2026-09-02',impressions:200,clicks:0}]}}
  ];
  const aggregate=aggregateReports(links,{reportMonth:'2026-09'});
  assert.deepEqual(aggregate.total,{impressions:350,clicks:15,ctr:15/350*100});
  assert.deepEqual(aggregate.sourceRows.map(row=>[row.source,row.from,row.to,row.linkCount]),[['Admicro','2026-09-01','2026-09-30',3],['Google Ads','2026-09-01','2026-09-30',1]]);
  assert.deepEqual(aggregate.daily.map(row=>[row.date,row.impressions,row.clicks]),[['2026-09-01',150,15],['2026-09-02',200,0]]);
  assert.deepEqual(aggregate.dailyTotal,{impressions:350,clicks:15,ctr:15/350*100});
});
test('aggregate dashboard preserves zero and unknown metrics and has an empty snapshot state',()=>{
  const aggregate=aggregateReports([
    {id:'zero',source:'Google Ads',reportMonth:'2026-09',from:'2026-09-01',to:'2026-09-30',scope:'zero',result:{total:{impressions:0,clicks:0},daily:[{date:'2026-09-01',impressions:0,clicks:0}]}},
    {id:'unknown',source:'24h',reportMonth:'2026-09',from:'2026-09-01',to:'2026-09-30',scope:'unknown',result:{total:{impressions:10,clicks:null},daily:[{date:'2026-09-01',impressions:10,clicks:null}]}}
  ],{reportMonth:'2026-09'});
  assert.equal(aggregate.total.impressions,10);
  assert.equal(aggregate.total.clicks,null);
  assert.equal(aggregate.total.ctr,null);
  assert.deepEqual(aggregate.dailyTotal,{impressions:10,clicks:null,ctr:null});
  const empty=aggregateReports([{id:'idle',source:'FPT/VnExpress',reportMonth:'2026-09',from:'2026-09-01',to:'2026-09-30'}],{reportMonth:'2026-09'});
  assert.equal(empty.hasSnapshot,false);
  assert.equal(empty.complete,false);
  assert.deepEqual(empty.total,{impressions:null,clicks:null,ctr:null});
});
test('never adds duplicate campaign links or unverified publisher scopes',()=>{
  const l={source:'Admicro',connector:'admicro-pc',campaign:'1',from:'2026-09-01',to:'2026-09-08',result:{total:{clicks:10}}};
  assert.equal(groups([l,{...l}])[0].total.clicks,null);
  const mobile={...l,connector:'admicro-mobile'};assert.equal(groups([l,mobile])[0].total.clicks,20);
  assert.equal(groups([{...l,source:'24h'}])[0].canSum,false);
  assert.equal(groups([l,{...l,reportMonth:'2026-08'}]).length,2);
});
test('snapshot replacement preserves other links and failed jobs; edit isolates old range',()=>{
  const db=createMemoryPersistence().store;
  const a={...identify({url:pc}),id:'a'};a.scope=scope(a);const b={...a,id:'b'};db.put(a);db.put(b);
  const result={total:{clicks:37},complete:true,fetchedAt:'2026-09-08'};
  db.commit(a,result,{id:'j1',status:'success'});db.commit(b,result,{id:'j2',status:'success'});
  db.commit(a,{...result,total:{clicks:40}},{id:'j3',status:'success'});
  assert.equal(db.result(a).total.clicks,40);assert.equal(db.result(b).total.clicks,37);
  db.putJob({id:'j4',status:'error'});assert.equal(db.result(a).total.clicks,40);
  assert.equal(db.result({...a,scope:'new-range'}),null);db.close();
});
test('normalized source total distinct from details; spend not bid; viewers preserved',()=>{
  const r=normalizeTable({headers:['Quảng cáo','Click','Lượt hiển thị','Tiền','Bid','Người xem'],total:['Tổng','37','29,824','184,944','','9,060'],rows:[{id:'1',values:['A','N/A','57','N/A','5000','41']}]});
  assert.equal(r.total.impressions,29824);assert.equal(r.details[0].spend,null);assert.equal(r.details[0].clicks,null);assert.equal(r.total.viewers,9060);
});
test('24h JSON adapter preserves daily rows and unknown metrics',()=>{
  const r=normalize24Payload({data:[{date:'07-09-2026',lineitem_id:'L1',impressions:'1,200',clicks:'12',cost:'4500'},{date:'08-09-2026',lineitem_id:'L1',impressions:'800',clicks:'N/A',cost:'N/A'}],recordsTotal:2});
  assert.equal(r.daily.length,2);assert.equal(r.total.impressions,2000);assert.equal(r.daily[1].clicks,null);assert.equal(r.details[0].creativeId,'L1');
});
test('24h uses c_date and c_sum metrics instead of repeating line-item totals',()=>{
  const rows=[
    {pk_dfp_lineitem:7420810441,c_name:'KMBH',c_start_datetime:'04-09-2026 14:42:00',c_date:'07-09-2026',c_impressions:297885,c_clicks:923,c_sum_impressions:28805,c_sum_clicks:109,c_website:'24H.COM.VN'},
    {pk_dfp_lineitem:7420810441,c_name:'KMBH',c_start_datetime:'04-09-2026 14:42:00',c_date:'08-09-2026',c_impressions:297885,c_clicks:923,c_sum_impressions:114331,c_sum_clicks:313,c_website:'24H.COM.VN'},
    {pk_dfp_lineitem:7420810441,c_name:'KMBH',c_start_datetime:'04-09-2026 14:42:00',c_date:'09-09-2026',c_impressions:297885,c_clicks:923,c_sum_impressions:24162,c_sum_clicks:69,c_website:'24H.COM.VN'}
  ];
  const r=normalize24Payload({data:rows,recordsTotal:3});
  assert.deepEqual(r.daily.map(x=>[x.date,x.impressions,x.clicks]),[['2026-09-07',28805,109],['2026-09-08',114331,313],['2026-09-09',24162,69]]);
  assert.equal(r.total.impressions,167298);assert.equal(r.total.clicks,491);assert.equal(r.details[0].impressions,167298);assert.equal(r.details[0].clicks,491);
});
