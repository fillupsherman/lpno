/**
 * Meetup → Facebook Event Sync
 * Fetches events from your Meetup worker, then creates them on your Facebook Page
 * using a stealth Puppeteer browser. Saves session so you only log in once.
 * Run manually: node sync.js
 * Schedule daily via Windows Task Scheduler.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { sleep, fetchMeetupEvents }                    = require('./lib/meetup');
const { eventSnapshot, changedFields }               = require('./lib/snapshot');
const { loadSynced, saveSynced, findSyncedEntry }    = require('./lib/synced-store');
const { loadBrowserSession, isLoggedIn, login }      = require('./lib/fb-auth');
const { createFacebookEvent, findCreatedEventOnPage } = require('./lib/fb-create');
const { uploadPhoto, editFacebookEvent }             = require('./lib/fb-edit');
const { handleDeletedMeetupEvents }                  = require('./lib/fb-delete');




// Upload a meetup image to a Facebook event via the edit UI (Puppeteer)
async function main() {
  console.log('Fetching Meetup events...');
  const events = await fetchMeetupEvents();
  console.log(`Found ${events.length} events on Meetup.`);

  const synced = loadSynced();
  const toCreate = [];
  const toUpdate = [];

  for (const event of events) {
    const newSnap = await eventSnapshot(event);
    const found = findSyncedEntry(synced, event);
    if (!found) {
      toCreate.push({ event, snapshot: newSnap });
    } else {
      const { fbId, entry } = found;
      // If Meetup changed the ID for this event, update our record
      if (String(entry.meetup_id || '') !== String(event.id)) {
        console.log(`Meetup ID updated for "${event.name}": ${entry.meetup_id} → ${event.id}`);
        entry.meetup_id = String(event.id);
        saveSynced(synced);
      }
      if (entry.meetup_data) {
        const changes = changedFields(entry.meetup_data, newSnap);
        // Also flag image if what's on FB (fb_image_hash) differs from Meetup's current image
        if (!changes.includes('image_hash') && newSnap.image_hash &&
            (entry.fb_image_hash || '') !== newSnap.image_hash) {
          changes.push('image_hash');
        }
        if (changes.length > 0) {
          toUpdate.push({ event, changes, fb_url: entry.fb_url, fbId, snapshot: newSnap });
        }
      }
    }
  }

  // Find synced entries with no matching Meetup event (need FB deletion)
  const matchedFbIds = new Set();
  for (const event of events) {
    const found = findSyncedEntry(synced, event);
    if (found) matchedFbIds.add(found.fbId);
  }
  const deletedIds = Object.keys(synced).filter(fbId => !matchedFbIds.has(fbId) && synced[fbId] && synced[fbId].fb_url);

  if (toCreate.length === 0 && toUpdate.length === 0 && deletedIds.length === 0) {
    console.log('All events already synced and up to date. Nothing to do.');
    return;
  }

  console.log(`${toCreate.length} new event(s) to create, ${toUpdate.length} event(s) to update.`);

  const headlessMode = process.env.HEADLESS === '1' || process.env.HEADLESS === 'true';
  const browser = await puppeteer.launch({
    headless: headlessMode,
    defaultViewport: null,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    userDataDir: process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\User Data',
    args: headlessMode ? ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'] : ['--profile-directory=Default','--start-maximized','--no-sandbox'],
    // increase CDP protocol timeout for long UI interactions
    protocolTimeout: 120000
  });

  const [page] = await browser.pages();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  // Using existing Chrome profile — should already be logged into Facebook
  const sessionLoaded = await loadBrowserSession(page);
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    console.log('Not logged into Facebook — please log in manually in the browser window...');
    await login(page);
  } else {
    console.log('Already logged in via Chrome profile ✅');
  }

  // Detect Meetup-deleted events and reconcile with Facebook
  try {
    if (deletedIds.length > 0) {
      console.log(`Detected ${deletedIds.length} Meetup-deleted event(s). Processing: ${deletedIds.join(', ')}`);
      await handleDeletedMeetupEvents(browser, synced, deletedIds);
    }
  } catch (e) { console.warn('Deletion handling failed (continuing):', e.message); }

  // ── Create new events ──────────────────────────────────────────────────────
  let createCount = 0; let createdEvents = [];
  for (const item of toCreate) {
    const event = item.event; const snapshot = item.snapshot;
    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      try { await loadBrowserSession(page); } catch (e) { /* ignore */ }
      await page.bringToFront();

      const fbUrl = await createFacebookEvent(page, event);
      let fbId = null;

      if (fbUrl && fbUrl !== 'unknown') {
        const m = String(fbUrl).match(/\/events\/(\d+)/);
        if (!m) {
          console.warn(`Cannot extract numeric FB event ID from URL "${fbUrl}" — attempting recovery search...`);
        } else {
          fbId = m[1];
        }
      }

      // If creation succeeded but URL was unknown (or non-numeric), search the page's events list
      if (!fbId && fbUrl !== false) {
        console.log(`  Create returned "${fbUrl}" — searching page events to recover FB event ID...`);
        fbId = await findCreatedEventOnPage(page, event);
        if (!fbId) {
          console.warn(`  Could not find "${event.name}" on the page events list. Will retry next run.`);
        }
      }

      if (fbId) {
        synced[fbId] = {
          meetup_id: String(event.id),
          name: event.name,
          fb_url: `https://www.facebook.com/events/${fbId}`,
          synced_at: new Date().toISOString(),
          meetup_data: snapshot
        };
        saveSynced(synced);
        createCount++; createdEvents.push({ id: event.id, name: event.name });

        // Upload cover photo for newly created event
        try {
          const uploaded = await uploadPhoto(page, event, `https://www.facebook.com/events/${fbId}`);
          if (uploaded) {
            // uploadPhoto staged the image on the edit page but didn't save — click Save now
            let saveClicked = false;
            for (let attempt = 0; attempt < 3 && !saveClicked; attempt++) {
              if (attempt > 0) await sleep(1500);
              saveClicked = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('button, [role="button"]'));
                const btn = els.find(el => {
                  const txt = (el.innerText || '').trim().toLowerCase();
                  const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                  const testid = (el.getAttribute('data-testid') || '').toLowerCase();
                  return /^(save|update|done|publish)$/.test(txt) ||
                         /save|update|done|publish/.test(aria) ||
                         /event_create_done_button|event_update_button/.test(testid);
                });
                if (btn) { btn.click(); return true; }
                return false;
              });
            }
            if (saveClicked) {
              await sleep(4000); // wait for save to complete before closing
              synced[fbId].fb_image_hash = snapshot.image_hash;
              saveSynced(synced);
              console.log(`  Cover photo uploaded for "${event.name}".`);
            } else {
              console.warn(`  Save button not found after photo upload for "${event.name}" — photo may not have saved.`);
            }
          }
        } catch (e) { console.warn('Cover photo upload after create failed:', e.message); }
      }
      await sleep(3000);
    } catch (err) {
      console.error(`Failed to create event "${event.name}":`, err.message);
    } finally {
      try { if (page && !page.isClosed()) await page.close(); } catch (e) {}
    }
  }

  // ── Update changed events ─────────────────────────────────────────────────
  let updateCount = 0; let updatedEvents = [];
  for (const item of toUpdate) {
    const event = item.event; const changes = item.changes; const fb_url = item.fb_url; const snapshot = item.snapshot;
    if (!fb_url || fb_url === 'unknown') {
      console.warn(`Cannot update "${event.name}" — no FB URL stored. Skipping.`);
      continue;
    }
    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      try { await loadBrowserSession(page); } catch (e) { /* ignore */ }
      await page.bringToFront();

      console.log(`\nUpdating "${event.name}" — changed: ${changes.join(', ')}`);
      const ok = await editFacebookEvent(page, event, fb_url, changes);
      if (ok) {
        synced[item.fbId].meetup_data = snapshot;
        synced[item.fbId].meetup_id = String(event.id);
        synced[item.fbId].synced_at = new Date().toISOString();
        if (changes.includes('image_hash')) {
          synced[item.fbId].fb_image_hash = snapshot.image_hash;
        }
        saveSynced(synced);
        updateCount++;
        updatedEvents.push({ id: event.id, name: event.name, changes });
      }
      await sleep(3000);
    } catch (err) {
      console.error(`Failed to update event "${event.name}":`, err.message);
    } finally {
      try { if (page && !page.isClosed()) await page.close(); } catch (e) {}
    }
  }

  console.log(`\nDone. ${createCount}/${toCreate.length} created, ${updateCount}/${toUpdate.length} updated.`);
  if (createdEvents.length) console.log('Created:', createdEvents.map(e => `${e.name} (${e.id})`).join('; '));
  if (updatedEvents.length) console.log('Updated:', updatedEvents.map(e => `${e.name} (${e.id}) — changes: ${e.changes.join(', ')}`).join('; '));
  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
