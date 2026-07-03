'use strict';

const fs = require('fs');
const path = require('path');

const SYNCED_FILE = path.join(__dirname, '..', 'synced-events.json');

function loadSynced(filePath = SYNCED_FILE) {
  if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath));
  return {};
}

function saveSynced(data, filePath = SYNCED_FILE) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Find a synced entry for a Meetup event.
// First tries exact meetup_id match, then falls back to name+date (within 24h).
// Returns { fbId, entry } or null.
function findSyncedEntry(synced, event) {
  const meetupId = String(event.id);
  const eventName = (event.name || '').trim().toLowerCase();
  const eventTime = event.time || 0;

  for (const [fbId, entry] of Object.entries(synced)) {
    if (String(entry.meetup_id || '') === meetupId) return { fbId, entry };
  }

  // Fallback: name + date match (handles Meetup re-keying recurring events)
  for (const [fbId, entry] of Object.entries(synced)) {
    const storedName = (entry.name || '').trim().toLowerCase();
    const storedTime = (entry.meetup_data && entry.meetup_data.time) || 0;
    if (
      storedName === eventName &&
      storedTime &&
      Math.abs(storedTime - eventTime) < 24 * 3600 * 1000
    ) {
      return { fbId, entry };
    }
  }

  return null;
}

module.exports = { loadSynced, saveSynced, findSyncedEntry, SYNCED_FILE };
