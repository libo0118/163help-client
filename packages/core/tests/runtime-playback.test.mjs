import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '../dist/runner.js';
import { HeartbeatEngine } from '../dist/heartbeat.js';
import { EventBus } from '../dist/events.js';

const drain = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(overrides = {}) {
  const calls = { play: [], stop: 0, finish: [], abandon: [], heartbeat: [], logs: [] };
  let progress;
  let sequence = 0;
  const adapter = {
    clientType: 'docker', version: 'test', hasPage: false,
    storage: {
      getToken: () => 'test-token', setToken() {}, clearToken() {},
      getExpires: () => 0, setExpires() {},
    },
    probeNetwork: async () => true,
  };
  const runtime = new ClientRuntime({
    adapter,
    transport: {
      next: overrides.next ?? (async () => ({ status: 200, payload: {
        jobId: `job-${++sequence}`, musicId: 'song:12345',
        requiredListenMs: 1000, targetDurationMs: 5000,
        owner: { displayName: 'Owner' },
      } })),
      finish: async (_token, input) => {
        calls.finish.push(input);
        return overrides.finish ? overrides.finish(input) : { status: 200, payload: { settled: true } };
      },
      abandon: async (_token, reason, detail) => {
        calls.abandon.push({ jobId: runtime.job.current?.jobId, reason, detail });
        if (overrides.abandon) await overrides.abandon();
      },
      heartbeat: async (_token, input) => { calls.heartbeat.push(input); return true; },
      refresh: async () => null,
      me: async () => ({ status: 200, payload: { displayName: 'Test', credits: 1 } }),
      sendLog: async () => {},
    },
    player: {
      play: async (...args) => { calls.play.push(args); return overrides.play ? overrides.play(...args) : true; },
      stop: () => { calls.stop++; },
      onProgress: (cb) => { progress = cb; },
    },
  });
  runtime.bus.on('log:append', (entry) => calls.logs.push(entry));
  return { runtime, calls, adapter, progress: (...args) => progress(...args) };
}

test('owner jobs retain the real ID and settle once with actual player progress', async () => {
  const pending = deferred();
  const f = fixture({ finish: () => pending.promise });
  try {
    await f.runtime.job.fetchNext();
    await drain();
    assert.equal(f.runtime.job.current.musicId, 'song:12345');
    assert.equal(f.runtime.job.current.musicName, 'song:12345');
    assert.equal(f.runtime.job.current.targetMs, 1000);
    assert.equal(f.calls.play[0][0], 'song:12345');
    f.progress(500, 450, 6000);
    await drain();
    f.progress(1200, 1150, 6000);
    f.progress(1300, 1250, 6000);
    await drain();
    assert.deepEqual(f.calls.finish, [{
      jobId: 'job-1', playedMs: 1200, positionMs: 1150, durationMs: 6000,
      playbackRate: 1, jumpCount: 0, backwardJumpCount: 0,
      listenDriftMs: 50, recoveryAttempts: 0, stallDetected: false,
    }]);
    pending.resolve({ status: 200, payload: { settled: true } });
    await drain();
    assert.equal(f.runtime.job.phase, 'idle');
    assert.equal(f.runtime.job.current, null);
    assert.equal(f.runtime.heart.job, '');
    assert.equal(f.calls.stop, 1);
  } finally { f.runtime.heart.stop(); }
});

test('zero targets do not settle automatically', async () => {
  const f = fixture({ next: async () => ({ status: 200, payload: {
    jobId: 'zero', musicId: '42', requiredListenMs: 0, targetDurationMs: 1000,
  } }) });
  try {
    await f.runtime.job.fetchNext();
    f.progress(5000, 5000, 6000);
    await drain();
    assert.equal(f.calls.finish.length, 0);
    assert.equal(f.runtime.job.phase, 'playing');
  } finally { f.runtime.heart.stop(); }
});

for (const failure of [false, new Error('player unavailable')]) {
  test(`failed play (${String(failure)}) abandons the actual job and stops playback`, async () => {
    const f = fixture({ play: async () => { if (failure instanceof Error) throw failure; return failure; } });
    try {
      await f.runtime.job.fetchNext();
      await drain();
      assert.equal(f.calls.abandon.length, 1);
      assert.equal(f.calls.abandon[0].jobId, 'job-1');
      assert.equal(f.calls.abandon[0].reason, 'play_start_fail');
      assert.equal(f.runtime.job.phase, 'idle');
      assert.equal(f.runtime.heart.job, '');
      assert.equal(f.calls.stop, 1);
      assert.ok(f.calls.logs.some((entry) => entry.event === 'job_play_failed'));
    } finally { f.runtime.heart.stop(); }
  });
}

test('finish rejection is logged and returns to idle', async () => {
  const f = fixture({ finish: async () => ({ status: 403, payload: { settled: false }, error: 'job_expired' }) });
  try {
    await f.runtime.job.fetchNext();
    f.progress(1000, 1000, 2000);
    await drain();
    assert.equal(f.calls.finish.length, 1);
    assert.equal(f.runtime.job.phase, 'idle');
    assert.equal(f.runtime.heart.job, '');
    assert.ok(f.calls.logs.some((entry) => entry.event === 'settle_failed' && entry.msg.includes('job_expired')));
  } finally { f.runtime.heart.stop(); }
});

