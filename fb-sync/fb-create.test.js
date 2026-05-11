import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findCreatedEventOnPage, FB_PAGE_URL } = require('./lib/fb-create.js');

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function makePage(overrides = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url:  vi.fn().mockReturnValue('https://www.facebook.com/events/create/'),
    evaluate: vi.fn().mockResolvedValue([]),
    evaluateHandle: vi.fn().mockResolvedValue({ asElement: () => null }),
    screenshot: vi.fn().mockResolvedValue(undefined),
    keyboard: { type: vi.fn(), press: vi.fn(), down: vi.fn(), up: vi.fn() },
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ── FB_PAGE_URL ───────────────────────────────────────────────────────────────
describe('FB_PAGE_URL', () => {
  it('points to the LPNO Facebook page', () => {
    expect(FB_PAGE_URL).toContain('leftistprogressivenightout');
    expect(FB_PAGE_URL).toContain('facebook.com');
  });
});

// ── findCreatedEventOnPage ────────────────────────────────────────────────────
describe('findCreatedEventOnPage', () => {
  const event = { id: '42', name: 'Jazz Night Out' };

  async function run(fn) {
    const p = fn();
    await vi.runAllTimersAsync();
    return p;
  }

  it('returns null when no candidates match event name', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(undefined) // scrollBy
        .mockResolvedValueOnce([{ href: 'https://facebook.com/events/999', text: 'Totally Different Event' }]),
    });
    expect(await run(() => findCreatedEventOnPage(page, event))).toBeNull();
  });

  it('returns the FB event ID when candidate text matches name prefix', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ href: 'https://www.facebook.com/events/777', text: 'Jazz Night Out — LPNO' }]),
    });
    expect(await run(() => findCreatedEventOnPage(page, event))).toBe('777');
  });

  it('matches using first 20 chars of lowercased name', async () => {
    const longEvent = { id: '1', name: 'A Very Long Event Name That Goes On And On' };
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ href: 'https://www.facebook.com/events/555', text: 'a very long event nam details here' }]),
    });
    expect(await run(() => findCreatedEventOnPage(page, longEvent))).toBe('555');
  });

  it('returns null when candidate href has no numeric event ID', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([{ href: 'https://www.facebook.com/events/jazz-night-out', text: 'Jazz Night Out' }]),
    });
    expect(await run(() => findCreatedEventOnPage(page, event))).toBeNull();
  });

  it('returns null when evaluate throws', async () => {
    const page = makePage({ goto: vi.fn().mockRejectedValue(new Error('nav failed')) });
    expect(await run(() => findCreatedEventOnPage(page, event))).toBeNull();
  });

  it('returns null for empty candidate list', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce([]),
    });
    expect(await run(() => findCreatedEventOnPage(page, event))).toBeNull();
  });

  it('navigates to the page events list', async () => {
    const page = makePage({ evaluate: vi.fn().mockResolvedValue([]) });
    await run(() => findCreatedEventOnPage(page, event));
    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('/events'), expect.any(Object));
  });
});

// ── createFacebookEvent — structural smoke tests ──────────────────────────────
describe('createFacebookEvent', () => {
  const { createFacebookEvent } = require('./lib/fb-create.js');
  const event = { id: '1', name: 'Test Event', time: Date.now(), location_name: 'The Venue', location_city: 'New Orleans, LA', description: '<p>Come join us!</p>' };

  async function run(fn) {
    const p = fn();
    await vi.runAllTimersAsync();
    return p;
  }

  it('returns false when redirected away from /events/create', async () => {
    const page = makePage({
      url: vi.fn().mockReturnValue('https://www.facebook.com/login'),
      screenshot: vi.fn().mockResolvedValue(undefined),
    });
    expect(await run(() => createFacebookEvent(page, event))).toBe(false);
  });

  it('returns false when name input cannot be found', async () => {
    const page = makePage({
      url: vi.fn().mockReturnValue('https://www.facebook.com/events/create/?ref=create'),
      evaluate: vi.fn().mockResolvedValue([]),
      evaluateHandle: vi.fn().mockResolvedValue({ asElement: () => null }),
      screenshot: vi.fn().mockResolvedValue(undefined),
    });
    expect(await run(() => createFacebookEvent(page, event))).toBe(false);
  });

  it('returns false when create button is not found', async () => {
    const nameHandle = { asElement: () => ({ click: vi.fn().mockResolvedValue(undefined), type: vi.fn().mockResolvedValue(undefined) }) };
    const noHandle   = { asElement: () => null };
    let handleCall = 0;
    const page = makePage({
      url: vi.fn().mockReturnValue('https://www.facebook.com/events/create/?ref=x'),
      evaluate: vi.fn().mockResolvedValue([]),
      evaluateHandle: vi.fn().mockImplementation(() => {
        handleCall++;
        return Promise.resolve(handleCall === 1 ? nameHandle : noHandle);
      }),
      $: vi.fn().mockResolvedValue(null),
      screenshot: vi.fn().mockResolvedValue(undefined),
    });
    expect(await run(() => createFacebookEvent(page, event))).toBe(false);
  });

  it('returns the event URL on successful creation', async () => {
    const createdUrl = 'https://www.facebook.com/events/123456789/';
    const nameHandle = { asElement: () => ({ click: vi.fn().mockResolvedValue(undefined), type: vi.fn().mockResolvedValue(undefined) }) };
    let handleCall = 0;
    const page = makePage({
      url: vi.fn()
        .mockReturnValueOnce('https://www.facebook.com/events/create/?ref=x')
        .mockReturnValue(createdUrl),
      evaluate: vi.fn().mockResolvedValue([]),
      evaluateHandle: vi.fn().mockImplementation(() => {
        handleCall++;
        if (handleCall === 1) return Promise.resolve(nameHandle);
        return Promise.resolve({ asElement: () => ({ click: vi.fn().mockResolvedValue(undefined) }) });
      }),
      $: vi.fn().mockResolvedValue(null),
      screenshot: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
    });
    expect(await run(() => createFacebookEvent(page, event))).toBe(createdUrl);
  });

  it('returns "unknown" when no error detected but URL unchanged', async () => {
    const nameHandle = { asElement: () => ({ click: vi.fn().mockResolvedValue(undefined), type: vi.fn().mockResolvedValue(undefined) }) };
    let handleCall = 0;
    const page = makePage({
      url: vi.fn()
        .mockReturnValueOnce('https://www.facebook.com/events/create/?ref=x')
        .mockReturnValue('https://www.facebook.com/events/create/'),
      evaluate: vi.fn().mockResolvedValue(false),
      evaluateHandle: vi.fn().mockImplementation(() => {
        handleCall++;
        return Promise.resolve(handleCall === 1 ? nameHandle : { asElement: () => ({ click: vi.fn().mockResolvedValue(undefined) }) });
      }),
      $: vi.fn().mockResolvedValue(null),
      screenshot: vi.fn().mockResolvedValue(undefined),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
    });
    expect(await run(() => createFacebookEvent(page, event))).toBe('unknown');
  });
});
