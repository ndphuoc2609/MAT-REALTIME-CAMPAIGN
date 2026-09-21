import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceError } from '../lib/source-error.mjs';
import { classifyJobError } from '../source-app.mjs';

test('classifyJobError preserves known source errors', () => {
  const error = new SourceError('Nguồn yêu cầu đăng nhập.', 'auth_required');
  assert.equal(classifyJobError(error), error);
});

test('classifyJobError reports DATA_DIR permission failures as configuration errors', () => {
  const classified = classifyJobError(Object.assign(new Error('permission denied'), { code: 'EACCES', path: '/data/sessions/24h' }));
  assert.equal(classified.status, 'config_error');
  assert.match(classified.message, /DATA_DIR/);
});

test('classifyJobError reports disk exhaustion as configuration error', () => {
  const classified = classifyJobError(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
  assert.equal(classified.status, 'config_error');
  assert.match(classified.message, /Ổ đĩa/);
});

test('classifyJobError reports browser runtime failures as configuration errors', () => {
  const classified = classifyJobError(new Error('browserType.launch: Executable does not exist at /ms-playwright/chromium'));
  assert.equal(classified.status, 'config_error');
  assert.match(classified.message, /browser runtime/i);
});

test('classifyJobError keeps unknown runtime failures generic', () => {
  const classified = classifyJobError(new Error('unexpected worker failure'));
  assert.equal(classified.status, 'error');
  assert.match(classified.message, /Lỗi runtime/);
});
