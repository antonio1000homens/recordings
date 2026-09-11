import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUploadKey, UPLOAD_URL_EXPIRY_SECONDS } from '../src/upload.mjs';

test('upload URLs expire after 900 seconds', () => {
  assert.equal(UPLOAD_URL_EXPIRY_SECONDS, 900);
});

test('generated upload keys are always scoped under inbox', () => {
  assert.equal(
    buildUploadKey('20260911-2100-test-abcdef12', '../../unsafe name.m4a'),
    'inbox/20260911-2100-test-abcdef12/unsafe name.m4a',
  );
  assert.match(buildUploadKey('abc', 'call.m4a'), /^inbox\//);
});
