import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { sleep, stripHtml, formatDateTimeLocal, fetchMeetupEvents, WORKER_URL } = require('./lib/meetup.js');

// ── sleep ────────────────────────────────────────────────────────────────────
describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('returns a Promise', () => {
    expect(sleep(0)).toBeInstanceOf(Promise);
  });
});

// ── stripHtml ─────────────────────────────────────────────────────────────────
describe('stripHtml', () => {
  it('strips basic tags', () => {
    expect(stripHtml('<p>Hello</p>')).toBe('Hello');
  });

  it('strips nested tags', () => {
    expect(stripHtml('<b><em>Bold italic</em></b>')).toBe('Bold italic');
  });

  it('decodes &amp;', () => {
    expect(stripHtml('Cats &amp; Dogs')).toBe('Cats & Dogs');
  });

  it('decodes &lt; and &gt;', () => {
    expect(stripHtml('&lt;script&gt;')).toBe('<script>');
  });

  it('decodes &nbsp;', () => {
    expect(stripHtml('a&nbsp;b')).toBe('a b');
  });

  it('trims whitespace', () => {
    expect(stripHtml('  hello  ')).toBe('hello');
  });

  it('handles null/undefined gracefully', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml('')).toBe('');
  });
});

// ── formatDateTimeLocal ───────────────────────────────────────────────────────
describe('formatDateTimeLocal', () => {
  it('formats a timestamp to YYYY-MM-DDTHH:MM', () => {
    // Use a fixed local date: Jan 5 2025 09:07
    const d = new Date(2025, 0, 5, 9, 7); // local time
    const result = formatDateTimeLocal(d.getTime());
    expect(result).toBe('2025-01-05T09:07');
  });

  it('zero-pads month, day, hour, minute', () => {
    const d = new Date(2025, 2, 3, 4, 5); // Mar 3 2025 04:05 local
    expect(formatDateTimeLocal(d.getTime())).toBe('2025-03-03T04:05');
  });

  it('handles midnight correctly', () => {
    const d = new Date(2025, 5, 15, 0, 0); // Jun 15 2025 00:00 local
    expect(formatDateTimeLocal(d.getTime())).toBe('2025-06-15T00:00');
  });
});

// ── WORKER_URL ────────────────────────────────────────────────────────────────
describe('WORKER_URL', () => {
  it('is the correct worker endpoint', () => {
    expect(WORKER_URL).toBe('https://lpno.lpno-dev.workers.dev/events');
  });
});

// ── fetchMeetupEvents ─────────────────────────────────────────────────────────
describe('fetchMeetupEvents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON on success', async () => {
    const fakeEvents = [{ id: '1', name: 'Test Event' }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeEvents
    });
    const result = await fetchMeetupEvents('https://example.com/events');
    expect(result).toEqual(fakeEvents);
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/events');
  });

  it('throws on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    await expect(fetchMeetupEvents('https://example.com/events')).rejects.toThrow('Worker error: 502');
  });

  it('uses WORKER_URL by default', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    await fetchMeetupEvents();
    expect(global.fetch).toHaveBeenCalledWith(WORKER_URL);
  });
});
