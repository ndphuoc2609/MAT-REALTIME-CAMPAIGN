import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identify, safeLink } from '../lib/links.mjs';
import { metaAdsConfig } from '../lib/config.mjs';
import { aggregateMetaAdsRows, collectMetaAds } from '../lib/meta-ads.mjs';
import { collect } from '../lib/connectors.mjs';
import { SourceError } from '../lib/source-error.mjs';

const filterSet = [
  ['had_delivery-STRING', 'EQUAL', '"1"'],
  ['campaign_name-STRING', 'CONTAIN', '"KMBH T9/2026"'],
  ['objective-STRING_SET', 'IN', '["OUTCOME_ENGAGEMENT"]']
].map(record => record.join('\u001e')).join('\u001d');
const filterSetWithoutObjective = [
  ['had_delivery-STRING', 'EQUAL', '"1"'],
  ['campaign_name-STRING', 'CONTAIN', '"KMBH T9/2026"']
].map(record => record.join('\u001e')).join('\u001d');

function reportUrl({ account = '1471632638071001', filters = filterSet, range = '2026-09-01_2026-10-01,', path = '/adsmanager/reporting/view' } = {}) {
  const query = new URLSearchParams({ act: account, breakdowns: 'days_1', metrics: 'clicks,impressions,ctr', time_range: range, filter_set: filters });
  return `https://adsmanager.facebook.com${path}?${query}`;
}

function link(overrides) {
  return identify({ url: reportUrl(overrides), name: 'Meta September report' });
}

const env = { META_ACCESS_TOKEN: 'server-side-secret', META_AD_ACCOUNT_ID: '1471632638071001' };
const response = (status, payload) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(payload) });

test('recognizes exact Ads Manager report definition and hides URL query from preview', () => {
  const parsed = link();
  assert.equal(parsed.connector, 'meta-ads');
  assert.equal(parsed.account, '1471632638071001');
  assert.equal(parsed.from, '2026-09-01');
  assert.equal(parsed.to, '2026-10-01');
  assert.equal(parsed.metaReport.metrics.join(','), 'clicks,impressions,ctr');
  assert.deepEqual(parsed.metaReport.filters, {
    campaignName: 'KMBH T9/2026', campaignOperator: 'CONTAIN', objective: ['OUTCOME_ENGAGEMENT'], hadDelivery: '1'
  });
  const preview = safeLink(parsed);
  assert.equal(preview.displayUrl, 'Meta Ads Manager report');
  assert.equal(preview.url, undefined);
  assert.equal(JSON.stringify(preview).includes('filter_set'), false);
  assert.equal(JSON.stringify(preview).includes('access_token'), false);
});

test('accepts the exact two-filter Ads Manager URL and collects without an objective predicate', async () => {
  const parsed = link({ filters: filterSetWithoutObjective });
  assert.equal(parsed.from, '2026-09-01');
  assert.equal(parsed.to, '2026-10-01');
  assert.deepEqual(parsed.metaReport.metrics, ['clicks', 'impressions', 'ctr']);
  assert.deepEqual(parsed.metaReport.filters, {
    campaignName: 'KMBH T9/2026', campaignOperator: 'CONTAIN', objective: null, hadDelivery: '1'
  });

  let requestedFiltering;
  const result = await collect(parsed, {
    env,
    now: () => new Date('2026-10-02T00:00:00Z'),
    fetchImpl: async url => {
      requestedFiltering = JSON.parse(new URL(url).searchParams.get('filtering'));
      return response(200, { data: [{ date_start: '2026-09-01', campaign_name: 'KMBH T9/2026', impressions: '100', clicks: '4' }] });
    }
  });
  assert.deepEqual(requestedFiltering, [{ field: 'campaign.name', operator: 'CONTAIN', value: 'KMBH T9/2026' }]);
  assert.match(result.viewerDefinition, /campaign_name CONTAIN/);
  assert.doesNotMatch(result.viewerDefinition, /objective/);
  assert.deepEqual(result.daily, [{ date: '2026-09-01', impressions: 100, clicks: 4, ctr: 4 }]);
});

