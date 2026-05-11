import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isActivePath, initHeader, initFooter } from './components.js';

describe('isActivePath', () => {
  it('matches exact path', () => {
    expect(isActivePath('/index', '/index')).toBe(true);
  });

  it('matches .html href against path without extension', () => {
    expect(isActivePath('/volunteer.html', '/volunteer')).toBe(true);
  });

  it('matches path with .html against href with .html', () => {
    expect(isActivePath('/volunteer.html', '/volunteer.html')).toBe(true);
  });

  it('does not match a different page', () => {
    expect(isActivePath('/subscribe', '/index')).toBe(false);
  });

  it('does not match partial path', () => {
    expect(isActivePath('/vol', '/volunteer')).toBe(false);
  });
});

describe('initHeader', () => {
  let headerEl;

  beforeEach(() => {
    headerEl = document.createElement('header');
    headerEl.id = 'site-header';
    document.body.appendChild(headerEl);
  });

  afterEach(() => {
    document.body.removeChild(headerEl);
  });

  it('injects header content', () => {
    initHeader();
    expect(headerEl.querySelector('.site-header, .header-grid')).not.toBeNull();
  });

  it('injects all nav links', () => {
    initHeader();
    const links = headerEl.querySelectorAll('nav a');
    expect(links.length).toBe(6);
  });

  it('includes Events link', () => {
    initHeader();
    const hrefs = [...headerEl.querySelectorAll('nav a')].map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/index');
  });

  it('does nothing if no #site-header element', () => {
    document.body.removeChild(headerEl);
    expect(() => initHeader()).not.toThrow();
    document.body.appendChild(headerEl); // re-add for afterEach
  });
});

describe('initFooter', () => {
  let footerEl;

  beforeEach(() => {
    footerEl = document.createElement('footer');
    footerEl.id = 'site-footer';
    document.body.appendChild(footerEl);
  });

  afterEach(() => {
    document.body.removeChild(footerEl);
  });

  it('injects copyright text', () => {
    initFooter();
    expect(footerEl.textContent).toContain('Leftist-Progressive Night Out');
  });

  it('injects a <small> element', () => {
    initFooter();
    expect(footerEl.querySelector('small')).not.toBeNull();
  });

  it('does nothing if no #site-footer element', () => {
    document.body.removeChild(footerEl);
    expect(() => initFooter()).not.toThrow();
    document.body.appendChild(footerEl); // re-add for afterEach
  });
});
