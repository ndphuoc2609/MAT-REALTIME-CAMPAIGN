import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserRuntimeError, browserLaunchOptions, resolveBrowserExecutable} from '../lib/browser-runtime.mjs';

function fakeStat(existing) {
  return file => {
    if (!existing.has(file)) throw Object.assign(new Error('missing'), {code: 'ENOENT'});
    return {mode: 0o755, isFile: () => true};
  };
}

test('browser resolver prefers a valid CHROME_BIN and reports an invalid override clearly', () => {
  const configured = '/opt/test-browser/chrome';
  assert.equal(resolveBrowserExecutable({platform: 'linux', env: {CHROME_BIN: configured}, stat: fakeStat(new Set([configured]))}), configured);
  assert.throws(
    () => resolveBrowserExecutable({platform: 'darwin', env: {CHROME_BIN: '/tmp/missing-browser'}, stat: fakeStat(new Set())}),
    error => error instanceof BrowserRuntimeError && error.code === 'BROWSER_RUNTIME_CONFIG' && /CHROME_BIN/.test(error.message)
  );
});

test('browser resolver finds standard macOS Chrome paths and otherwise preserves bundled fallback', () => {
  const home = '/Users/fixture';
  const chrome = `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`;
  assert.deepEqual(browserLaunchOptions({platform: 'darwin', home, env: {}, stat: fakeStat(new Set([chrome]))}), {executablePath: chrome});
  assert.equal(resolveBrowserExecutable({platform: 'linux', home, env: {}, stat: fakeStat(new Set([chrome]))}), null);
  assert.deepEqual(browserLaunchOptions({platform: 'linux', home, env: {}, stat: fakeStat(new Set())}), {});
});
