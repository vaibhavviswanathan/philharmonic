import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { acceptedContentLength, isValidUploadId, uploadMetaKey, uploadObjectKey } from './uploads';

describe('isValidUploadId', () => {
  it('accepts real ULIDs (either case)', () => {
    const id = ulid();
    expect(isValidUploadId(id)).toBe(true);
    expect(isValidUploadId(id.toLowerCase())).toBe(true);
  });

  it('rejects path traversal and key-suffix injection', () => {
    expect(isValidUploadId('../../other-run/uploads/x')).toBe(false);
    expect(isValidUploadId(`${ulid()}/extra`)).toBe(false);
    expect(isValidUploadId('runs/01J/uploads/01J')).toBe(false);
    // Percent-encoded slash arrives DECODED in the Hono param.
    expect(isValidUploadId('a/b')).toBe(false);
  });

  it('rejects wrong lengths and non-Crockford chars', () => {
    expect(isValidUploadId('')).toBe(false);
    expect(isValidUploadId('01HX'.padEnd(25, '0'))).toBe(false); // 25 chars
    expect(isValidUploadId('0'.repeat(27))).toBe(false); // 27 chars
    // I, L, O, U are excluded from the Crockford alphabet.
    expect(isValidUploadId(`I${'0'.repeat(25)}`)).toBe(false);
    expect(isValidUploadId(`U${'0'.repeat(25)}`)).toBe(false);
  });
});

describe('upload keys', () => {
  it('namespace under the token run', () => {
    expect(uploadMetaKey('run1', 'UP1')).toBe('runs/run1/upload-meta/UP1');
    expect(uploadObjectKey('run1', 'UP1')).toBe('runs/run1/uploads/UP1');
  });
});

describe('acceptedContentLength', () => {
  it('rejects a missing header (unbounded bodies are not allowed)', () => {
    expect(acceptedContentLength(undefined, 100)).toBeNull();
  });

  it('rejects malformed and negative lengths', () => {
    expect(acceptedContentLength('abc', 100)).toBeNull();
    expect(acceptedContentLength('-1', 100)).toBeNull();
  });

  it('enforces the declared cap inclusively', () => {
    expect(acceptedContentLength('100', 100)).toBe(100);
    expect(acceptedContentLength('101', 100)).toBeNull();
    expect(acceptedContentLength('0', 100)).toBe(0);
  });
});
