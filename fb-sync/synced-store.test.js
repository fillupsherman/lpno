import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { loadSynced, saveSynced, findSyncedEntry } = require('./lib/synced-store.js');

// Use a temp file for all read/write tests
let tmpFile;
beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `synced-test-${Date.now()}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) {}
});

// ── loadSynced ────────────────────────────────────────────────────────────────
describe('loadSynced', () => {
  it('returns {} when file does not exist', () => {
    expect(loadSynced('/nonexistent/path.json')).toEqual({});
  });

  it('parses and returns file contents', () => {
    const data = { '123': { name: 'Test', meetup_id: '99' } };
    fs.writeFileSync(tmpFile, JSON.stringify(data));
    expect(loadSynced(tmpFile)).toEqual(data);
  });

  it('returns empty object for empty JSON object file', () => {
    fs.writeFileSync(tmpFile, '{}');
    expect(loadSynced(tmpFile)).toEqual({});
  });
});

// ── saveSynced ────────────────────────────────────────────────────────────────
describe('saveSynced', () => {
  it('writes JSON to the given file path', () => {
    const data = { '456': { name: 'My Event' } };
    saveSynced(data, tmpFile);
    const raw = fs.readFileSync(tmpFile, 'utf8');
    expect(JSON.parse(raw)).toEqual(data);
  });

  it('overwrites existing file', () => {
    saveSynced({ old: true }, tmpFile);
    saveSynced({ new: true }, tmpFile);
    expect(JSON.parse(fs.readFileSync(tmpFile, 'utf8'))).toEqual({ new: true });
  });

  it('pretty-prints with 2-space indent', () => {
    saveSynced({ a: 1 }, tmpFile);
    const raw = fs.readFileSync(tmpFile, 'utf8');
    expect(raw).toContain('\n  ');
  });
});

// ── findSyncedEntry ───────────────────────────────────────────────────────────
describe('findSyncedEntry', () => {
  const synced = {
    'fb111': { meetup_id: '42', name: 'Jazz Night', fb_url: 'https://fb.com/events/fb111', meetup_data: { time: 1700000000000 } },
    'fb222': { meetup_id: '99', name: 'Art Show',   fb_url: 'https://fb.com/events/fb222', meetup_data: { time: 1700100000000 } }
  };

  it('finds entry by exact meetup_id', () => {
    const result = findSyncedEntry(synced, { id: '42', name: 'Jazz Night', time: 1700000000000 });
    expect(result).not.toBeNull();
    expect(result.fbId).toBe('fb111');
    expect(result.entry.meetup_id).toBe('42');
  });

  it('finds correct entry when multiple exist', () => {
    const result = findSyncedEntry(synced, { id: '99', name: 'Art Show', time: 1700100000000 });
    expect(result.fbId).toBe('fb222');
  });

  it('returns null when no match found', () => {
    expect(findSyncedEntry(synced, { id: '999', name: 'Unknown', time: 0 })).toBeNull();
  });

  it('falls back to name+date match within 24h when meetup_id differs', () => {
    const result = findSyncedEntry(synced, {
      id: 'new-id-for-jazz',       // meetup re-keyed the event
      name: 'Jazz Night',
      time: 1700000000000 + 3600000 // 1 hour later — within 24h window
    });
    expect(result).not.toBeNull();
    expect(result.fbId).toBe('fb111');
  });

  it('does NOT match name+date when time diff exceeds 24h', () => {
    const result = findSyncedEntry(synced, {
      id: 'new-id',
      name: 'Jazz Night',
      time: 1700000000000 + 25 * 3600 * 1000 // 25 hours later
    });
    expect(result).toBeNull();
  });

  it('name match is case-insensitive', () => {
    const result = findSyncedEntry(synced, {
      id: 'new-id',
      name: 'JAZZ NIGHT',
      time: 1700000000000
    });
    expect(result).not.toBeNull();
    expect(result.fbId).toBe('fb111');
  });

  it('returns null for empty synced store', () => {
    expect(findSyncedEntry({}, { id: '1', name: 'Test', time: 0 })).toBeNull();
  });
});
