import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateGoogleAdsRows,
  aggregateGoogleAdsDimensionRows,
  collectGoogleAds,
  ensureGoogleAdsMonthlyLinks,
  flattenGoogleAdsRows,
  googleAdsConfig,
  googleAdsMonthBounds,
  googleAdsMonthlyLink,
  GOOGLE_ADS_QUERY,
  GOOGLE_ADS_BREAKDOWN_QUERIES
} from '../lib/google-ads.mjs';
import { collect } from '../lib/connectors.mjs';
import { createApp } from '../source-app.mjs';
import { createMemoryPersistence } from './support/memory-persistence.mjs';

const env = {
  GOOGLE_ADS_CLIENT_ID: 'client-id-fixture',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret-fixture',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token-fixture',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'developer-token-fixture',
  GOOGLE_ADS_CUSTOMER_ID: '661-413-6303',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '135-218-9664'
};

function response(status, payload) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(payload) };
}

test('Google Ads month bounds use exact calendar dates including leap years', () => {
  assert.deepEqual(googleAdsMonthBounds('2024-02'), { month: '2024-02', from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(googleAdsMonthBounds('2026-08'), { month: '2026-08', from: '2026-08-01', to: '2026-08-31' });
  assert.throws(() => googleAdsMonthBounds('2026-13'), /Tháng báo cáo/);
});

test('Google Ads config validates IDs without exposing secret values', () => {
  assert.deepEqual(googleAdsConfig(env), {
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    customerId: '6614136303',
    loginCustomerId: '1352189664'
  });
  assert.throws(() => googleAdsConfig({ ...env, GOOGLE_ADS_REFRESH_TOKEN: '' }), error => {
    assert.equal(error.status, 'config_error');
    assert.equal(error.message.includes('refresh-token-fixture'), false);
    return true;
  });
});

test('Google Ads developer token is optional', () => {
  const withoutDeveloperToken = { ...env };
  delete withoutDeveloperToken.GOOGLE_ADS_DEVELOPER_TOKEN;
  assert.equal(googleAdsConfig(withoutDeveloperToken).developerToken, null);
});

test('SearchStream rows flatten, filter to bounds, aggregate by date, and preserve unknowns', () => {
  const payload = [
    { results: [
      { segments: { date: '2026-08-01' }, metrics: { impressions: '10', clicks: '1' } },
      { segments: { date: '2026-08-01' }, metrics: { impressions: '5', clicks: '2' } },
      { segments: { date: '2026-07-31' }, metrics: { impressions: '99', clicks: '9' } }
    ] },
    { results: [{ segments: { date: '2026-08-02' }, metrics: { impressions: '0', clicks: '0' } }] }
  ];
  assert.equal(flattenGoogleAdsRows(payload).length, 4);
  const result = aggregateGoogleAdsRows(flattenGoogleAdsRows(payload), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(result.daily, [
    { date: '2026-08-01', impressions: 15, clicks: 3, ctr: 20 },
    { date: '2026-08-02', impressions: 0, clicks: 0, ctr: null }
  ]);
  assert.deepEqual(result.total, { impressions: 15, clicks: 3, ctr: 20 });
  const unknown = aggregateGoogleAdsRows([{ segments: { date: '2026-08-03' }, metrics: { impressions: '4' } }], { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(unknown.total.clicks, null);
});

test('Google Ads campaign aggregation splits GDN and SEM while retaining unknown channel types', () => {
  const result = aggregateGoogleAdsRows([
    { segments: { date: '2026-08-01' }, campaign: { advertisingChannelType: 'DISPLAY' }, metrics: { impressions: '10', clicks: '2' } },
    { segments: { date: '2026-08-01' }, campaign: { advertisingChannelType: 'SEARCH' }, metrics: { impressions: '20', clicks: '4' } },
    { segments: { date: '2026-08-02' }, campaign: { advertisingChannelType: 'VIDEO' }, metrics: { impressions: '5', clicks: '1' } },
    { segments: { date: '2026-08-02' }, metrics: { impressions: '3', clicks: '0' } }
  ], { from: '2026-08-01', to: '2026-08-31' });

  assert.deepEqual(result.total, { impressions: 38, clicks: 7, ctr: 7 / 38 * 100 });
  assert.deepEqual(result.channels.gdn.total, { impressions: 10, clicks: 2, ctr: 20 });
  assert.deepEqual(result.channels.gdn.daily, [{ date: '2026-08-01', impressions: 10, clicks: 2, ctr: 20 }]);
  assert.deepEqual(result.channels.sem.total, { impressions: 20, clicks: 4, ctr: 20 });
  assert.deepEqual(result.channels.unknown.VIDEO.total, { impressions: 5, clicks: 1, ctr: 20 });
  assert.deepEqual(result.channels.unknown.UNKNOWN.total, { impressions: 3, clicks: 0, ctr: 0 });
});

test('Google Ads collector performs OAuth and SearchStream with required headers/query', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, { access_token: 'access-token-fixture' });
    const rows = {
      2: [{ segments: { date: '2026-08-31' }, campaign: { advertisingChannelType: 'DISPLAY' }, metrics: { impressions: '7', clicks: '2' } }],
      3: [{ segments: { date: '2026-08-31' }, adGroupCriterion: { keyword: { text: 'SUV', matchType: 'EXACT' } }, metrics: { impressions: '4', clicks: '1' } }],
      4: [{ segments: { date: '2026-08-31' }, adGroupCriterion: { gender: { type: 'MALE' } }, metrics: { impressions: '2', clicks: '1' } }],
      5: [{ segments: { date: '2026-08-31' }, adGroupCriterion: { ageRange: { type: 'AGE_RANGE_25_34' } }, metrics: { impressions: '1', clicks: '0' } }]
    };
    return response(200, [{ results: rows[calls.length] }]);
  };
  const result = await collectGoogleAds(googleAdsMonthlyLink('2026-08'), { env, fetchImpl, now: () => new Date('2026-09-18T00:00:00Z') });
  assert.equal(calls.length, 5);
  assert.equal(calls[0].url, 'https://accounts.google.com/o/oauth2/token');
  assert.equal(calls[1].url, 'https://googleads.googleapis.com/v25/customers/6614136303/googleAds:searchStream');
  assert.equal(calls[1].options.headers.authorization, 'Bearer access-token-fixture');
  assert.equal(calls[1].options.headers['developer-token'], env.GOOGLE_ADS_DEVELOPER_TOKEN);
  assert.equal(calls[1].options.headers['login-customer-id'], '1352189664');
  const queries = calls.slice(1).map(call => JSON.parse(call.options.body).query);
  assert.deepEqual(queries, [
    "SELECT segments.date, campaign.advertising_channel_type, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '2026-08-01' AND '2026-08-31'",
    "SELECT segments.date, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.impressions, metrics.clicks FROM keyword_view WHERE segments.date BETWEEN '2026-08-01' AND '2026-08-31'",
    "SELECT segments.date, ad_group_criterion.gender.type, metrics.impressions, metrics.clicks FROM gender_view WHERE segments.date BETWEEN '2026-08-01' AND '2026-08-31'",
    "SELECT segments.date, ad_group_criterion.age_range.type, metrics.impressions, metrics.clicks FROM age_range_view WHERE segments.date BETWEEN '2026-08-01' AND '2026-08-31'"
  ]);
  for (const query of queries) {
    assert.equal(query.includes('spend'), false);
    assert.equal(query.includes('conversions'), false);
  }
  assert.match(GOOGLE_ADS_QUERY, /segments\.date/);
  assert.deepEqual(Object.keys(GOOGLE_ADS_BREAKDOWN_QUERIES).sort(), ['ages', 'genders', 'keywords']);
  assert.deepEqual(result.total, { impressions: 7, clicks: 2, ctr: 2 / 7 * 100 });
  assert.deepEqual(result.channels.gdn.total, { impressions: 7, clicks: 2, ctr: 2 / 7 * 100 });
  assert.deepEqual(result.channels.sem.total, { impressions: null, clicks: null, ctr: null });
  assert.deepEqual(result.keywords[0], { keyword: 'SUV', matchType: 'EXACT', impressions: 4, clicks: 1, ctr: 25 });
  assert.deepEqual(result.genders[0], { gender: 'MALE', impressions: 2, clicks: 1, ctr: 50 });
  assert.deepEqual(result.ages[0], { ageRange: 'AGE_RANGE_25_34', impressions: 1, clicks: 0, ctr: 0 });
  assert.equal(result.complete, true);
});

test('Google Ads breakdown aggregation deduplicates dimensions, preserves zero/null, and sorts deterministically', () => {
  const rows = [
    { segments: { date: '2026-08-02' }, adGroupCriterion: { keyword: { text: 'zeta', matchType: 'BROAD' } }, metrics: { impressions: '0', clicks: '0' } },
    { segments: { date: '2026-08-01' }, adGroupCriterion: { keyword: { text: 'alpha', matchType: 'EXACT' } }, metrics: { impressions: '3', clicks: '1' } },
    { segments: { date: '2026-08-02' }, adGroupCriterion: { keyword: { text: 'alpha', matchType: 'EXACT' } }, metrics: { impressions: '2', clicks: '0' } },
    { segments: { date: '2026-08-03' }, adGroupCriterion: { keyword: { text: 'alpha', matchType: 'EXACT' } }, metrics: { impressions: '1' } },
    { segments: { date: '2026-08-01' }, adGroupCriterion: { keyword: { text: 'beta', matchType: 'PHRASE' } }, metrics: { impressions: '4', clicks: '2' } },
    { segments: { date: '2026-08-04' }, adGroupCriterion: { keyword: { text: 'outside', matchType: 'EXACT' } }, metrics: { impressions: '99', clicks: '9' } }
  ];
  assert.deepEqual(aggregateGoogleAdsDimensionRows(rows, 'keywords', { from: '2026-08-01', to: '2026-08-03' }), [
    { keyword: 'alpha', matchType: 'EXACT', impressions: 6, clicks: null, ctr: null },
    { keyword: 'beta', matchType: 'PHRASE', impressions: 4, clicks: 2, ctr: 50 },
    { keyword: 'zeta', matchType: 'BROAD', impressions: 0, clicks: 0, ctr: null }
  ]);
  assert.deepEqual(aggregateGoogleAdsDimensionRows([
    { segments: { date: '2026-08-01' }, adGroupCriterion: { gender: { type: 'FEMALE' } }, metrics: { impressions: '2', clicks: '1' } },
    { segments: { date: '2026-08-01' }, adGroupCriterion: { gender: { type: 'MALE' } }, metrics: { impressions: '2', clicks: '0' } }
  ], 'genders', { from: '2026-08-01', to: '2026-08-31' }).map(row => row.gender), ['FEMALE', 'MALE']);
});

test('Google Ads omits the developer-token header when it is not configured', async () => {
  const withoutDeveloperToken = { ...env };
  delete withoutDeveloperToken.GOOGLE_ADS_DEVELOPER_TOKEN;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(200, { access_token: 'access-token-fixture' });
    return response(200, []);
  };
  await collectGoogleAds(googleAdsMonthlyLink('2026-08'), { env: withoutDeveloperToken, fetchImpl });
  assert.equal(Object.hasOwn(calls[1].options.headers, 'developer-token'), false);
});

test('Google Ads retries bounded transient responses and bypasses browser/profile collection', async () => {
  let calls = 0;
  await assert.rejects(collect(googleAdsMonthlyLink('2026-08'), {
    env,
    retryBudget: 2,
    retryDelayMs: 0,
    browser: { launchPersistentContext: async () => { throw new Error('browser must not start'); } },
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response(200, { access_token: 'access-token-fixture' });
      return response(503, { error: 'redacted fixture body' });
    }
  }), error => {
    assert.equal(error.status, 'network_error');
    assert.match(error.message, /tạm thời không khả dụng/);
    assert.equal(error.message.includes('redacted fixture body'), false);
    return true;
  });
  assert.equal(calls, 4);
});

