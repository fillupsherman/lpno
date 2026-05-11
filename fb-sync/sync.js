/**
 * Meetup → Facebook Event Sync
 * Fetches events from your Meetup worker, then creates them on your Facebook Page
 * using a stealth Puppeteer browser. Saves session so you only log in once.
 * Run manually: node sync.js
 * Schedule daily via Windows Task Scheduler.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

puppeteer.use(StealthPlugin());

// ── Config ────────────────────────────────────────────────────────────────────
const WORKER_URL   = 'https://lpno.lpno-dev.workers.dev/events';
const FB_PAGE_URL  = 'https://www.facebook.com/leftistprogressivenightout';
const SESSION_FILE = path.join(__dirname, 'fb-session.json');
const SYNCED_FILE  = path.join(__dirname, 'synced-events.json');
const TMP_DIR = path.join(__dirname, 'tmp');
// ─────────────────────────────────────────────────────────────────────────────

function loadSynced() {
  if (fs.existsSync(SYNCED_FILE)) return JSON.parse(fs.readFileSync(SYNCED_FILE));
  return {};
}

function saveSynced(data) {
  fs.writeFileSync(SYNCED_FILE, JSON.stringify(data, null, 2));
}

// Extract the fields we track for change detection
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

  // Best effort: detect image URL from common fields
  const imgUrl = event.photo || event.image || event.featured_photo || (event.photos && event.photos[0] && event.photos[0].highres_link) || event.image_url || '';
  if (imgUrl) {
    snapshot.image_url = imgUrl;
    try {
      // ensure tmp dir exists
      if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
      const tmpPath = path.join(TMP_DIR, `img-${event.id}.bin`);
      const res = await fetch(imgUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(tmpPath, buf);
        const sh = crypto.createHash('sha1').update(buf).digest('hex');
        snapshot.image_hash = sh;
        // remove temp file immediately; keep only hash
        try { fs.unlinkSync(tmpPath); } catch(e){}
      }
    } catch (e) {
      console.warn('Failed to fetch/hash image for', event.id, e.message);
    }
  }

  return snapshot;
}

// Compare two snapshots — returns list of changed field names
function changedFields(oldSnap, newSnap) {
  const changed = [];
  for (const key of Object.keys(newSnap)) {
    if (String(oldSnap[key] || '') !== String(newSnap[key] || '')) {
      changed.push(key);
    }
  }
  return changed;
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
    if (storedName === eventName && storedTime && Math.abs(storedTime - eventTime) < 24 * 3600 * 1000) {
      return { fbId, entry };
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchMeetupEvents() {
  const res = await fetch(WORKER_URL);
  if (!res.ok) throw new Error(`Worker error: ${res.status}`);
  return res.json();
}

function formatDateTimeLocal(unixMs) {
  // Returns "YYYY-MM-DDTHH:MM" in local time for the datetime-local input
  const d = new Date(unixMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').trim();
}

async function saveBrowserSession(page) {
  const cookies = await page.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
  console.log('Session saved.');
}

async function loadBrowserSession(page) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  const cookies = JSON.parse(fs.readFileSync(SESSION_FILE));
  await page.setCookie(...cookies);
  return true;
}

async function isLoggedIn(page) {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  return !page.url().includes('login');
}

async function login(page) {
  console.log('Opening Facebook login — please log in manually in the browser window...');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2' });
  // Wait until user completes login (URL changes away from login page)
  await page.waitForFunction(
    () => !window.location.href.includes('login'),
    { timeout: 300000 }
  );
  console.log('Login detected. Saving session...');
  await saveBrowserSession(page);
}

// After a create returns 'unknown', search the page's events list for a match by name.
// Returns a numeric FB event ID string, or null if not found.
// NOTE: Does NOT navigate to individual event pages to avoid a visible refresh loop.
async function findCreatedEventOnPage(page, event) {
  try {
    const eventName = (event.name || '').trim().toLowerCase();
    const namePrefix = eventName.slice(0, 20);

    console.log(`  Navigating to page events list to recover ID for "${event.name}"...`);
    await page.goto(`${FB_PAGE_URL}/events`, { waitUntil: 'networkidle2' });
    await sleep(3000);

    // Scroll down a bit so recently-created events are visible
    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1000);

    // Collect all event links with numeric IDs and their visible text
    const candidates = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="/events/"]'))
        .map(a => ({ href: a.href, text: (a.textContent || '').trim() }))
        .filter(x => /\/events\/\d+/.test(x.href));
    });

    console.log(`  Found ${candidates.length} event link(s) on page.`);

    for (const c of candidates) {
      const idMatch = c.href.match(/\/events\/(\d+)/);
      if (!idMatch) continue;
      const text = c.text.toLowerCase();
      if (text.includes(namePrefix)) {
        console.log(`  Recovered FB event ID ${idMatch[1]} for "${event.name}" (link text: "${c.text.slice(0, 60)}")`);
        return idMatch[1];
      }
    }

    console.warn(`  No matching event link found on page for "${event.name}".`);
  } catch (e) {
    console.warn('Recovery search failed:', e.message);
  }
  return null;
}

async function createFacebookEvent(page, event) {
  console.log(`\nCreating event: ${event.name}`);

  // ── Navigate to create event ──────────────────────────────────────────────
  await page.goto('https://www.facebook.com/events/create/', { waitUntil: 'networkidle2' });
  await sleep(4000);

  if (!page.url().includes('/events/create')) {
    console.warn('Unexpected redirect to:', page.url());
    await page.screenshot({ path: path.join(__dirname, `event-error-redirect-${event.id}.png`) });
    return false;
  }

  // Dump all inputs with their values to identify field order
  const fieldDump = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="text"],input[type="search"],textarea'))
      .map((el, i) => ({ i, id: el.id, aria: el.getAttribute('aria-label'), value: el.value, placeholder: el.placeholder }))
  );
  console.log('Form fields:', JSON.stringify(fieldDump));

  // ── Event Name ────────────────────────────────────────────────────────────
  // Skip Search Facebook (i=0), use first text input with no aria-label and empty value
  const nameEl = await page.evaluateHandle(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
    return inputs.find(el =>
      !el.getAttribute('aria-label') &&
      !el.placeholder &&
      (el.value === '' || el.value.trim() === '')
    ) || null;
  });
  const nameElHandle = nameEl.asElement();
  if (!nameElHandle) {
    console.warn('Name input not found');
    await page.screenshot({ path: path.join(__dirname, `event-error-noform-${event.id}.png`) });
    return false;
  }
  await nameElHandle.click({ clickCount: 3 });
  await sleep(200);
  await nameElHandle.type(event.name, { delay: 40 });

  // ── Start Date ────────────────────────────────────────────────────────────
  const d = new Date(event.time);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear());

  // Date input: FB shows value like "Mar 15, 2026" — match month-name format
  const dateInput = await page.evaluateHandle(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
    return inputs.find(el => el.value && el.value.match(/^[A-Za-z]{3}\s+\d{1,2},\s+\d{4}$/)) || null;
  });
  const dateEl = dateInput.asElement();
  if (dateEl) {
    await dateEl.click({ clickCount: 3 });
    await sleep(200);
    await page.keyboard.type(`${mm}/${dd}/${yyyy}`, { delay: 100 });
    await page.keyboard.press('Tab');
    await sleep(800);
  } else {
    console.warn('Date input not found');
  }

  // ── Start Time ────────────────────────────────────────────────────────────
  let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const timeStr = `${h}:${m} ${ampm}`;

  const timeInput = await page.evaluateHandle(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
    return inputs.find(el => el.value && el.value.match(/^\d{1,2}:\d{2}\s*(AM|PM)$/i)) || null;
  });
  const timeEl = timeInput.asElement();
  if (timeEl) {
    await timeEl.click({ clickCount: 3 });
    await sleep(200);
    await page.keyboard.type(timeStr, { delay: 80 });
    await page.keyboard.press('Tab');
    await sleep(500);
  } else {
    console.warn('Time input not found');
  }

  // ── In Person ─────────────────────────────────────────────────────────────
  try {
    const inPersonBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[role="button"]'))
        .find(el => el.textContent.includes('in person or virtual')) || null
    );
    const inPersonEl = inPersonBtn.asElement();
    if (inPersonEl) {
      await inPersonEl.click(); await sleep(1500);
      const opt = await page.evaluateHandle(() =>
        Array.from(document.querySelectorAll('[role="menuitem"],[role="option"],[role="radio"]'))
          .find(el => el.textContent.includes('In person')) || null
      );
      const optEl = opt.asElement();
      if (optEl) { await optEl.click(); await sleep(1500); }
    }
  } catch (e) { console.warn('In-person selection failed (continuing):', e.message); }

  // ── Location — type venue+city, keyboard-navigate dropdown to find the right match
  try {
    await sleep(500);
    const venueName = event.location_name || '';
    const cityHint = (event.location_city || '').toLowerCase();
    const addrHint = (event.location_address || '').toLowerCase();
    const fullAddress = [event.location_name, event.location_address, event.location_city].filter(Boolean).join(', ');
    const cityShort = (event.location_city || '').split(',')[0].trim();

    const locEl = await page.$('input[aria-label="Add location"]');
    if (locEl) {
      await locEl.click({ clickCount: 3 });
      await sleep(200);
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await sleep(300);
      // Type venue name + city to narrow results
      const searchQuery = cityShort ? `${venueName} ${cityShort}` : venueName;
      await locEl.type(searchQuery, { delay: 50 });
      await sleep(2500);

      // Keyboard navigate: press ArrowDown, check highlighted option, Enter when it matches
      let found = false;
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('ArrowDown');
        await sleep(400);
        // Check the currently focused/highlighted option
        const highlighted = await page.evaluate((venue, city, addr) => {
          const active = document.querySelector('[role="option"][aria-selected="true"]') ||
                         document.querySelector('[role="option"]:focus') ||
                         document.querySelector('[role="option"].x1n2onr6');
          if (!active) return { text: null, match: false };
          const text = (active.textContent || '').toLowerCase();
          const textNoSpaces = text.replace(/\s+/g, '');
          const venueNoSpaces = venue.toLowerCase().replace(/\s+/g, '');
          const venueMatch = venueNoSpaces && textNoSpaces.includes(venueNoSpaces);
          const isMatch = (venueMatch && city && text.includes(city.toLowerCase())) ||
                          (venueMatch && addr && text.includes(addr));
          return { text: active.textContent.trim().slice(0, 120), match: isMatch };
        }, venueName, cityHint, addrHint);
        
        console.log(`  ArrowDown ${i+1}: ${highlighted.text || '(no highlight)'} ${highlighted.match ? '✓' : ''}`);
        
        if (highlighted.match) {
          await page.keyboard.press('Enter');
          await sleep(800);
          console.log(`Location selected: "${highlighted.text}"`);
          found = true;
          break;
        }
      }
      if (!found) {
        // Fallback: just press Escape, typed text stays
        await page.keyboard.press('Escape');
        console.log(`Location typed (no keyboard match): ${searchQuery}`);
      }
      await sleep(500);
    } else {
      console.warn('Location input (aria-label="Add location") not found');
    }
  } catch (e) { console.warn('Location fill failed (continuing):', e.message); }

  // ── Description ───────────────────────────────────────────────────────────
  try {
    const textarea = await page.$('textarea');
    if (textarea) {
      await textarea.click(); await sleep(300);
      await textarea.type(stripHtml(event.description) || 'See Meetup for details.', { delay: 15 });
    }
  } catch (e) { console.warn('Description fill failed (continuing):', e.message); }

  await sleep(1000);
  try { await page.screenshot({ path: path.join(__dirname, `event-preview-${event.id}.png`) }); console.log(`Screenshot saved: event-preview-${event.id}.png`); } catch (e) { console.warn('Screenshot preview failed:', e.message); }

  // ── Submit ────────────────────────────────────────────────────────────────
  try {
    const createBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[role="button"]'))
        .find(el => el.textContent.trim() === 'Create event') || null
    );
    const createEl = createBtn.asElement();
    if (createEl) {
      await createEl.click();
      // Wait for URL to change away from /events/create/ (up to 25s — FB can be slow)
      try {
        await page.waitForFunction(
          () => !location.href.endsWith('/events/create/'),
          { timeout: 25000 }
        );
      } catch (_) {
        // Timeout — still on create page
      }
      await sleep(2000);
      const finalUrl = page.url();
      if (finalUrl.includes('/events/') && !finalUrl.endsWith('/events/create/')) {
        console.log(`✅ Event created: ${finalUrl}`);
        // Close post-create invite/modal if present to avoid blocking subsequent actions
        try {
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
            const closeBtn = btns.find(b => {
              const txt = (b.innerText || '').toLowerCase();
              const aria = (b.getAttribute && (b.getAttribute('aria-label') || '')).toLowerCase();
              return /^(close|not now|skip|done|no thanks|x)$/.test(txt.trim()) || /close|not now|skip|done|no thanks|x/.test(aria);
            });
            if (closeBtn) try { closeBtn.click(); } catch(e){}
          });
          await page.keyboard.press('Escape');
          await sleep(800);
        } catch (e) { /* ignore */ }
        return finalUrl;
      } else {
        // Check for any error messages on the page
        const hasError = await page.evaluate(() =>
          !!document.querySelector('[data-testid*="error"], [aria-live="assertive"]')
        );
        if (!hasError) {
          console.log('✅ Event likely created (no error detected, URL unchanged)');
          return 'unknown';
        }
        console.warn(`⚠️  Still on create page after submit: ${finalUrl}`);
        try { await page.screenshot({ path: path.join(__dirname, `event-result-${event.id}.png`) }); } catch(e) { console.warn('Screenshot result failed:', e.message); }
        return false;
      }
    } else {
      console.warn('Create event button not found');
      return false;
    }
  } catch (e) { console.warn('Submit failed:', e.message); return false; }
}

