import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildSignHeaders, subtleHmac, subtleSha256Hex } from '../dist/sign.js';

/**
 * 服务端算法 oracle（逐字段复刻 server-go hmac.go）：
 *   msg = METHOD + "\n" + path+query(无 host) + "\n" + ts + "\n" + nonce + "\n" + 原始 body
 *   key = 会话 token 原文；mh_ck_ 客户端密钥 = SHA-256(key) 小写 hex
 *   输出 = HMAC-SHA256 小写 hex
 */
function serverSign(method: string, fullUrl: string, ts: string, nonce: string, rawBody: string, token: string): string {
  const u = new URL(fullUrl);
  const key = token.startsWith('mh_ck_') ? crypto.createHash('sha256').update(token).digest('hex') : token;
  const msg = [method.toUpperCase(), u.pathname + u.search, ts, nonce, rawBody].join('\n');
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

describe('sign（与服务端 hmac.go 对齐）', () => {
  test('nonce 每次全新生成（修复重放 403）', async () => {
    let n = 0;
    const nonce = () => `nonce-${++n}`;
    const h1 = await buildSignHeaders('POST', 'https://x/api', '{"a":1}', 'tok', subtleHmac, subtleSha256Hex, nonce);
    const h2 = await buildSignHeaders('POST', 'https://x/api', '{"a":1}', 'tok', subtleHmac, subtleSha256Hex, nonce);
    assert.equal(h1?.a, 'nonce-1');
    assert.equal(h2?.a, 'nonce-2');
    assert.notEqual(h1?.s, h2?.s);
  });

  test('无 token → null（降级不签名）', async () => {
    const h = await buildSignHeaders('GET', 'https://x/api', '', '', subtleHmac, subtleSha256Hex, () => 'n');
    assert.equal(h, null);
  });

  test('会话 token：签名与服务端 oracle 逐字节一致（含 query）', async () => {
    const h = await buildSignHeaders('POST', 'https://163music.linyu.qzz.io/api/next?preference=random', '{}', 'sess-token-123', subtleHmac, subtleSha256Hex, () => 'fixed-nonce');
    assert.ok(h);
    assert.equal(h.s, serverSign('POST', 'https://163music.linyu.qzz.io/api/next?preference=random', h.t, 'fixed-nonce', '{}', 'sess-token-123'));
    // GET 无 body
    const g = await buildSignHeaders('GET', 'https://163music.linyu.qzz.io/api/me', '', 'sess-token-123', subtleHmac, subtleSha256Hex, () => 'fixed-nonce');
    assert.ok(g);
    assert.equal(g.s, serverSign('GET', 'https://163music.linyu.qzz.io/api/me', g.t, 'fixed-nonce', '', 'sess-token-123'));
  });

  test('mh_ck_ 客户端密钥：SHA-256 派生密钥，与服务端 oracle 一致', async () => {
    const h = await buildSignHeaders('POST', 'https://x/api/play/heartbeat', '{"jobId":"j1"}', 'mh_ck_abc123', subtleHmac, subtleSha256Hex, () => 'n1');
    assert.ok(h);
    assert.match(h!.s, /^[a-f0-9]{64}$/);
    assert.equal(h.s, serverSign('POST', 'https://x/api/play/heartbeat', h.t, 'n1', '{"jobId":"j1"}', 'mh_ck_abc123'));
  });
});
