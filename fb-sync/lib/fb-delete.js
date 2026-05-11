'use strict';

const fs = require('fs');
const { sleep } = require('./meetup');
const { saveSynced, SYNCED_FILE } = require('./synced-store');

async function handleDeletedMeetupEvents(browser, synced, deletedFbIds) {
  if (!deletedFbIds || deletedFbIds.length === 0) return { processed: 0 };
  const now = Date.now();
  const toProcess = [];

  for (const fbId of deletedFbIds) {
    if (!synced[fbId] || !synced[fbId].fb_url) continue;
    const eventTime = (synced[fbId].meetup_data && synced[fbId].meetup_data.time) || 0;
    if (eventTime && eventTime < now) {
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
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      const dialogHandler = async dlg => {
        try { console.log('Auto-handling dialog:', dlg.type(), dlg.message()); await dlg.dismiss(); } catch (e) {}
      };
      page.on('dialog', dialogHandler);

      try {
        await Promise.race([
          page.goto(fbUrl, { waitUntil: 'networkidle2' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('goto timeout')), 30000)),
        ]);
      } catch (e) { console.warn('Navigation to FB event failed for', id, e.message); }
      await sleep(1200);

      // Open overflow menu
      try {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('[role="button"]'));
          const menu = btns.find(b =>
            (b.innerText || '').toLowerCase().includes('more') ||
            (b.getAttribute && (b.getAttribute('aria-label') || '').toLowerCase().includes('more')) ||
            (b.getAttribute && (b.getAttribute('aria-label') || '').toLowerCase().includes('options'))
          );
          if (menu) menu.click();
        });
        await sleep(1000);
      } catch (e) { /* continue */ }

      // Click Cancel/Delete/Remove from menu
      let clicked = false;
      try {
        clicked = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="button"], a'));
          const it = items.find(i => /(cancel event|delete event|remove event|remove|cancel)/i.test(i.innerText || ''));
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
        try {
          await Promise.race([
            page.goto(`https://www.facebook.com/events/edit/${evId}`, { waitUntil: 'networkidle2' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('edit goto timeout')), 30000)),
          ]);
        } catch (e) { console.warn('Navigation to edit page failed for', id, e.message); }

        try {
          clicked = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
            const it = btns.find(b => /(cancel event|delete event|remove event|remove|cancel)/i.test(b.innerText || ''));
            if (it) { it.click(); return true; }
            return false;
          });
        } catch (e) { /* ignore */ }
        await sleep(2000);
        if (!clicked) throw new Error('Cancel event button not found in UI');
      }

      // Try "Delete Event" directly (event may already be cancelled)
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
        // Select "Delete Event" radio then confirm
        try {
          await page.evaluate(() => {
            const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
            for (const r of radios) {
              const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
              const text = (label && (label.innerText || label.textContent)) ||
                           (r.parentElement && (r.parentElement.innerText || r.parentElement.textContent)) || '';
              if (/delete/i.test(text)) { r.click(); return; }
            }
            const roleRadios = Array.from(document.querySelectorAll('[role="radio"]'));
            const dr = roleRadios.find(el => /delete/i.test(el.innerText || el.textContent || ''));
            if (dr) { dr.click(); return; }
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

      // Final confirmation dialog
      try {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
          const confirm = btns.find(b => /(confirm|delete|yes)/i.test(b.innerText || ''));
          if (confirm) confirm.click();
        });
        await sleep(2000);
      } catch (e) { /* ignore */ }

      // Verify deletion
      try {
        await Promise.race([
          page.goto(fbUrl, { waitUntil: 'networkidle2' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('verify goto timeout')), 15000)),
        ]);
      } catch (e) { /* ignore */ }

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
        delete synced[id];
        saveSynced(synced);
        results.success++;
        console.log(`Deleted FB event ${id} — success.`);
      } else {
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

module.exports = { handleDeletedMeetupEvents };
