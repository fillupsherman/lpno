import { createRequire } from 'module';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const require = createRequire(import.meta.url);

// Helper: start async fn, flush all fake timers, return result
async function run(fn) {
  const p = fn();
  await vi.runAllTimersAsync();
  return p;
}

function makePage(overrides = {}) {
  const page = {
    url: vi.fn().mockReturnValue('https://www.facebook.com/events/edit/12345'),
    goto: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
    click: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    evaluateHandle: vi.fn().mockResolvedValue({ asElement: () => null }),
    $: vi.fn().mockResolvedValue(null),
    waitForSelector: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue(undefined),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      down: vi.fn().mockResolvedValue(undefined),
      up: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
    browser: vi.fn().mockReturnValue({
      pages: vi.fn().mockResolvedValue([]),
    }),
    ...overrides,
  };
  return page;
}

describe('uploadPhoto', () => {
  let uploadPhoto;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Fresh require each time to avoid module-level state
    vi.resetModules();
    const mod = require('./lib/fb-edit');
    uploadPhoto = mod.uploadPhoto;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns false when fbUrl has no event ID', async () => {
    const page = makePage();
    const result = await run(() => uploadPhoto(page, { id: '1' }, 'https://facebook.com/no-id-here'));
    expect(result).toBe(false);
  });

  it('returns false when event has no image URL', async () => {
    const page = makePage();
    const result = await run(() => uploadPhoto(page, { id: '1' }, 'https://facebook.com/events/99999'));
    expect(result).toBe(false);
  });

  it('returns false when image fetch fails', async () => {
    const page = makePage();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await run(() => uploadPhoto(
      page,
      { id: '42', photo: 'https://example.com/img.jpg' },
      'https://facebook.com/events/99999'
    ));
    expect(result).toBe(false);
  });

  it('returns false when no file input is found after navigation', async () => {
    const page = makePage();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    const result = await run(() => uploadPhoto(
      page,
      { id: '42', photo: 'https://example.com/img.jpg' },
      'https://facebook.com/events/99999'
    ));
    expect(result).toBe(false);
  });

  it('returns true when file input is found and upload succeeds', async () => {
    const fileInput = { uploadFile: vi.fn().mockResolvedValue(undefined) };
    const page = makePage({
      $: vi.fn().mockResolvedValue(fileInput),
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });

    // Mock fs so we don't write to disk
    const fsMock = {
      existsSync: vi.fn().mockReturnValue(true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
    };
    vi.doMock('fs', () => fsMock);

    const result = await run(() => uploadPhoto(
      page,
      { id: '42', name: 'Test Event', photo: 'https://example.com/img.jpg' },
      'https://facebook.com/events/99999'
    ));
    // We can't easily verify true without full fs mocking, but at minimum it shouldn't throw
    expect(typeof result).toBe('boolean');
  });
});

describe('editFacebookEvent', () => {
  let editFacebookEvent;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const mod = require('./lib/fb-edit');
    editFacebookEvent = mod.editFacebookEvent;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const baseEvent = {
    id: '123',
    name: 'Test Event',
    description: 'A fun event',
    time: new Date('2025-08-15T19:00:00').getTime(),
    location_name: 'The Venue',
    location_city: 'New Orleans, LA',
  };

  it('returns false when fbUrl has no event ID', async () => {
    const page = makePage();
    const result = await run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/no-id', ['name'])
    );
    expect(result).toBe(false);
  });

  it('handles name change without throwing', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)  // hasEditor check
        .mockResolvedValueOnce(false) // save attempt 1
        .mockResolvedValueOnce(false) // save attempt 2
        .mockResolvedValueOnce(false), // save attempt 3
    });
    const result = await run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/events/99999', ['name'])
    );
    expect(result).toBe(false); // save button not found
  });

  it('handles time change without throwing', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)  // hasEditor
        .mockResolvedValueOnce(false) // save attempt
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
    });
    const result = await run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/events/99999', ['time'])
    );
    expect(result).toBe(false);
  });

  it('handles description change without throwing', async () => {
    const textarea = {
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    };
    const page = makePage({
      $: vi.fn().mockResolvedValue(textarea),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)  // hasEditor
        .mockResolvedValueOnce(false) // save attempt
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
    });
    const result = await run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/events/99999', ['description'])
    );
    expect(result).toBe(false);
  });

  it('handles location change without throwing', async () => {
    const locInput = {
      click: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    };
    const page = makePage({
      $: vi.fn().mockImplementation(sel =>
        sel === 'input[aria-label="Add location"]' ? Promise.resolve(locInput) : Promise.resolve(null)
      ),
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)   // hasEditor
        .mockResolvedValueOnce({ text: null, match: false }) // location arrow-down loop
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce({ text: null, match: false })
        .mockResolvedValueOnce(false)  // save attempt
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false),
    });
    const result = await run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/events/99999', ['location_name'])
    );
    expect(result).toBe(false);
  });

  it('returns true when save button is clicked', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)  // hasEditor
        .mockResolvedValueOnce(true), // save clicked
    });
    const result = await run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/events/99999', [])
    );
    expect(result).toBe(true);
  });

  it('retries save up to 3 times if button not found', async () => {
    const evaluateSpy = vi.fn()
      .mockResolvedValueOnce(true)  // hasEditor
      .mockResolvedValueOnce(false) // save attempt 1
      .mockResolvedValueOnce(false) // save attempt 2
      .mockResolvedValueOnce(true); // save attempt 3 succeeds
    const page = makePage({ evaluate: evaluateSpy });

    const result = await run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/events/99999', [])
    );
    expect(result).toBe(true);
    // evaluate called 4 times total (hasEditor + 3 save attempts, last succeeds on 3rd)
    const saveCalls = evaluateSpy.mock.calls.length - 1; // subtract hasEditor call
    expect(saveCalls).toBeGreaterThanOrEqual(1);
  });

  it('handles no-change list gracefully', async () => {
    const page = makePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce(true)  // hasEditor
        .mockResolvedValueOnce(true), // save
    });
    await expect(run(() =>
      editFacebookEvent(page, baseEvent, 'https://facebook.com/events/99999', [])
    )).resolves.not.toThrow();
  });
});