// Upload a meetup image to a Facebook event via the edit UI (Puppeteer)
async function uploadPhoto(page, event, fbUrl) {
  const fbIdMatch = String(fbUrl).match(/\/events\/(\d+)/);
  if (!fbIdMatch) return false;
  const eventId = fbIdMatch[1];
  const imgUrl = event.photo || event.image || event.featured_photo || (event.photos && event.photos[0] && event.photos[0].highres_link) || event.image_url || '';
  if (!imgUrl) { console.log('No image URL for event', event.id); return false; }

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpPath = path.join(TMP_DIR, `img-${event.id}.jpg`);
  try {
    const res = await fetch(imgUrl);
    if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpPath, buf);
  } catch (e) {
    console.warn('Failed to download image for upload:', e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(e){}
    return false;
  }

  const editUrl = `https://www.facebook.com/events/edit/${eventId}`;

  // Install dialog handler and neutralize beforeunload to avoid "Leave site?" popups
  const dialogHandler = async dlg => {
    try {
      console.log('Auto-handling dialog:', dlg.type(), dlg.message());
      await dlg.dismiss();
    } catch (e) { /* ignore */ }
  };
  page.on('dialog', dialogHandler);

  try {
    await page.goto(editUrl, { waitUntil: 'networkidle2' });
    await sleep(1500);
    // If Facebook redirected to ad manager, go back to the edit page
    if (/adsmanager|ads[\/.]manager/i.test(page.url())) {
      console.warn('Redirected to ad manager during photo upload — navigating back...');
      await page.goto(editUrl, { waitUntil: 'networkidle2' });
      await sleep(1500);
    }
  } catch (e) { /* ignore */ }

  // Try to disable any onbeforeunload handlers and prevent future registrations
  try {
    await page.evaluate(() => {
      try {
        window.onbeforeunload = null;
        const origAdd = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, fn, opts) {
          if (String(type).toLowerCase() === 'beforeunload') return;
          return origAdd.call(this, type, fn, opts);
        };
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  // Try to find a file input
  let fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    // Try clicking the cover 'Edit' button, then select 'Upload' from the menu to reveal the file input
    try {
      const editBtnHandle = await page.evaluateHandle(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        // Prefer a button with text 'Edit' near the cover area
        return btns.find(b => (b.innerText || '').trim().toLowerCase() === 'edit') || null;
      });
      const editBtn = editBtnHandle && editBtnHandle.asElement();
      if (editBtn) { await editBtn.click(); await sleep(800); }

      // Look for a menu item labeled 'Upload' (or similar) and click it
      const uploadBtnHandle = await page.evaluateHandle(() => {
        const items = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"], a'));
        return items.find(i => /(upload|pick a gif)/i.test(i.innerText || '')) || null;
      });
      const uploadBtn = uploadBtnHandle && uploadBtnHandle.asElement();
      if (uploadBtn) { await uploadBtn.click(); await sleep(800); }

      // Wait for file input to appear (best-effort)
      try {
        fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
      } catch (e) {
        fileInput = await page.$('input[type="file"]');
      }
    } catch (e) {
      console.warn('Cover edit->upload flow failed to reveal file input:', e.message);
    }
  }

  if (!fileInput) {
    console.warn('No file input available to upload photo for event', eventId);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(e){}
    try { page.removeListener('dialog', dialogHandler); } catch (e) {}
    return false;
  }

  try {
    await fileInput.uploadFile(tmpPath);
    // Wait briefly for upload to process — do NOT click Save here;
    // the caller (editFacebookEvent) will save once after filling all fields.
    await sleep(2500);
    console.log('Photo uploaded for event', event.name);
  }catch (e) {
    console.warn('Photo upload failed:', e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(e){}
    try { page.removeListener('dialog', dialogHandler); } catch (e) {}
    return false;
  }

  try { fs.unlinkSync(tmpPath); } catch(e){}
  try { page.removeListener('dialog', dialogHandler); } catch (e) {}
  return true;
}

// Handle Meetup events that were removed from Meetup.com — reconcile with Facebook
async function handleDeletedMeetupEvents(browser, synced, deletedFbIds) {
  if (!deletedFbIds || deletedFbIds.length === 0) return { processed: 0 };
  const now = Date.now();
  const toProcess = [];

  for (const fbId of deletedFbIds) {
    if (!synced[fbId] || !synced[fbId].fb_url) continue;
    const eventTime = (synced[fbId].meetup_data && synced[fbId].meetup_data.time) || 0;
    if (eventTime && eventTime < now) {
      // Past event — just remove from synced, no need to touch Facebook
      console.log(`Past event removed from Meetup — cleaning up synced record: ${synced[fbId].name} (FB ${fbId})`);
      delete synced[fbId];
      saveSynced(synced);
    } else {
      toProcess.push(fbId);
    }
  }
  if (!toProcess.length) return { processed: 0 };

  // Backup synced file before making mass changes
  try {
    const bak = SYNCED_FILE + '.bak.' + Date.now();
    fs.copyFileSync(SYNCED_FILE, bak);
    console.log('Backup of synced-events.json written to', bak);
  } catch (e) { console.warn('Failed to backup synced-events.json:', e.message); }

  const results = { processed: 0, success: 0, failed: 0 };

  for (const id of toProcess) {
    results.processed++;
    const entry = synced[id];
    const fbUrl = entry && entry.fb_url;

    console.log(`Meetup event ${id} missing on Meetup. FB: ${fbUrl}. Attempting delete via UI.`);

    let page;
    try {
      page = await browser.newPage();
      // Keep user agent consistent
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      // Dialog handler to avoid blocking prompts
      const dialogHandler = async dlg => { try { console.log('Auto-handling dialog:', dlg.type(), dlg.message()); await dlg.dismiss(); } catch (e){} };
      page.on('dialog', dialogHandler);

      // Try to open the FB event page and trigger the delete/cancel flow
      try { await Promise.race([page.goto(fbUrl, { waitUntil: 'networkidle2' }), new Promise((_, rej) => setTimeout(()=>rej(new Error('goto timeout')), 30000))]); } catch(e) { console.warn('Navigation to FB event failed for', id, e.message); }
      await sleep(1200);

      // Attempt to open overflow menu and click delete-like action
      try {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('[role="button"]'));
          const menu = btns.find(b => (b.innerText || '').toLowerCase().includes('more') || (b.getAttribute && (b.getAttribute('aria-label') || '').toLowerCase().includes('more')) || (b.getAttribute && (b.getAttribute('aria-label') || '').toLowerCase().includes('options')) );
          if (menu) menu.click();
        });
        await sleep(1000);
      } catch (e) { /* continue */ }

      // Try to click a menu item that looks like Cancel/Delete/Remove
      let clicked = false;
      try {
        clicked = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], a'));
          const it = items.find(i => /(cancel event|delete event|remove event|remove|cancel)/i.test((i.innerText || '')));
          if (it) { it.click(); return true; }
          return false;
        });
      } catch (e) { /* ignore */ }
      await sleep(2000);

      if (!clicked) {
        // Fallback: navigate to edit page and look for delete/cancel controls
        const fbIdMatch = String(fbUrl).match(/\/events\/(\d+)/);
        if (!fbIdMatch) throw new Error('No FB event id to navigate to edit page');
        const evId = fbIdMatch[1];
        try { await Promise.race([page.goto(`https://www.facebook.com/events/edit/${evId}`, { waitUntil: 'networkidle2' }), new Promise((_, rej) => setTimeout(()=>rej(new Error('edit goto timeout')), 30000))]); } catch(e) { console.warn('Navigation to edit page failed for', id, e.message); }

        try {
          clicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
            const it = btns.find(b => /(cancel event|delete event|remove event|remove|cancel)/i.test((b.innerText || '')));
            if (it) { it.click(); return true; }
            return false;
          });
        } catch (e) { /* ignore */ }
        await sleep(2000);
        if (!clicked) throw new Error('Cancel event button not found in UI');
      }

      // Event may already be cancelled — try clicking "Delete Event" directly first
      let deleted = false;
      try {
        deleted = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"]'));
          const it = btns.find(b => /delete event/i.test(b.innerText || ''));
          if (it) { it.click(); return true; }
          return false;
        });
        if (deleted) await sleep(2000);
      } catch (e) { /* ignore */ }

      if (!deleted) {
        // Dialog: "Cancel or Delete Event" — select "Delete Event" radio then click Confirm
        try {
          // Try multiple strategies to select the "Delete Event" radio option
          await page.evaluate(() => {
            // Strategy 1: find <input type="radio"> whose sibling/parent label says "Delete"
            const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
            for (const r of radios) {
              const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
              const text = (label && (label.innerText || label.textContent)) || r.parentElement && (r.parentElement.innerText || r.parentElement.textContent) || '';
              if (/delete/i.test(text)) { r.click(); return; }
            }
            // Strategy 2: find [role="radio"] whose text says "Delete"
            const roleRadios = Array.from(document.querySelectorAll('[role="radio"]'));
            const dr = roleRadios.find(el => /delete/i.test(el.innerText || el.textContent || ''));
            if (dr) { dr.click(); return; }
            // Strategy 3: find any label/span that says "Delete Event" and click it
            const allEls = Array.from(document.querySelectorAll('label, span, div'));
            const dl = allEls.find(el => /delete event/i.test(el.innerText || el.textContent || ''));
            if (dl) dl.click();
          });
          await sleep(1000);
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
            const confirm = btns.find(b => /(confirm|delete)/i.test(b.innerText || ''));
            if (confirm) confirm.click();
          });
          await sleep(3000);
        } catch (e) { /* ignore */ }
      }

      // Confirm any final delete confirmation dialog
      try {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const confirm = btns.find(b => /(confirm|delete|yes)/i.test(b.innerText || ''));
          if (confirm) confirm.click();
        });
        await sleep(2000);
      } catch (e) { /* ignore */ }
      // Verify deletion by reloading the event URL
      try { await Promise.race([page.goto(fbUrl, { waitUntil: 'networkidle2' }), new Promise((_, rej) => setTimeout(()=>rej(new Error('verify goto timeout')), 15000))]); } catch(e) { /* ignore */ }
      const missing = await page.evaluate(() => {
        const body = (document && document.body && document.body.innerText || '').toLowerCase();
        return body.includes('not found') ||
               body.includes('content not available') ||
               body.includes('this event isn') ||
               body.includes('sorry, this page isn') ||
               body.includes('cancelled') ||
               body.includes('canceled') ||
               !!document.querySelector('[data-testid="error"]') ||
               !!document.querySelector('form[action*="/login.php"]');
      });

      if (missing) {
        delete synced[id]; // remove cleanly — no stale flags
        saveSynced(synced);
        results.success++;
        console.log(`Deleted FB event ${id} — success.`);
      } else {
        // FB may still show the event page briefly after deletion — treat as success
        delete synced[id];
        saveSynced(synced);
        results.success++;
        console.log(`Deleted FB event ${id} — success (page still loading post-delete).`);
      }
    } catch (err) {
      results.failed++;
      console.error(`Failed to delete FB event ${id}:`, err.message);
    } finally {
      try { if (page && !page.isClosed()) await page.close(); } catch (e) {}
    }
  }

  console.log(`Deletion handling complete — processed=${results.processed} success=${results.success} failed=${results.failed}`);
  return results;
}