test('empty successful Google result is complete but keeps metrics unknown', async () => {
  let calls = 0;
  const result = await collectGoogleAds(googleAdsMonthlyLink('2026-08'), {
    env,
    fetchImpl: async (_url, options) => {
      calls++;
      return calls === 1 ? response(200, { access_token: 'access-token-fixture' }) : response(200, []);
    }
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.total, { impressions: null, clicks: null, ctr: null });
  assert.deepEqual(result.daily, []);
  assert.match(result.warnings[0], /không có dòng dữ liệu/);
});

test('monthly Google sources are deterministic, include requested/current/existing months, and deduplicate', async () => {
  const links = new Map();
  const store = {
    async list() { return [...links.values()]; },
    async put(link) { links.set(link.id, structuredClone(link)); }
  };
  await store.put({ id: 'existing', reportMonth: '2026-08', connector: 'admicro-pc' });
  const first = await ensureGoogleAdsMonthlyLinks(store, { requestedMonth: '2026-07', now: new Date('2026-09-18T00:00:00Z') });
  assert.deepEqual(first.created.map(link => link.reportMonth), ['2026-07', '2026-08', '2026-09']);
  assert.equal(first.created.filter(link => link.connector === 'google-ads').length, 3);
  const second = await ensureGoogleAdsMonthlyLinks(store, { requestedMonth: '2026-07', now: new Date('2026-09-18T00:00:00Z') });
  assert.deepEqual(second.created, []);
  assert.equal(googleAdsMonthlyLink('2026-08').id, 'google-ads-2026-08');
  assert.equal(googleAdsMonthlyLink('2026-08').scope, googleAdsMonthlyLink('2026-08').scope);
});

test('monthly source materialization is local and does not invoke fetch', async () => {
  const links = new Map();
  const store = {
    async list() { return [...links.values()]; },
    async put(link) { links.set(link.id, structuredClone(link)); }
  };
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('GET must not call provider'); };
  try {
    await ensureGoogleAdsMonthlyLinks(store, { requestedMonth: '2026-10', now: new Date('2026-09-18T00:00:00Z') });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
  assert.deepEqual([...links.values()].map(link => link.reportMonth), ['2026-09', '2026-10']);
});

test('Google Ads detail UI contract renders three breakdown tables without campaign detail', () => {
  const source = readFileSync(new URL('../public/links.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/links.css', import.meta.url), 'utf8');
  const start = source.indexOf('const googleAdsLabels=');
  const end = source.indexOf('function renderDetail', start);
  assert.ok(start >= 0 && end > start);
  const googleDetail = source.slice(start, end);
  assert.match(googleDetail, /renderGoogleAdsBreakdown\('Theo từ khóa',r\.keywords,'keyword'\)/);
  assert.match(googleDetail, /renderGoogleAdsBreakdown\('Theo giới tính',r\.genders,'gender'\)/);
  assert.match(googleDetail, /renderGoogleAdsBreakdown\('Theo độ tuổi',r\.ages,'age'\)/);
  assert.match(googleDetail, /renderGoogleAdsChannelSummary\(r\.channels\)/);
  assert.match(googleDetail, /data-channel="\$\{key\}"/);
  assert.match(googleDetail, /renderCard\('gdn','GDN',channels\.gdn\)/);
  assert.match(googleDetail, /renderCard\('sem','SEM',channels\.sem\)/);
  assert.match(googleDetail, /google-ads-channel-heading/);
  assert.match(googleDetail, /google-ads-channel-metrics/);
  assert.equal((googleDetail.match(/class="google-ads-channel-metric"/g)||[]).length, 3);
  assert.match(styles, /\.google-ads-channel-cards \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.google-ads-channel-metrics \{[^}]*display: grid/);
  assert.match(styles, /\.google-ads-channel-metrics \{[^}]*repeat\(auto-fit, minmax\(100px, 1fr\)\)/);
  assert.match(googleDetail, /Từ khóa/);
  assert.match(googleDetail, /Giới tính/);
  assert.match(googleDetail, /Độ tuổi/);
  assert.doesNotMatch(googleDetail, /Kiểu khớp/);
  assert.doesNotMatch(googleDetail, /Chi tiết quảng cáo/);
});

test('aggregate dashboard UI renders the highlighted first card and report sections', () => {
  const source = readFileSync(new URL('../public/links.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../public/links.css', import.meta.url), 'utf8');
  assert.match(source, /data-action="aggregate"/);
  assert.match(source, /aria-label="Mở báo cáo ADs tổng hợp"/);
  const cardStart = source.indexOf('function renderAggregateCard');
  const cardEnd = source.indexOf('\nfunction render', cardStart + 1);
  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  const card = source.slice(cardStart, cardEnd);
  assert.match(card, /class="card source-card aggregate-card/);
  assert.match(card, /selected==='__aggregate__'/);
  assert.match(card, /aggregate-card-kicker">Report · Tổng hợp/);
  assert.match(card, /source-card-title aggregate-card-title">ADs/);
  assert.match(card, /aggregate-card-kpis source-card-kpis/);
  assert.match(card, /aggregate-card-actions"><button type="button" class="quiet source-card-detail" data-action="aggregate">Xem chi tiết<\/button>/);
  assert.equal((card.match(/<button\b/g)||[]).length, 1);
  assert.match(styles, /#cards \.aggregate-card \{[^}]*border-left: 4px solid var\(--mat-accent\)/);
  assert.match(styles, /\.aggregate-card-actions \.source-card-detail \{[^}]*width: 100%; flex: 1 1 100%/);
  assert.match(source, /innerHTML=renderAggregateCard\(state\.aggregate\|\|\{\}\)\+sourceCards/);
  assert.match(source, /selected='__aggregate__';\$\('#detail'\)\.hidden=false/);
  const start = source.indexOf('function renderAggregateDetail');
  const end = source.indexOf('function renderAggregateCard', start);
  assert.ok(start >= 0 && end > start);
  const detail = source.slice(start, end);
  assert.match(detail, /const sourceBreakdown=currentUser\?\.role==='admin'\?/);
  assert.match(detail, /\$\{sourceBreakdown\}/);
  assert.match(detail, /Tổng hợp theo nguồn và khoảng ngày/);
  assert.match(detail, /Tổng hợp theo ngày/);
  assert.match(detail, /Chưa có snapshot/);
});

test('viewer source cards keep report metrics, hide operations, and use ADs labels', () => {
  const source = readFileSync(new URL('../public/links.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/links.html', import.meta.url), 'utf8');
  const renderStart = source.indexOf('function render(){');
  const renderEnd = source.indexOf('const reportHeads=', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /const viewerKpis=admin\?'':/);
  assert.match(render, /l\.result\?\.total\?\.impressions/);
  assert.match(render, /l\.result\?\.total\?\.clicks/);
  assert.match(render, /l\.result\?\.total\?\.ctr/);
  assert.match(render, /const sourceCardOperations=admin\?`<span class="status source-card-status/);
  assert.match(render, /sourceCardOperations\}<div class="actions source-card-actions"/);
  assert.match(render, /source-card-message/);
  assert.match(render, /source-card-updated/);
  assert.match(render, /Đang giữ dữ liệu lần trước hoặc dữ liệu cần đối soát/);
  assert.match(source, /aria-label="Mở báo cáo ADs tổng hợp"/);
  assert.match(source, /aggregate-card-title">ADs/);
  assert.match(html, /class="panel summary-panel admin-only" hidden/);
  assert.match(source, /const technicalHint=currentUser\?\.role==='admin'\?/);
});

test('HTTP routes materialize, filter, enqueue, and snapshot one monthly Google source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'admicro-google-route-test-'));
  const persistence = createMemoryPersistence();
  const password = 'correct horse battery staple';
  const admin = persistence.auth.createUser('google.route.admin', password, 'admin', { bootstrap: true });
  const viewer = persistence.auth.createUser('google.route.viewer', password, 'viewer');
  const collected = [];
  const app = createApp({
    directory,
    schedulerMinutes: 0,
    now: () => new Date('2026-09-18T00:00:00.000Z'),
    persistence,
    collector: async link => {
      collected.push(link);
      return {
        total: { impressions: 31, clicks: 3, ctr: 3 / 31 * 100 },
        daily: [{ date: link.from, impressions: 31, clicks: 3, ctr: 3 / 31 * 100 }],
        dailyDetails: [], details: [], warnings: [], complete: true,
        reconciliation: { status: 'matched' }, fetchedAt: '2026-09-18T00:00:00.000Z'
      };
    }
  });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  async function login(username) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
  }
  async function request(identity, path, method = 'GET') {
    const headers = { cookie: identity.cookie, origin: base };
    if (method !== 'GET') headers['x-csrf-token'] = identity.csrf;
    const response = await fetch(`${base}${path}`, { method, headers });
    return { response, data: await response.json() };
  }
  try {
    const adminIdentity = await login(admin.username);
    const viewerIdentity = await login(viewer.username);
    const initial = await request(adminIdentity, '/api/links?month=2026-08');
    assert.equal(initial.response.status, 200);
    assert.equal(initial.data.links.length, 1);
    assert.partialDeepStrictEqual(initial.data.links[0], {
      connector: 'google-ads', reportMonth: '2026-08', from: '2026-08-01', to: '2026-08-31'
    });
    assert.equal(initial.data.aggregate.label, 'Report · Tổng hợp · Tháng 2026-08');
    assert.equal(initial.data.aggregate.hasSnapshot, false);
    assert.equal((await request(viewerIdentity, '/api/links?month=2026-08')).data.links.length, 0);
    assert.equal((await request(viewerIdentity, '/api/links?month=2026-08')).data.aggregate.hasSnapshot, false);

    const queued = await request(adminIdentity, '/api/links/collect-all?month=2026-08', 'POST');
    assert.equal(queued.response.status, 202);
    assert.equal(queued.data.jobs.length, 1);
    assert.equal(queued.data.jobs[0].linkId, initial.data.links[0].id);
    for (let attempt = 0; attempt < 100; attempt++) {
      const jobs = await persistence.store.jobs();
      if (jobs.length === 1 && !['queued', 'running'].includes(jobs[0].status)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const links = await persistence.store.list();
    assert.deepEqual(links.filter(link => link.connector === 'google-ads').map(link => link.reportMonth).sort(), ['2026-08', '2026-09']);
    assert.equal(collected.length, 1);
    assert.equal(persistence.store.snapshotCount(), 1);
    const after = await request(adminIdentity, '/api/links?month=2026-08');
    assert.equal(after.data.links.length, 1);
    assert.equal(after.data.links[0].result.total.impressions, 31);
    assert.deepEqual(after.data.aggregate.total, { impressions: 31, clicks: 3, ctr: 3 / 31 * 100 });
  } finally {
    await app.close();
  }
});