test('late finish responses cannot clear a newer job', async () => {
  const pending = deferred();
  const f = fixture({ finish: () => pending.promise });
  try {
    await f.runtime.job.fetchNext();
    f.progress(1000, 1000, 2000);
    await drain();
    await f.runtime.job.abandon('test', 'replace pending job');
    await f.runtime.job.fetchNext();
    pending.resolve({ status: 200, payload: { settled: true } });
    await drain();
    assert.equal(f.runtime.job.current.jobId, 'job-2');
    assert.equal(f.runtime.heart.job, 'job-2');
    assert.equal(f.calls.stop, 1);
  } finally { f.runtime.heart.stop(); }
});

test('a finish response cannot clear a job while its abandon request is pending', async () => {
  const finish = deferred();
  const abandon = deferred();
  const f = fixture({ finish: () => finish.promise, abandon: () => abandon.promise });
  try {
    await f.runtime.job.fetchNext();
    f.progress(1000, 1000, 2000);
    await drain();
    const abandoning = f.runtime.job.abandon('test', 'cancel pending finish');
    finish.resolve({ status: 200, payload: { settled: true } });
    await drain();
    assert.equal(f.runtime.job.phase, 'abandoning');
    assert.equal(f.runtime.job.current.jobId, 'job-1');
    abandon.resolve();
    await abandoning;
    assert.equal(f.runtime.job.phase, 'idle');
    assert.equal(f.calls.stop, 1);
  } finally { finish.resolve({ status: 200, payload: { settled: true } }); abandon.resolve(); f.runtime.heart.stop(); }
});

test('network errors reset fetching to idle and are logged by runtime', async () => {
  let attempts = 0;
  const f = fixture({ next: async () => {
    if (++attempts === 1) throw new Error('offline');
    return { status: 200, payload: { musicId: null, noTargetReason: 'empty' } };
  } });
  try {
    await assert.rejects(f.runtime.job.fetchNext(), /offline/);
    assert.equal(f.runtime.job.phase, 'idle');
    assert.ok(f.calls.logs.some((entry) => entry.event === 'next_failed'));
    await f.runtime.job.fetchNext();
    assert.equal(attempts, 2);
  } finally { f.runtime.heart.stop(); }
});

test('heartbeat sends the latest progress every ten seconds and rejected sends do not refresh success time', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const sent = [];
  const abandoned = [];
  let accepted = true;
  const heart = new HeartbeatEngine(new EventBus(), {
    heartbeat: async (input) => { sent.push(input); return accepted; },
  }, f.adapter, { onAbandon: (...args) => abandoned.push(args), onResume() {} });
  try {
    heart.start('hb-job');
    await heart.pulse(1000, 900, 6000, true);
    now += 1000;
    await heart.pulse(2000, 1900, 6000, true);
    await heart.tick();
    assert.equal(sent.length, 1);
    now += 9000;
    await heart.tick();
    assert.deepEqual(sent[1], { jobId: 'hb-job', playedMs: 2000, positionMs: 1900, durationMs: 6000, monotonic: true });
    accepted = false;
    now += 10000;
    await heart.pulse(3000, 2900, 6000, true);
    assert.equal(sent.length, 3);
    now += 36000;
    await heart.tick();
    assert.equal(abandoned[0][0], 'heartbeat_lost');
    assert.equal(heart.job, '');
  } finally { heart.stop(); f.runtime.heart.stop(); Date.now = originalNow; }
});

test('rejected first heartbeat still expires the startup grace', async () => {
  const f = fixture();
  const abandoned = [];
  const heart = new HeartbeatEngine(new EventBus(), { heartbeat: async () => false }, f.adapter,
    { onAbandon: (...args) => abandoned.push(args), onResume() {} }, { firstHbGraceMs: 5 });
  try {
    heart.start('first-rejected');
    await heart.pulse(100, 100, 2000, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(abandoned[0][0], 'play_start_fail');
    assert.equal(heart.job, '');
  } finally { heart.stop(); f.runtime.heart.stop(); }
});

test('heartbeat requests do not overlap and old responses cannot mark a new job healthy', async () => {
  const f = fixture();
  const pending = deferred();
  const bus = new EventBus();
  const ticks = [];
  const sent = [];
  bus.on('heartbeat:tick', (entry) => ticks.push(entry));
  const heart = new HeartbeatEngine(bus, {
    heartbeat: async (input) => { sent.push(input); return pending.promise; },
  }, f.adapter, { onAbandon() {}, onResume() {} });
  try {
    heart.start('old');
    const first = heart.pulse(100, 100, 2000, true);
    const second = heart.pulse(200, 200, 2000, true);
    const tick = heart.tick();
    await drain();
    assert.equal(sent.length, 1);
    heart.start('new');
    pending.resolve(true);
    await Promise.all([first, second, tick]);
    assert.equal(heart.job, 'new');
    assert.equal(ticks.length, 0);
    assert.equal(heart.lastAt, 0);
  } finally { pending.resolve(true); heart.stop(); f.runtime.heart.stop(); }
});
