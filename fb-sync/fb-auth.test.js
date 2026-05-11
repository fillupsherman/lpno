import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { saveBrowserSession, loadBrowserSession, isLoggedIn, login, SESSION_FILE } = require('./lib/fb-auth.js');

let tmpFile;
beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `fb-session-test-${Date.now()}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) {}
});

// ── saveBrowserSession ────────────────────────────────────────────────────────
describe('saveBrowserSession', () => {
  it('writes cookies to the session file', async () => {
    const cookies = [{ name: 'xs', value: 'abc123' }];
    const page = { cookies: vi.fn().mockResolvedValue(cookies) };
    await saveBrowserSession(page, tmpFile);
    const saved = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(saved).toEqual(cookies);
  });

  it('pretty-prints with 2-space indent', async () => {
    const page = { cookies: vi.fn().mockResolvedValue([{ name: 'a', value: 'b' }]) };
    await saveBrowserSession(page, tmpFile);
    const raw = fs.readFileSync(tmpFile, 'utf8');
    expect(raw).toContain('\n  ');
  });

  it('calls page.cookies()', async () => {
    const page = { cookies: vi.fn().mockResolvedValue([]) };
    await saveBrowserSession(page, tmpFile);
    expect(page.cookies).toHaveBeenCalledOnce();
  });
});

// ── loadBrowserSession ────────────────────────────────────────────────────────
describe('loadBrowserSession', () => {
  it('returns false when session file does not exist', async () => {
    const page = { setCookie: vi.fn() };
    const result = await loadBrowserSession(page, '/nonexistent/path.json');
    expect(result).toBe(false);
    expect(page.setCookie).not.toHaveBeenCalled();
  });

  it('loads cookies and returns true when file exists', async () => {
    const cookies = [{ name: 'c_user', value: '999' }, { name: 'xs', value: 'tok' }];
    fs.writeFileSync(tmpFile, JSON.stringify(cookies));
    const page = { setCookie: vi.fn().mockResolvedValue(undefined) };
    const result = await loadBrowserSession(page, tmpFile);
    expect(result).toBe(true);
    expect(page.setCookie).toHaveBeenCalledWith(...cookies);
  });
});

// ── isLoggedIn ────────────────────────────────────────────────────────────────
describe('isLoggedIn', () => {
  it('returns true when URL does not contain "login"', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://www.facebook.com/'),
    };
    const result = await isLoggedIn(page);
    expect(result).toBe(true);
  });

  it('returns false when URL contains "login"', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://www.facebook.com/login/?next=%2F'),
    };
    const result = await isLoggedIn(page);
    expect(result).toBe(false);
  });

  it('navigates to facebook.com home', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://www.facebook.com/'),
    };
    await isLoggedIn(page);
    expect(page.goto).toHaveBeenCalledWith('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  });
});

// ── login ─────────────────────────────────────────────────────────────────────
describe('login', () => {
  it('navigates to the FB login page', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue([]),
    };
    await login(page, tmpFile);
    expect(page.goto).toHaveBeenCalledWith('https://www.facebook.com/login', { waitUntil: 'networkidle2' });
  });

  it('waits for the login URL to change', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue([]),
    };
    await login(page, tmpFile);
    expect(page.waitForFunction).toHaveBeenCalledOnce();
  });

  it('saves the session after login', async () => {
    const cookies = [{ name: 'xs', value: 'newsession' }];
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      cookies: vi.fn().mockResolvedValue(cookies),
    };
    await login(page, tmpFile);
    const saved = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(saved).toEqual(cookies);
  });
});

// ── SESSION_FILE ──────────────────────────────────────────────────────────────
describe('SESSION_FILE', () => {
  it('resolves to fb-session.json inside fb-sync/', () => {
    expect(SESSION_FILE).toMatch(/fb-sync[/\\]fb-session\.json$/);
  });
});
