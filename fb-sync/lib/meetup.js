'use strict';

const WORKER_URL = 'https://lpno.lpno-dev.workers.dev/events';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// Returns "YYYY-MM-DDTHH:MM" in local time for a datetime-local input
function formatDateTimeLocal(unixMs) {
  const d = new Date(unixMs);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function fetchMeetupEvents(url = WORKER_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Worker error: ${res.status}`);
  return res.json();
}

module.exports = { sleep, stripHtml, formatDateTimeLocal, fetchMeetupEvents, WORKER_URL };