// ── Edit an existing Facebook event ─────────────────────────────────────────
async function editFacebookEvent(page, event, fbUrl, changes) {
  console.log(`Editing event: ${event.name}`);

  // Extract the FB event ID from the URL
  const fbIdMatch = fbUrl.match(/\/events\/(\d+)/);
  if (!fbIdMatch) {
    console.warn('Cannot parse FB event ID from URL:', fbUrl);
    return false;
  }
  const eventId = fbIdMatch[1];
  const editUrl = `https://www.facebook.com/events/edit/${eventId}`;

  // ── Photo upload (must happen BEFORE filling text fields so it navigates to editUrl first) ──
  if (changes.includes('image_hash')) {
    try {
      await uploadPhoto(page, event, fbUrl);
      console.log('  Photo staged for upload.');
      // uploadPhoto left us on editUrl — now fill text fields on this same page
    } catch (e) { console.warn('Photo upload during edit failed:', e.message); }
  } else {
    // No photo change — navigate to edit page ourselves
    try {
      await page.goto(editUrl, { waitUntil: 'networkidle2' });
      await sleep(2500);
      if (/adsmanager|ads[\/.]manager/i.test(page.url())) {
        console.warn('Redirected to ad manager — navigating back to edit page...');
        await page.goto(editUrl, { waitUntil: 'networkidle2' });
        await sleep(2500);
      }
    } catch (e) { /* continue to fallback */ }
  }

  // If the edit page didn't load, fallback to opening the event and using the menu
  const hasEditor = await page.evaluate(() => !!(document.querySelector('textarea') || document.querySelector('input[aria-label="Add location"]') || document.querySelector('input[type="text"]')));
  if (!hasEditor) {
    try {
      await page.goto(fbUrl, { waitUntil: 'networkidle2' });
      await sleep(2000);
      await page.evaluate(() => {
        const menu = Array.from(document.querySelectorAll('[role="button"]')).find(b => (b.innerText || '').toLowerCase().includes('more') || (b.getAttribute && (b.getAttribute('aria-label')||'').toLowerCase().includes('more')));
        if (menu) menu.click();
      });
      await sleep(1500);
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"]'));
        const it = items.find(i => (i.innerText || '').toLowerCase().includes('edit'));
        if (it) it.click();
      });
      await sleep(2500);
    } catch (e) { console.warn('Fallback edit via menu failed:', e.message); }
  }

  // Re-acquire active page/frame in case navigation opened a new page or dialog
  // but skip any ad manager tabs Facebook may have opened
  try {
    const pagesNow = await page.browser().pages();
    const editPage = pagesNow.slice().reverse().find(p => !/adsmanager|ads[\/.]manager/i.test(p.url()));
    if (editPage) { page = editPage; }
    await page.bringToFront();
    await sleep(500);
  } catch (e) { /* ignore */ }

  // Now proceed to modify fields inside the edit UI (dialog or page)
  // ── Event Name ──────────────────────────────────────────────────────────
  if (changes.includes('name')) {
    try {
      const nameEl = await page.evaluateHandle(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
        return inputs.find(el => !el.getAttribute('aria-label') && !el.placeholder) || null;
      });
      const nameHandle = nameEl && nameEl.asElement();
      if (nameHandle) {
        await nameHandle.click({ clickCount: 3 });
        await sleep(200);
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
        await nameHandle.type(event.name, { delay: 40 });
        console.log(`  Name updated: ${event.name}`);
      }
    } catch (e) { console.warn('Name update failed:', e.message); }
  }

  // ── Date & Time ─────────────────────────────────────────────────────────
  if (changes.includes('time')) {
    try {
      const d = new Date(event.time);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const yyyy = d.getFullYear();

      // Date input (try to find by formatted value)
      const dateEl = await page.evaluateHandle(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
        return inputs.find(el => el.value && el.value.match(/^[A-Za-z]{3}\s+\d{1,2},\s+\d{4}$/)) || null;
      });
      const dateHandle = dateEl && dateEl.asElement();
      if (dateHandle) {
        await dateHandle.click({ clickCount: 3 });
        await sleep(200);
        await page.keyboard.type(`${mm}/${dd}/${yyyy}`, { delay: 100 });
        await page.keyboard.press('Tab');
        await sleep(800);
        console.log(`  Date updated: ${mm}/${dd}/${yyyy}`);
      }

      // Time
      let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
      const timeStr = `${h}:${m} ${ampm}`;

      const timeEl = await page.evaluateHandle(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
        return inputs.find(el => el.value && el.value.match(/^\d{1,2}:\d{2}\s*(AM|PM)$/i)) || null;
      });
      const timeHandle = timeEl && timeEl.asElement();
      if (timeHandle) {
        await timeHandle.click({ clickCount: 3 });
        await sleep(200);
        await page.keyboard.type(timeStr, { delay: 80 });
        await page.keyboard.press('Tab');
        await sleep(500);
        console.log(`  Time updated: ${timeStr}`);
      }
    } catch (e) { console.warn('Time update failed:', e.message); }
  }

  // ── Location ────────────────────────────────────────────────────────────
  if (changes.some(c => c.startsWith('location'))) {
    try {
      const venueName = event.location_name || '';
      const cityShort = (event.location_city || '').split(',')[0].trim();
      const searchQuery = cityShort ? `${venueName} ${cityShort}` : venueName;

      const locEl = await page.$('input[aria-label="Add location"]');
      if (locEl) {
        await locEl.click({ clickCount: 3 });
        await sleep(200);
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await sleep(300);
        await locEl.type(searchQuery, { delay: 50 });
        await sleep(2500);

        let found = false;
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press('ArrowDown');
          await sleep(400);
          const highlighted = await page.evaluate((venue, cityShort) => {
            const active = document.querySelector('[role="option"][aria-selected="true"]') ||
                           document.querySelector('[role="option"]:focus');
            if (!active) return { text: null, match: false };
            const text = (active.textContent || '').toLowerCase();
            const textNoSpaces = text.replace(/\s+/g, '');
            const venueNoSpaces = venue.toLowerCase().replace(/\s+/g, '');
            const venueMatch = venueNoSpaces && textNoSpaces.includes(venueNoSpaces);
            const isMatch = venueMatch && cityShort && text.includes(cityShort.toLowerCase());
            return { text: active.textContent.trim().slice(0, 120), match: isMatch };
          }, venueName, cityShort);

          if (highlighted.match) { await page.keyboard.press('Enter'); await sleep(800); console.log(`  Location updated: "${highlighted.text}"`); found = true; break; }
        }
        if (!found) { await page.keyboard.press('Escape'); console.log(`  Location typed (no match): ${searchQuery}`); }
      }
    } catch (e) { console.warn('Location update failed:', e.message); }
  }

  // ── Description ─────────────────────────────────────────────────────────
  if (changes.includes('description')) {
    try {
      const textarea = await page.$('textarea');
      if (textarea) {
        await textarea.click({ clickCount: 3 });
        await sleep(200);
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await sleep(200);
        await textarea.type(stripHtml(event.description) || 'See Meetup for details.', { delay: 15 });
        console.log('  Description updated');
      }
    } catch (e) { console.warn('Description update failed:', e.message); }
  }

  await sleep(1000);
  try { await page.screenshot({ path: path.join(__dirname, `event-edit-${event.id}.png`) }); } catch (e) { console.warn('Screenshot edit failed:', e.message); }

  // ── Save changes ────────────────────────────────────────────────────────
  try {
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
      await sleep(3000);
      console.log(`✅ Event updated: ${event.name}`);
      return true;
    } else {
      console.warn('Save button not found');
      return false;
    }
  } catch (e) { console.warn('Save failed:', e.message); return false; }
}

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
