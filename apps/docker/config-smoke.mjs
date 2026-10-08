import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createStatusServer, parseAccountConfig } from './src/server.ts';

process.env.UI_PASSWORD = randomBytes(24).toString('hex');
let saved;
const state = { startedAt: Date.now(), logs: [], configured: false, onConfig: c => { saved = c; state.configured = Boolean(c.clientKey); } };
const server = createStatusServer({ port: 0, state });
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  let r = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  assert.equal(r.status, 401);
  r = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ password: process.env.UI_PASSWORD }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const post = value => fetch(base + '/api/config', { method: 'POST', headers: { cookie }, body: JSON.stringify(value) });
  assert.equal((await post({ cookie: '', key: 'wrong' })).status, 400);
  assert.equal(saved, undefined);
  assert.equal((await post({ cookie: 'MUSIC_U=test; __csrf=test', key: 'mh_ck_test' })).status, 200);
  assert.deepEqual(saved, { neteaseCookie: 'MUSIC_U=test; __csrf=test', clientKey: 'mh_ck_test' });
  r = await fetch(base + '/api/state', { headers: { cookie } });
  assert.equal((await r.json()).configured, true);
  assert.equal((await post({ clear: true })).status, 200);
  assert.deepEqual(saved, { neteaseCookie: '', clientKey: '' });
  assert.throws(() => parseAccountConfig(null));
  await fetch(base + '/api/logout', { method: 'POST', headers: { cookie } });
  assert.equal((await fetch(base + '/api/state', { headers: { cookie } })).status, 401);
  console.log('PASS: login, authorization, configuration mapping/validation/clear and logout');
} finally { server.closeAllConnections(); server.close(); }
