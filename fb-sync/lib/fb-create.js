'use strict';

const path = require('path');
const { sleep } = require('./meetup');
const { stripHtml } = require('./meetup');

const FB_PAGE_URL = 'https://www.facebook.com/leftistprogressivenightout';

// After a create returns 'unknown', search the page's events list for a match by name.
// Returns a numeric FB event ID string, or null if not found.
async function findCreatedEventOnPage(page, event) {
  try {
    const eventName = (event.name || '').trim().toLowerCase();
    const namePrefix = eventName.slice(0, 20);

    console.log(`  Navigating to page events list to recover ID for "${event.name}"...`);
    await page.goto(`${FB_PAGE_URL}/events`, { waitUntil: 'networkidle2' });
    await sleep(3000);

    await page.evaluate(() => window.scrollBy(0, 600));
    await sleep(1000);

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

  await page.goto('https://www.facebook.com/events/create/', { waitUntil: 'networkidle2' });
  await sleep(4000);

  if (!page.url().includes('/events/create')) {
    console.warn('Unexpected redirect to:', page.url());
    await page.screenshot({ path: path.join(__dirname, '..', `event-error-redirect-${event.id}.png`) });
    return false;
  }

  const fieldDump = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="text"],input[type="search"],textarea'))
      .map((el, i) => ({ i, id: el.id, aria: el.getAttribute('aria-label'), value: el.value, placeholder: el.placeholder }))
  );
  console.log('Form fields:', JSON.stringify(fieldDump));

  // ── Event Name ────────────────────────────────────────────────────────────
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
    await page.screenshot({ path: path.join(__dirname, '..', `event-error-noform-${event.id}.png`) });
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
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
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

  // ── Location ──────────────────────────────────────────────────────────────
  try {
    await sleep(500);
    const venueName = event.location_name || '';
    const cityHint = (event.location_city || '').toLowerCase();
    const addrHint = (event.location_address || '').toLowerCase();
    const cityShort = (event.location_city || '').split(',')[0].trim();

    const locEl = await page.$('input[aria-label="Add location"]');
    if (locEl) {
      await locEl.click({ clickCount: 3 });
      await sleep(200);
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await sleep(300);
      const searchQuery = cityShort ? `${venueName} ${cityShort}` : venueName;
      await locEl.type(searchQuery, { delay: 50 });
      await sleep(2500);

      let found = false;
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('ArrowDown');
        await sleep(400);
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
  try {
    await page.screenshot({ path: path.join(__dirname, '..', `event-preview-${event.id}.png`) });
    console.log(`Screenshot saved: event-preview-${event.id}.png`);
  } catch (e) { console.warn('Screenshot preview failed:', e.message); }

  // ── Submit ────────────────────────────────────────────────────────────────
  try {
    const createBtn = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[role="button"]'))
        .find(el => el.textContent.trim() === 'Create event') || null
    );
    const createEl = createBtn.asElement();
    if (createEl) {
      await createEl.click();
      try {
        await page.waitForFunction(
          () => !location.href.endsWith('/events/create/'),
          { timeout: 25000 }
        );
      } catch (_) { /* Timeout — still on create page */ }
      await sleep(2000);
      const finalUrl = page.url();
      if (finalUrl.includes('/events/') && !finalUrl.endsWith('/events/create/')) {
        console.log(`✅ Event created: ${finalUrl}`);
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
        const hasError = await page.evaluate(() =>
          !!document.querySelector('[data-testid*="error"], [aria-live="assertive"]')
        );
        if (!hasError) {
          console.log('✅ Event likely created (no error detected, URL unchanged)');
          return 'unknown';
        }
        console.warn(`⚠️  Still on create page after submit: ${finalUrl}`);
        try { await page.screenshot({ path: path.join(__dirname, '..', `event-result-${event.id}.png`) }); } catch(e) { console.warn('Screenshot result failed:', e.message); }
        return false;
      }
    } else {
      console.warn('Create event button not found');
      return false;
    }
  } catch (e) { console.warn('Submit failed:', e.message); return false; }
}

module.exports = { createFacebookEvent, findCreatedEventOnPage, FB_PAGE_URL };
