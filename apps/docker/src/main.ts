/**
 * docker 主进程：Node 侧运行 core runtime；浏览器仅作播放器（Playwright）
 * 凭证：配置的 portal 客户端密钥（mh_ck_）作为存储 token（服务端 key 认证）
 * 管理端：server.js（:3000 容器内，宿主映射 13000）
 */
import fs from 'node:fs';
import path from 'node:path';
import { ClientRuntime } from '../../../packages/core/src/index.ts';
import { DockBrowser } from './browser.ts';
import { createStatusServer } from './server.ts';
import { API_VERSION, callSignedApi, normalizeMe } from './api.ts';

const DATA_DIR = process.env.DATA_DIR || '/data';
const BASE = process.env.API_BASE || 'https://163music.linyu.qzz.io';
const VERSION = API_VERSION;

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** 配置持久化（cookie/key 由管理端写入） */
const cfg = {
  load() { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return {}; } },
  save(c: object) {
    fs.writeFileSync(SESSION_FILE + '.tmp', JSON.stringify(c), { mode: 0o600 });
    fs.renameSync(SESSION_FILE + '.tmp', SESSION_FILE);
  },
};

const state = {
  get configured() { const c = cfg.load(); return Boolean(c.neteaseCookie && c.clientKey); },
  onConfig(c: { neteaseCookie: string; clientKey: string }) {
    cfg.save(c);
    // Restart after the HTTP response; Docker reloads the persisted browser cookie and runtime token.
    setTimeout(() => process.exit(0), 1000).unref();
  },
  startedAt: Date.now(),
  helpUsed: 0, helpLimit: 9000,
  recv: 0, recvLimit: 26,
  job: null as { musicName: string; playedMs: number; targetMs: number } | null,
  hbIntervals: [] as number[],
  lastEvent: '',
  acctName: '', authenticated: false, lastError: '',
  logs: [] as Array<{ level: string; ts: number; msg: string }>,
};

const storage = {
  getToken: () => String(cfg.load().clientKey || ''),
  setToken: (t: string) => { const c = cfg.load(); c.clientKey = t; cfg.save(c); },
  clearToken: () => { const c = cfg.load(); delete c.clientKey; cfg.save(c); },
  getExpires: () => 0,
  setExpires: () => {},
};

let lastApiError = '', lastApiErrorAt = 0;
async function api<T = any>(method: string, pathName: string, body?: unknown, token = storage.getToken()) {
  const result = await callSignedApi<T>(method, BASE.replace(/\/$/, '') + pathName, body, token);
  if (pathName !== '/api/client/log' && result.status !== 200) {
    const code = /^[a-zA-Z0-9_.:-]{1,80}$/.test(result.error || '') ? result.error : `http_${result.status}`;
    const message = `API ${method} ${pathName} → ${result.status} (${code})`;
    state.lastError = message;
    if (message !== lastApiError || Date.now() - lastApiErrorAt >= 60_000) {
      state.logs.push({ level: 'error', ts: Date.now(), msg: message });
      if (state.logs.length > 200) state.logs.shift();
      console.warn(message); lastApiError = message; lastApiErrorAt = Date.now();
    }
  } else if (pathName === '/api/me' && result.status === 200) state.lastError = '';
  return result;
}

async function main() {
  const cookie = String(cfg.load().neteaseCookie || '');
  const browser = new DockBrowser(DATA_DIR, cookie);
  await browser.launch();
  console.log('[main] 浏览器已就绪');

  const transport = {
    next: async (token: string) => api('GET', '/api/next?preference=random', undefined, token),
    finish: async (token: string, input: unknown) => api('POST', '/api/play/finish', input, token),
    abandon: async (token: string, reason: string, detail: string) => { await api('POST', '/api/play/abandon', { jobId: runtime.job.current?.jobId, reason, detail }, token); },
    heartbeat: async (token: string, input: unknown) => (await api('POST', '/api/play/heartbeat', input, token)).status === 200,
    refresh: async () => null, // key 凭证不走 session refresh
    me: async () => { const r = await api('GET', '/api/me'); return { ...r, payload: r.status === 200 && r.payload ? normalizeMe(r.payload) : null }; },
    sendLog: async (p: unknown) => { await api('POST', '/api/client/log', { ...(p as object), clientVersion: VERSION, clientType: 'docker' }); },
  };

  const player = {
    play: (musicId: string, durationMs: number) => browser.play(musicId, durationMs),
    stop: () => browser.stop(),
    onProgress: (cb: (playedMs: number, positionMs: number, durationMs: number) => void) => {
      setInterval(async () => {
        try { const p = await browser.progress(); if (p.playedMs > 0) cb(p.playedMs, p.playedMs, p.durationMs); } catch { /* 页面繁忙 */ }
      }, 1000);
    },
  };

  const runtime = new ClientRuntime({ adapter: {
    clientType: 'docker', version: VERSION, storage,
    probeNetwork: async () => true, hasPage: false,
  }, transport, player });

  runtime.bus.on('job:current', (j) => { state.job = j ? { musicName: j.musicName, playedMs: 0, targetMs: j.targetMs } : null; });
  runtime.bus.on('job:progress', (p) => { if (state.job) state.job.playedMs = p.playedMs; });
  runtime.bus.on('heartbeat:tick', (t) => { state.hbIntervals.push(t.intervalMs / 1000); if (state.hbIntervals.length > 30) state.hbIntervals.shift(); });
  runtime.bus.on('auth:user', (u) => { state.authenticated = Boolean(u); state.acctName = u?.displayName || ''; if (u) { state.lastError = ''; runtime.log.push('info', 'auth_ok', '账号认证通过'); } });
  runtime.bus.on('limits:updated', (l) => { state.helpUsed = l.helpedToday; state.helpLimit = l.helpedLimit; state.recv = l.receivedToday; state.recvLimit = l.receivedLimit; });
  runtime.bus.on('log:append', (e) => { state.logs.push({ level: e.level, ts: e.ts, msg: e.msg }); if (state.logs.length > 200) state.logs.shift(); state.lastEvent = e.msg; });

  createStatusServer({ port: Number(process.env.PORT || 3000), state });
  console.log('[main] 管理端 http://0.0.0.0:3000');
  void runtime.start(true);
}

main().catch((e) => { console.error('[main] fatal', e); process.exit(1); });
