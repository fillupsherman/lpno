/** Shared utilities for LPNO pages */

export const API = 'https://lpno.lpno-dev.workers.dev';

/**
 * Show a brief toast notification.
 * Expects a #toast element on the page.
 * @param {string} text
 * @param {boolean} ok  true = success style, false = error style
 */
export function showToast(text, ok = true) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !ok);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

/**
 * Basic email format validation.
 * @param {string} email
 * @returns {boolean}
 */
export function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
