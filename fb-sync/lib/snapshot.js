'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TMP_DIR = path.join(__dirname, '..', 'tmp');

// Build a snapshot of the fields we track for change detection
async function eventSnapshot(event) {
  const snapshot = {
    name: event.name || '',
    time: event.time || 0,
    location_name: event.location_name || '',
    location_address: event.location_address || '',
    location_city: event.location_city || '',
    description: event.description || '',
    image_url: '',
    image_hash: ''
  };

  const imgUrl =
    event.photo ||
    event.image ||
    event.featured_photo ||
    (event.photos && event.photos[0] && event.photos[0].highres_link) ||
    event.image_url ||
    '';

  if (imgUrl) {
    snapshot.image_url = imgUrl;
    try {
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
      const tmpPath = path.join(TMP_DIR, `img-${event.id}.bin`);
      const res = await fetch(imgUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(tmpPath, buf);
        snapshot.image_hash = crypto.createHash('sha1').update(buf).digest('hex');
        try { fs.unlinkSync(tmpPath); } catch (e) {}
      }
    } catch (e) {
      console.warn('Failed to fetch/hash image for', event.id, e.message);
    }
  }

  return snapshot;
}

// Returns an array of field names that differ between two snapshots
function changedFields(oldSnap, newSnap) {
  const changed = [];
  for (const key of Object.keys(newSnap)) {
    if (String(oldSnap[key] || '') !== String(newSnap[key] || '')) {
      changed.push(key);
    }
  }
  return changed;
}

module.exports = { eventSnapshot, changedFields };
