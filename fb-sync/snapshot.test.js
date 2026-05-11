import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { eventSnapshot, changedFields } = require('./lib/snapshot.js');

// ── changedFields ─────────────────────────────────────────────────────────────
describe('changedFields', () => {
  it('returns empty array when snapshots are identical', () => {
    const snap = { name: 'Test', time: 1000, description: 'Hello' };
    expect(changedFields(snap, snap)).toEqual([]);
  });

  it('detects a changed name', () => {
    const old = { name: 'Old Name', time: 1000 };
    const next = { name: 'New Name', time: 1000 };
    expect(changedFields(old, next)).toContain('name');
  });

  it('detects a changed time', () => {
    const old = { name: 'Event', time: 1000 };
    const next = { name: 'Event', time: 2000 };
    expect(changedFields(old, next)).toContain('time');
  });

  it('detects multiple changes at once', () => {
    const old = { name: 'A', time: 1, description: 'old desc' };
    const next = { name: 'B', time: 2, description: 'new desc' };
    const result = changedFields(old, next);
    expect(result).toContain('name');
    expect(result).toContain('time');
    expect(result).toContain('description');
  });

  it('treats missing old field as empty string', () => {
    const old = {};
    const next = { name: 'Something', time: 0 };
    expect(changedFields(old, next)).toContain('name');
  });

  it('does not flag field as changed when both are empty-ish', () => {
    const old = { name: '', image_hash: undefined };
    const next = { name: '', image_hash: '' };
    expect(changedFields(old, next)).toEqual([]);
  });
});

// ── eventSnapshot ─────────────────────────────────────────────────────────────
describe('eventSnapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a snapshot from a plain event with no image', async () => {
    const event = {
      id: '1',
      name: 'Test Event',
      time: 1700000000000,
      location_name: 'The Venue',
      location_address: '123 Main St',
      location_city: 'Detroit, MI',
      description: '<p>Hello</p>'
    };
    const snap = await eventSnapshot(event);
    expect(snap.name).toBe('Test Event');
    expect(snap.time).toBe(1700000000000);
    expect(snap.location_name).toBe('The Venue');
    expect(snap.location_address).toBe('123 Main St');
    expect(snap.location_city).toBe('Detroit, MI');
    expect(snap.description).toBe('<p>Hello</p>');
    expect(snap.image_url).toBe('');
    expect(snap.image_hash).toBe('');
  });

  it('defaults missing fields to empty/zero', async () => {
    const snap = await eventSnapshot({ id: '2' });
    expect(snap.name).toBe('');
    expect(snap.time).toBe(0);
    expect(snap.location_name).toBe('');
    expect(snap.image_url).toBe('');
    expect(snap.image_hash).toBe('');
  });

  it('prefers image_url field for image', async () => {
    const fakeBytes = Buffer.from('fakeimage');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => fakeBytes.buffer
    });

    const event = { id: '3', image_url: 'https://img.example.com/photo.jpg' };
    const snap = await eventSnapshot(event);

    expect(snap.image_url).toBe('https://img.example.com/photo.jpg');
    expect(snap.image_hash).toHaveLength(40); // SHA-1 hex
  });

  it('prefers photo > image > featured_photo > photos[0] > image_url', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('x').buffer
    });

    const event = {
      id: '4',
      photo: 'https://a.com/photo.jpg',
      image: 'https://b.com/image.jpg',
      image_url: 'https://c.com/img.jpg'
    };
    const snap = await eventSnapshot(event);
    expect(snap.image_url).toBe('https://a.com/photo.jpg');
  });

  it('leaves image_hash empty if fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const event = { id: '5', image_url: 'https://img.example.com/bad.jpg' };
    const snap = await eventSnapshot(event);
    expect(snap.image_hash).toBe('');
  });

  it('leaves image_hash empty if fetch returns non-ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const event = { id: '6', image_url: 'https://img.example.com/missing.jpg' };
    const snap = await eventSnapshot(event);
    expect(snap.image_hash).toBe('');
  });
});
