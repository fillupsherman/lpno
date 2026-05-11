import { createRequire } from 'module';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const require = createRequire(import.meta.url);

async function run(fn) {
  const p = fn();
  await vi.runAllTimersAsync();
  return p;
}

function makePage(overrides = {}) {
  return {
    url: vi.fn().mockReturnValue('https://www.facebook.com/events/12345'),
    goto: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
    evaluate: vi.fn().mockResolvedValue(false),
    isClosed: vi.fn().mockReturnValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeBrowser(pageOverrides = {}) {
  const page = makePage(pageOverrides);
  return {
    newPage: vi.fn().mockResolvedValue(page),
    _page: page,
  };
}

describe('handleDeletedMeetupEvents', () => {
  let handleDeletedMeetupEvents;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    ({ handleDeletedMeetupEvents } = require('./lib/fb-delete'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns { processed: 0 } immediately when deletedFbIds is empty', async () => {
    const browser = makeBrowser();
    const result = await run(() => handleDeletedMeetupEvents(browser, {}, []));
    expect(result).toEqual({ processed: 0 });
    expect(browser.newPage).not.toHaveBeenCalled();
  });

  it('returns { processed: 0 } when deletedFbIds is null', async () => {
    const browser = makeBrowser();
    const result = await run(() => handleDeletedMeetupEvents(browser, {}, null));
    expect(result).toEqual({ processed: 0 });
  });

  it('skips entries that have no fb_url', async () => {
    const browser = makeBrowser();
    const synced = { 'abc': { name: 'No URL event' } }; // no fb_url
    const result = await run(() => handleDeletedMeetupEvents(browser, synced, ['abc']));
    expect(result).toEqual({ processed: 0 });
    expect(browser.newPage).not.toHaveBeenCalled();
  });

  it('removes past events from synced without opening a browser page', async () => {
    const browser = makeBrowser();
    const pastTime = Date.now() - 1000 * 60 * 60; // 1 hour ago
    const synced = {
      'past123': {
        fb_url: 'https://facebook.com/events/past123',
        name: 'Past Event',
        meetup_data: { time: pastTime },
      },
    };
    const result = await run(() => handleDeletedMeetupEvents(browser, synced, ['past123']));
    expect(result).toEqual({ processed: 0 });
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(synced['past123']).toBeUndefined();
  });

  it('processes a future event and opens a new page', async () => {
    const futureTime = Date.now() + 1000 * 60 * 60 * 24; // tomorrow
    const synced = {
      'fut456': {
        fb_url: 'https://facebook.com/events/fut456',
        name: 'Future Event',
        meetup_data: { time: futureTime },
      },
    };
    const browser = makeBrowser({
      // Final missing check returns true so it counts as success
      evaluate: vi.fn().mockResolvedValue(true),
    });
    const result = await run(() => handleDeletedMeetupEvents(browser, synced, ['fut456']));
    expect(browser.newPage).toHaveBeenCalled();
    expect(result.processed).toBe(1);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('removes synced entry on success (missing=true)', async () => {
    const futureTime = Date.now() + 1000 * 60 * 60 * 24;
    const synced = {
      'del789': {
        fb_url: 'https://facebook.com/events/del789',
        name: 'Event to Delete',
        meetup_data: { time: futureTime },
      },
    };
    const browser = makeBrowser({ evaluate: vi.fn().mockResolvedValue(true) });
    await run(() => handleDeletedMeetupEvents(browser, synced, ['del789']));
    expect(synced['del789']).toBeUndefined();
  });

  it('removes synced entry even when missing=false (post-delete page still loads)', async () => {
    const futureTime = Date.now() + 1000 * 60 * 60 * 24;
    const synced = {
      'del000': {
        fb_url: 'https://facebook.com/events/del000',
        name: 'Another Event',
        meetup_data: { time: futureTime },
      },
    };
    // Call sequence: openMenu(void), clickCancel(true), deleteDirectly(false),
    // radioSelect(void), radioConfirm(void), finalConfirm(void), missing(false)
    const browser = makeBrowser({
      evaluate: vi.fn()
        .mockResolvedValueOnce(undefined) // open menu
        .mockResolvedValueOnce(true)      // clicked = true
        .mockResolvedValueOnce(false)     // deleted = false
        .mockResolvedValueOnce(undefined) // select radio
        .mockResolvedValueOnce(undefined) // confirm click
        .mockResolvedValueOnce(undefined) // final confirm
        .mockResolvedValueOnce(false),    // missing = false (still shows)
    });
    const result = await run(() => handleDeletedMeetupEvents(browser, synced, ['del000']));
    expect(synced['del000']).toBeUndefined();
    expect(result.success).toBe(1);
  });

  it('counts failure when newPage throws', async () => {
    const futureTime = Date.now() + 1000 * 60 * 60 * 24;
    const synced = {
      'err111': {
        fb_url: 'https://facebook.com/events/err111',
        name: 'Failing Event',
        meetup_data: { time: futureTime },
      },
    };
    const browser = {
      newPage: vi.fn().mockRejectedValue(new Error('browser crashed')),
    };
    const result = await run(() => handleDeletedMeetupEvents(browser, synced, ['err111']));
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.success).toBe(0);
  });

  it('processes multiple IDs independently', async () => {
    const futureTime = Date.now() + 1000 * 60 * 60 * 24;
    const synced = {
      'a1': { fb_url: 'https://facebook.com/events/a1', name: 'A', meetup_data: { time: futureTime } },
      'b2': { fb_url: 'https://facebook.com/events/b2', name: 'B', meetup_data: { time: futureTime } },
    };
    const browser = makeBrowser({ evaluate: vi.fn().mockResolvedValue(true) });
    const result = await run(() => handleDeletedMeetupEvents(browser, synced, ['a1', 'b2']));
    expect(result.processed).toBe(2);
    expect(result.success).toBe(2);
    expect(browser.newPage).toHaveBeenCalledTimes(2);
  });

  it('closes page in finally block after success', async () => {
    const futureTime = Date.now() + 1000 * 60 * 60 * 24;
    const synced = {
      'close1': {
        fb_url: 'https://facebook.com/events/close1',
        name: 'Close Me',
        meetup_data: { time: futureTime },
      },
    };
    const page = makePage({ evaluate: vi.fn().mockResolvedValue(true) });
    const browser = { newPage: vi.fn().mockResolvedValue(page) };
    await run(() => handleDeletedMeetupEvents(browser, synced, ['close1']));
    expect(page.close).toHaveBeenCalled();
  });

  it('closes page in finally block after failure', async () => {
    const futureTime = Date.now() + 1000 * 60 * 60 * 24;
    const synced = {
      'close2': {
        fb_url: 'https://facebook.com/events/close2',
        name: 'Close Me Too',
        meetup_data: { time: futureTime },
      },
    };
    const page = makePage({
      evaluate: vi.fn()
        .mockRejectedValueOnce(new Error('open menu failed'))
        .mockRejectedValueOnce(new Error('click cancel failed'))
        .mockResolvedValue(false),
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page) };
    await run(() => handleDeletedMeetupEvents(browser, synced, ['close2']));
    expect(page.close).toHaveBeenCalled();
  });
});
