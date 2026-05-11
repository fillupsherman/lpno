'use strict';

const fs = require('fs');
const path = require('path');
const { sleep, stripHtml } = require('./meetup');

const TMP_DIR = path.join(__dirname, '..', 'tmp');

// Upload a meetup image to a Facebook event via the edit UI (Puppeteer).
// Returns true on success, false on failure.
async function uploadPhoto(page, event, fbUrl) {
  const fbIdMatch = String(fbUrl).match(/\/events\/(\d+)/);
  if (!fbIdMatch) return false;
  const eventId = fbIdMatch[1];
  const imgUrl = event.photo || event.image || event.featured_photo ||
    (event.photos && event.photos[0] && event.photos[0].highres_link) ||
    event.image_url || '';
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

  const dialogHandler = async dlg => {
    try { console.log('Auto-handling dialog:', dlg.type(), dlg.message()); await dlg.dismiss(); } catch (e) {}
  };
  page.on('dialog', dialogHandler);

  try {
    await page.goto(editUrl, { waitUntil: 'networkidle2' });
    await sleep(1500);
    if (/adsmanager|ads[/.]manager/i.test(page.url())) {
      console.warn('Redirected to ad manager during photo upload — navigating back...');
      await page.goto(editUrl, { waitUntil: 'networkidle2' });
      await sleep(1500);
    }
  } catch (e) { /* ignore */ }

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

  let fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    try {
      const editBtnHandle = await page.evaluateHandle(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        return btns.find(b => (b.innerText || '').trim().toLowerCase() === 'edit') || null;
      });
      const editBtn = editBtnHandle && editBtnHandle.asElement();
      if (editBtn) { await editBtn.click(); await sleep(800); }

      const uploadBtnHandle = await page.evaluateHandle(() => {
        const items = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"], a'));
        return items.find(i => /(upload|pick a gif)/i.test(i.innerText || '')) || null;
      });
      const uploadBtn = uploadBtnHandle && uploadBtnHandle.asElement();
      if (uploadBtn) { await uploadBtn.click(); await sleep(800); }

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
    await sleep(2500);
    console.log('Photo uploaded for event', event.name);
  } catch (e) {
    console.warn('Photo upload failed:', e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(e){}
    try { page.removeListener('dialog', dialogHandler); } catch (e) {}
    return false;
  }

  try { fs.unlinkSync(tmpPath); } catch(e){}
  try { page.removeListener('dialog', dialogHandler); } catch (e) {}
  return true;
}

async function editFacebookEvent(page, event, fbUrl, changes) {
  console.log(`Editing event: ${event.name}`);

  const fbIdMatch = fbUrl.match(/\/events\/(\d+)/);
  if (!fbIdMatch) {
    console.warn('Cannot parse FB event ID from URL:', fbUrl);
    return false;
  }
  const eventId = fbIdMatch[1];
  const editUrl = `https://www.facebook.com/events/edit/${eventId}`;

  // ── Photo upload (navigates to editUrl first; text fields filled on same page) ──
  if (changes.includes('image_hash')) {
    try {
      await uploadPhoto(page, event, fbUrl);
      console.log('  Photo staged for upload.');
    } catch (e) { console.warn('Photo upload during edit failed:', e.message); }
  } else {
    try {
      await page.goto(editUrl, { waitUntil: 'networkidle2' });
      await sleep(2500);
      if (/adsmanager|ads[/.]manager/i.test(page.url())) {
        console.warn('Redirected to ad manager — navigating back to edit page...');
        await page.goto(editUrl, { waitUntil: 'networkidle2' });
        await sleep(2500);
      }
    } catch (e) { /* continue to fallback */ }
  }

  // Fallback: open event → menu → Edit if edit form not found
  const hasEditor = await page.evaluate(() =>
    !!(document.querySelector('textarea') ||
       document.querySelector('input[aria-label="Add location"]') ||
       document.querySelector('input[type="text"]'))
  );
  if (!hasEditor) {
    try {
      await page.goto(fbUrl, { waitUntil: 'networkidle2' });
      await sleep(2000);
      await page.evaluate(() => {
        const menu = Array.from(document.querySelectorAll('[role="button"]'))
          .find(b => (b.innerText || '').toLowerCase().includes('more') ||
            (b.getAttribute && (b.getAttribute('aria-label') || '').toLowerCase().includes('more')));
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

  // Re-acquire page (skip any ad-manager tabs FB may have opened)
  try {
    const pagesNow = await page.browser().pages();
    const editPage = pagesNow.slice().reverse().find(p => !/adsmanager|ads[/.]manager/i.test(p.url()));
    if (editPage) { page = editPage; }
    await page.bringToFront();
    await sleep(500);
  } catch (e) { /* ignore */ }

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

  // ── Date & Time ──────────────────────────────────────────────────────────
  if (changes.includes('time')) {
    try {
      const d = new Date(event.time);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const yyyy = d.getFullYear();

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

      let h = d.getHours();
      const m = String(d.getMinutes()).padStart(2, '0');
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
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
          const highlighted = await page.evaluate((venue, city) => {
            const active = document.querySelector('[role="option"][aria-selected="true"]') ||
                           document.querySelector('[role="option"]:focus');
            if (!active) return { text: null, match: false };
            const text = (active.textContent || '').toLowerCase();
            const textNoSpaces = text.replace(/\s+/g, '');
            const venueNoSpaces = venue.toLowerCase().replace(/\s+/g, '');
            const venueMatch = venueNoSpaces && textNoSpaces.includes(venueNoSpaces);
            const isMatch = venueMatch && city && text.includes(city.toLowerCase());
            return { text: active.textContent.trim().slice(0, 120), match: isMatch };
          }, venueName, cityShort);

          if (highlighted.match) {
            await page.keyboard.press('Enter');
            await sleep(800);
            console.log(`  Location updated: "${highlighted.text}"`);
            found = true;
            break;
          }
        }
        if (!found) { await page.keyboard.press('Escape'); console.log(`  Location typed (no match): ${searchQuery}`); }
      }
    } catch (e) { console.warn('Location update failed:', e.message); }
  }

  // ── Description ──────────────────────────────────────────────────────────
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
  try { await page.screenshot({ path: path.join(__dirname, '..', `event-edit-${event.id}.png`) }); } catch (e) { console.warn('Screenshot edit failed:', e.message); }

  // ── Save changes ──────────────────────────────────────────────────────────
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

module.exports = { uploadPhoto, editFacebookEvent, TMP_DIR };
