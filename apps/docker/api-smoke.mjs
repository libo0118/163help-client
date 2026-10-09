import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { callSignedApi, normalizeMe } from './src/api.ts';

const credential = 'mh_ck_' + crypto.randomBytes(16).toString('hex');
const received = [];
let validationError;
const server = http.createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, 'Bearer ' + credential);
    assert.equal(req.headers['x-music-helper-version'], '5.1.0');
    assert.match(req.headers['x-nonce'], /^[a-f0-9]{32}$/);
    const canonical = [req.method, req.url, req.headers['x-timestamp'], req.headers['x-nonce'], body].join('\n');
    const key = crypto.createHash('sha256').update(credential).digest('hex');
    assert.equal(req.headers['x-signature'], crypto.createHmac('sha256', key).update(canonical).digest('hex'));
    received.push({ method: req.method, body });
    res.writeHead(req.url === '/api/rejected' ? 403 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/rejected' ? { error: 'invalid_signature' } : { ok: true }));
  } catch (e) { validationError = e; res.writeHead(500); res.end('{}'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await callSignedApi('GET', base + '/api/me?test=1', undefined, credential)).status, 200);
  assert.equal((await callSignedApi('POST', base + '/api/next', { detail: '中文正文' }, credential)).status, 200);
  const rejected = await callSignedApi('GET', base + '/api/rejected', undefined, credential);
  assert.equal(rejected.status, 403); assert.equal(rejected.error, 'invalid_signature');
  assert.equal(received[0].body, ''); assert.deepEqual(JSON.parse(received[1].body), { detail: '中文正文' });
  assert.equal(validationError, undefined);
  assert.deepEqual(normalizeMe({ user: { displayName: 'test' }, participant: { available_credits: 12, help_seconds_used: 5, help_seconds_limit: 100, received_finished_count_24h: 2, today_received_limit: 26 } }), { displayName: 'test', credits: 12, helpedToday: 5, helpedLimit: 100, receivedToday: 2, receivedLimit: 26 });
  console.log('PASS: signed GET/query/Unicode POST, version, preserved API errors and account normalization');
} finally { server.closeAllConnections(); server.close(); }
