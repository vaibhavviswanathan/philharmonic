import { describe, expect, it } from 'vitest';
import { RunTokenError, mintRunToken, verifyRunToken } from './runtoken';

const SECRET = 'test-secret-32-bytes-of-entropy!';
const CLAIMS = { runId: 'run_1', taskId: 'task_1', projectId: 'proj_1' };

async function expectCode(promise: Promise<unknown>, code: RunTokenError['code']) {
  await expect(promise).rejects.toSatisfy(
    (err: unknown) => err instanceof RunTokenError && err.code === code,
  );
}

describe('runtoken', () => {
  it('round-trips claims through mint + verify', async () => {
    const token = await mintRunToken(CLAIMS, SECRET);
    const claims = await verifyRunToken(token, SECRET);
    expect(claims).toMatchObject(CLAIMS);
    expect(claims.exp * 1000).toBeGreaterThan(Date.now());
  });

  it('rejects an expired token with code "expired"', async () => {
    const token = await mintRunToken(
      { ...CLAIMS, exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
    );
    await expectCode(verifyRunToken(token, SECRET), 'expired');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintRunToken(CLAIMS, 'some-other-secret');
    await expectCode(verifyRunToken(token, SECRET), 'bad_signature');
  });

  it('rejects a tampered payload', async () => {
    const token = await mintRunToken(CLAIMS, SECRET);
    const [v, payload, sig] = token.split('.') as [string, string, string];
    const forged = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    );
    forged.runId = 'run_EVIL';
    const forgedB64 = Buffer.from(JSON.stringify(forged))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await expectCode(verifyRunToken(`${v}.${forgedB64}.${sig}`, SECRET), 'bad_signature');
  });

  it('rejects a validly-signed payload that is not a claims object', async () => {
    // Same secret, same MAC scheme, wrong shape — must be malformed, not accepted.
    const payload = Buffer.from(JSON.stringify({ hello: 'world' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const message = `v1.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await expectCode(verifyRunToken(`${message}.${sig}`, SECRET), 'malformed');
  });

  it.each([
    ['empty string', ''],
    ['wrong version', 'v2.abc.def'],
    ['too few parts', 'v1.abc'],
    ['too many parts', 'v1.a.b.c'],
    ['garbage base64 signature', 'v1.aGk.!!!not-base64!!!'],
    ['raw garbage', 'Bearer nonsense'],
  ])('rejects malformed input (%s) with a typed error, never a crash', async (_name, token) => {
    await expectCode(verifyRunToken(token, SECRET), 'malformed');
  });
});
