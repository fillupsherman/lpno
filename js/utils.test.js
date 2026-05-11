import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { API, validateEmail, showToast } from './utils.js';

describe('API constant', () => {
  it('points at the Cloudflare worker', () => {
    expect(API).toBe('https://lpno.lpno-dev.workers.dev');
  });
});

describe('validateEmail', () => {
  it('accepts a valid email', () => {
    expect(validateEmail('user@example.com')).toBe(true);
  });

  it('accepts email with subdomain', () => {
    expect(validateEmail('user@mail.example.co.uk')).toBe(true);
  });

  it('rejects missing @', () => {
    expect(validateEmail('userexample.com')).toBe(false);
  });

  it('rejects missing domain', () => {
    expect(validateEmail('user@')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateEmail('')).toBe(false);
  });

  it('rejects string with spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false);
  });
});

describe('showToast', () => {
  let toastEl;

  beforeEach(() => {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    document.body.appendChild(toastEl);
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.removeChild(toastEl);
    vi.useRealTimers();
  });

  it('sets toast text content', () => {
    showToast('Hello!');
    expect(toastEl.textContent).toBe('Hello!');
  });

  it('adds show class', () => {
    showToast('Hello!');
    expect(toastEl.classList.contains('show')).toBe(true);
  });

  it('does not add error class for success toast', () => {
    showToast('OK', true);
    expect(toastEl.classList.contains('error')).toBe(false);
  });

  it('adds error class for error toast', () => {
    showToast('Bad!', false);
    expect(toastEl.classList.contains('error')).toBe(true);
  });

  it('removes show class after 2200ms', () => {
    showToast('Hello!');
    vi.advanceTimersByTime(2200);
    expect(toastEl.classList.contains('show')).toBe(false);
  });

  it('does nothing if no #toast element exists', () => {
    document.body.removeChild(toastEl);
    expect(() => showToast('no-op')).not.toThrow();
    document.body.appendChild(toastEl); // re-add for afterEach cleanup
  });
});
