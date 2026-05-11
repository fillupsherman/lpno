import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from './index.js';

// Minimal KV mock
function makeKV() {
  const store = {};
  return {
    put: vi.fn(async (k, v) => { store[k] = v; }),
    get: vi.fn(async (k, opts) => {
      const val = store[k];
      if (!val) return null;
      return opts?.type === 'json' ? JSON.parse(val) : val;
    }),
    _store: store
  };
}

function makeEnv(overrides = {}) {
  return {
    RSVPS: makeKV(),
    SUBSCRIBERS: makeKV(),
    VOLUNTEERS: makeKV(),
    SUPPLY_DONATIONS: makeKV(),
    GROUP_URLNAME: 'test-group',
    FB_PAGE_ID: '123',
    MEETUP_CLIENT_ID: 'cid',
    MEETUP_CLIENT_SECRET: 'csec',
    MEETUP_REFRESH_TOKEN: 'rtoken',
    ...overrides
  };
}

function makeReq(method, path, body = null) {
  const url = `https://worker.example.com${path}`;
  const init = { method, headers: { 'content-type': 'application/json' } };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// ── CORS pre-flight ──────────────────────────────────────────────
describe('OPTIONS pre-flight', () => {
  it('returns 200 for OPTIONS', async () => {
    const res = await worker.fetch(makeReq('OPTIONS', '/subscribe'), makeEnv());
    expect(res.status).toBe(200);
  });
});

// ── POST /subscribe ──────────────────────────────────────────────
describe('POST /subscribe', () => {
  it('stores valid email', async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeReq('POST', '/subscribe', { email: 'a@b.com' }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(env.SUBSCRIBERS.put).toHaveBeenCalledWith('a@b.com', expect.any(String));
  });

  it('rejects invalid email', async () => {
    const res = await worker.fetch(makeReq('POST', '/subscribe', { email: 'bad' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('silently ignores honeypot', async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeReq('POST', '/subscribe', { email: 'a@b.com', hp: 'bot' }), env);
    expect(res.status).toBe(200);
    expect(env.SUBSCRIBERS.put).not.toHaveBeenCalled();
  });
});

// ── POST /volunteer ──────────────────────────────────────────────
describe('POST /volunteer', () => {
  it('stores valid signup', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeReq('POST', '/volunteer', { email: 'v@test.com', opportunity_id: 'op1' }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(env.VOLUNTEERS.put).toHaveBeenCalledWith(
      'v@test.com:op1',
      expect.stringContaining('"opportunity_id":"op1"')
    );
  });

  it('rejects missing email', async () => {
    const res = await worker.fetch(
      makeReq('POST', '/volunteer', { opportunity_id: 'op1' }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid email', async () => {
    const res = await worker.fetch(
      makeReq('POST', '/volunteer', { email: 'notanemail', opportunity_id: 'op1' }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing opportunity_id', async () => {
    const res = await worker.fetch(
      makeReq('POST', '/volunteer', { email: 'v@test.com' }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('silently ignores honeypot', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeReq('POST', '/volunteer', { email: 'v@test.com', opportunity_id: 'op1', hp: 'bot' }),
      env
    );
    expect(res.status).toBe(200);
    expect(env.VOLUNTEERS.put).not.toHaveBeenCalled();
  });

  it('normalises email to lowercase', async () => {
    const env = makeEnv();
    await worker.fetch(
      makeReq('POST', '/volunteer', { email: 'V@Test.COM', opportunity_id: 'op1' }),
      env
    );
    expect(env.VOLUNTEERS.put).toHaveBeenCalledWith(
      'v@test.com:op1',
      expect.stringContaining('"email":"v@test.com"')
    );
  });
});

// ── POST /donate-supplies ────────────────────────────────────────
describe('POST /donate-supplies', () => {
  it('stores valid donation', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeReq('POST', '/donate-supplies', { email: 'd@test.com', description: 'Canned food' }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(env.SUPPLY_DONATIONS.put).toHaveBeenCalledWith(
      expect.stringContaining('d@test.com:'),
      expect.stringContaining('"description":"Canned food"')
    );
  });

  it('rejects missing email', async () => {
    const res = await worker.fetch(
      makeReq('POST', '/donate-supplies', { description: 'Canned food' }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid email', async () => {
    const res = await worker.fetch(
      makeReq('POST', '/donate-supplies', { email: 'bad', description: 'Canned food' }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('rejects missing description', async () => {
    const res = await worker.fetch(
      makeReq('POST', '/donate-supplies', { email: 'd@test.com' }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('rejects blank description', async () => {
    const res = await worker.fetch(
      makeReq('POST', '/donate-supplies', { email: 'd@test.com', description: '   ' }),
      makeEnv()
    );
    expect(res.status).toBe(400);
  });

  it('normalises email to lowercase', async () => {
    const env = makeEnv();
    await worker.fetch(
      makeReq('POST', '/donate-supplies', { email: 'D@Test.COM', description: 'Books' }),
      env
    );
    expect(env.SUPPLY_DONATIONS.put).toHaveBeenCalledWith(
      expect.stringContaining('d@test.com:'),
      expect.stringContaining('"email":"d@test.com"')
    );
  });
});

// ── 404 catch-all ────────────────────────────────────────────────
describe('404 catch-all', () => {
  it('returns 404 for unknown route', async () => {
    const res = await worker.fetch(makeReq('GET', '/nonexistent'), makeEnv());
    expect(res.status).toBe(404);
  });
});
