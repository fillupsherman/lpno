'use strict';

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '..', 'fb-session.json');

async function saveBrowserSession(page, sessionFile = SESSION_FILE) {
  const cookies = await page.cookies();
  fs.writeFileSync(sessionFile, JSON.stringify(cookies, null, 2));
  console.log('Session saved.');
}

async function loadBrowserSession(page, sessionFile = SESSION_FILE) {
  if (!fs.existsSync(sessionFile)) return false;
  const cookies = JSON.parse(fs.readFileSync(sessionFile));
  await page.setCookie(...cookies);
  return true;
}

async function isLoggedIn(page) {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2000));
  return !page.url().includes('login');
}

async function login(page, sessionFile = SESSION_FILE) {
  console.log('Opening Facebook login — please log in manually in the browser window...');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2' });
  await page.waitForFunction(
    () => !window.location.href.includes('login'),
    { timeout: 300000 }
  );
  console.log('Login detected. Saving session...');
  await saveBrowserSession(page, sessionFile);
}

module.exports = { saveBrowserSession, loadBrowserSession, isLoggedIn, login, SESSION_FILE };