test('parses reusable campaign/objective filters and rejects altered or unsupported definitions', () => {
  const reusable = filterSet
    .replace('KMBH T9/2026', 'Winter Sale')
    .replace('OUTCOME_ENGAGEMENT', 'OUTCOME_SALES');
  assert.equal(link({ filters: reusable }).metaReport.filters.campaignName, 'Winter Sale');
  assert.deepEqual(link({ filters: reusable }).metaReport.filters.objective, ['OUTCOME_SALES']);
  assert.throws(() => link({ path: '/ads/manager/reporting/view' }), /URL báo cáo/);
  assert.throws(() => link({ range: '2026-09-01_2026-10-01,,' }), /khoảng ngày/);
  assert.throws(() => link({ filters: `${filterSet}\u001dspend-STRING\u001eGREATER_THAN\u001e0` }), /chưa được hỗ trợ/);
  assert.throws(() => link({ filters: `${filterSetWithoutObjective}\u001dcampaign_name-STRING\u001eCONTAIN\u001e"duplicate"` }), /đúng một giá trị/);
  assert.throws(() => link({ filters: `${filterSetWithoutObjective}\u001dspend-STRING\u001eEQUAL\u001e"1"` }), /chưa được hỗ trợ/);
  assert.throws(() => link({ filters: filterSet.replace('CONTAIN', 'EQUAL') }), /campaign_name/);
  assert.throws(() => link({ filters: filterSet.replace('objective-STRING_SET', 'objective-STRING') }), /objective/);
  assert.throws(() => identify({ url: reportUrl() + '&access_token=secret' }), /không được chứa thông tin xác thực/);
});

test('Meta config defaults to current Graph version, normalizes act_ account, and validates configuration', () => {
  assert.deepEqual(metaAdsConfig({ META_ACCESS_TOKEN: ' token ', META_AD_ACCOUNT_ID: 'act_1471632638071001' }), {
    accessToken: 'token', accountId: '1471632638071001', graphVersion: 'v26.0'
  });
  assert.equal(metaAdsConfig({ ...env, META_GRAPH_VERSION: 'v27.1' }).graphVersion, 'v27.1');
  assert.throws(() => metaAdsConfig({ META_ACCESS_TOKEN: 'x', META_AD_ACCOUNT_ID: 'abc' }), /META_AD_ACCOUNT_ID/);
  assert.throws(() => metaAdsConfig({ ...env, META_GRAPH_VERSION: '26.0' }), /META_GRAPH_VERSION/);
});

test('aggregates campaign rows per source date with weighted CTR and preserves null versus zero', () => {
  const aggregated = aggregateMetaAdsRows([
    { date_start: '2026-09-02', impressions: '100', clicks: '2' },
    { date_start: '2026-09-02', impressions: '300', clicks: '0' },
    { date_start: '2026-09-03', impressions: '0', clicks: '0' }
  ], { from: '2026-09-01', to: '2026-10-01' });
  assert.deepEqual(aggregated.daily, [
    { date: '2026-09-02', impressions: 400, clicks: 2, ctr: 0.5 },
    { date: '2026-09-03', impressions: 0, clicks: 0, ctr: null }
  ]);
  assert.deepEqual(aggregated.total, { impressions: 400, clicks: 2, ctr: 0.5 });
  assert.equal(aggregateMetaAdsRows([{ date_start: '2026-09-02', impressions: '10', clicks: null }]).total.clicks, null);
  assert.throws(() => aggregateMetaAdsRows([{ date_start: '2026-10-02', impressions: '1', clicks: '0' }], { from: '2026-09-01', to: '2026-10-01' }), /ngày ngoài khoảng/);
});

test('queries the configured account and filters, paginates safely, applies delivered rows, and dispatches manually', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (calls.length === 1) return response(200, {
      data: [
        { date_start: '2026-09-01', campaign_name: 'Winter Sale A', impressions: '100', clicks: '4' },
        { date_start: '2026-09-01', campaign_name: 'Winter Sale B', impressions: '100', clicks: '0' },
        { date_start: '2026-09-01', campaign_name: 'Winter Sale C', impressions: '0', clicks: '0' }
      ], paging: { next: 'https://graph.facebook.com/v26.0/act_1471632638071001/insights?after=page2&access_token=must-not-be-forwarded' }
    });
    return response(200, { data: [{ date_start: '2026-09-02', campaign_name: 'Winter Sale D', impressions: '200', clicks: '2' }] });
  };
  const parsed = link({ filters: filterSet.replace('KMBH T9/2026', 'Winter Sale').replace('OUTCOME_ENGAGEMENT', 'OUTCOME_SALES') });
  const result = await collect(parsed, { env, fetchImpl, now: () => new Date('2026-10-02T00:00:00Z') });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/v26.0/act_1471632638071001/insights');
  assert.equal(calls[0].options.headers.authorization, 'Bearer server-side-secret');
  assert.equal(calls[0].url.searchParams.get('time_increment'), '1');
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('time_range')), { since: '2026-09-01', until: '2026-10-01' });
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('filtering')), [
    { field: 'campaign.name', operator: 'CONTAIN', value: 'Winter Sale' },
    { field: 'campaign.objective', operator: 'IN', value: ['OUTCOME_SALES'] }
  ]);
  assert.equal(calls[1].url.searchParams.has('access_token'), false);
  assert.deepEqual(result.daily, [
    { date: '2026-09-01', impressions: 200, clicks: 4, ctr: 2 },
    { date: '2026-09-02', impressions: 200, clicks: 2, ctr: 1 }
  ]);
  assert.equal(result.total.ctr, 1.5);
  assert.equal(result.timezone, null);
  assert.equal(result.complete, true);
});

