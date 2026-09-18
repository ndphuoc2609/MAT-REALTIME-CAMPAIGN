import {homedir} from 'node:os';
import {basename, join} from 'node:path';
import {statSync} from 'node:fs';

export class BrowserRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserRuntimeError';
    this.code = 'BROWSER_RUNTIME_CONFIG';
  }
}

const macBrowserPaths = home => [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  join(home, 'Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium')
];

function executableFile(file, stat = statSync) {
  try {
    const info = stat(file);
    return Boolean(info?.isFile?.() && (info.mode & 0o111));
  } catch {
    return false;
  }
}

/**
 * Resolve the browser binary without forcing Playwright's bundled browser.
 * Returning null is intentional: Linux/Docker can continue using Playwright's
 * normal bundled executable when no system browser is available.
 */
export function resolveBrowserExecutable({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  stat = statSync
} = {}) {
  const configured = String(env.CHROME_BIN || '').trim();
  if (configured) {
    if (!executableFile(configured, stat)) {
      throw new BrowserRuntimeError(`CHROME_BIN không tồn tại hoặc không có quyền thực thi: ${basename(configured)}`);
    }
    return configured;
  }
  if (platform !== 'darwin') return null;
  return macBrowserPaths(home).find(candidate => executableFile(candidate, stat)) || null;
}

export function browserLaunchOptions(options = {}) {
  const executablePath = resolveBrowserExecutable(options);
  return executablePath ? {executablePath} : {};
}