test('retries transient HTTP errors with a bound and classifies Graph auth, access, schema and account failures', async () => {
  let calls = 0;
  const retryResult = await collectMetaAds(link(), {
    env, maxRetries: 1, sleep: async () => {},
    fetchImpl: async () => ++calls === 1 ? response(503, { error: { message: 'private provider detail' } }) : response(200, { data: [] })
  });
  assert.equal(calls, 2);
  assert.equal(retryResult.complete, true);
  assert.equal(retryResult.total.clicks, null);
  let graphCalls = 0;
  await collectMetaAds(link(), {
    env, maxRetries: 1, sleep: async () => {},
    fetchImpl: async () => ++graphCalls === 1 ? response(200, { error: { code: 2 } }) : response(200, { data: [] })
  });
  assert.equal(graphCalls, 2);
  let networkCalls = 0;
  await collectMetaAds(link(), {
    env, maxRetries: 1, sleep: async () => {},
    fetchImpl: async () => { if (++networkCalls === 1) throw Object.assign(Error('socket reset'), { code: 'ECONNRESET' }); return response(200, { data: [] }); }
  });
  assert.equal(networkCalls, 2);
  await assert.rejects(collectMetaAds(link(), { env: { ...env, META_AD_ACCOUNT_ID: '999999999' }, fetchImpl: async () => { throw Error('should not call'); } }), error => error instanceof SourceError && error.status === 'config_error');
  await assert.rejects(collectMetaAds(link(), { env: {}, fetchImpl: async () => { throw Error('should not call'); } }), error => error instanceof SourceError && error.status === 'config_error');
  await assert.rejects(collectMetaAds(link(), { env, fetchImpl: async () => response(400, { error: { code: 190, message: 'private token detail' } }) }), error => error instanceof SourceError && error.status === 'auth_required' && !error.message.includes('private'));
  await assert.rejects(collectMetaAds(link(), { env, fetchImpl: async () => response(403, { error: { code: 10 } }) }), error => error.status === 'access_denied');
  await assert.rejects(collectMetaAds(link(), { env, fetchImpl: async () => response(200, { data: {} }) }), error => error.status === 'schema_error');
  await assert.rejects(collectMetaAds(link(), { env, fetchImpl: async () => response(200, { data: [{ date_start: '2026-09-01', clicks: '1', impressions: null }] }) }), error => error.status === 'schema_error');
  await assert.rejects(collectMetaAds(link(), { env, fetchImpl: async () => response(200, { data: [], paging: { next: 'https://evil.test/v26.0/page' } }) }), error => error.status === 'schema_error');
});

test('detail renderer shows daily Meta metrics without an empty creative table', () => {
  const source = readFileSync(new URL('../public/links.js', import.meta.url), 'utf8');
  const renderer = source.slice(source.indexOf('function renderMetaAdsDetail'), source.indexOf('function renderDetail'));
  assert.match(renderer, /Báo cáo theo ngày/);
  assert.match(renderer, /r\.daily/);
  assert.doesNotMatch(renderer, /creative-table|Creative \/ Vị trí/);
  assert.match(source, /l\.connector==='meta-ads'\)html\+=renderMetaAdsDetail\(r\)/);
  assert.match(source, /const sessionAction=l\.connector==='meta-ads'\?'':/);
  assert.match(source, /data-action="collect"/);
  assert.match(source, /data-action="edit"/);
  assert.match(source, /data-action="delete"/);
});
