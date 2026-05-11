/** Shared page components — header and footer */

const NAV_LINKS = [
  { href: '/index',         label: 'Events' },
  { href: '/subscribe',     label: 'Mailing List' },
  { href: '/volunteer.html', label: 'Volunteer' },
  { href: '/donate.html',   label: 'Donate' },
  { href: '/chapters.html', label: 'Chapters' },
  { href: '/about.html',    label: 'About' },
];

/**
 * Returns true if the given href matches the current page path.
 * Exported for testing.
 */
export function isActivePath(href, pathname) {
  // strip .html for comparison so /volunteer.html matches /volunteer
  const norm = href.replace(/\.html$/, '');
  const normPath = pathname.replace(/\.html$/, '');
  return normPath === norm || normPath === norm + '/index';
}

/**
 * Inject the site header into <header id="site-header">.
 * Automatically marks the current page's nav link with aria-current="page".
 */
export function initHeader() {
  const el = document.getElementById('site-header');
  if (!el) return;

  const path = typeof window !== 'undefined' ? window.location.pathname : '/';

  const navLinks = NAV_LINKS.map(({ href, label }) => {
    const active = isActivePath(href, path) ? ' aria-current="page"' : '';
    return `<a href="${href}"${active}><span class="label">${label}</span></a>`;
  }).join('\n          ');

  el.className = 'site-header';
  el.innerHTML = `
    <div class="wrap header-grid">
      <span class="brand label">
        <a href="/index" aria-label="Home">
          <img src="/assets/images/lpno.png" alt="LPNO logo" class="logo" />
        </a>
      </span>
      <h1 class="title">Leftist-Progressive Night Out!</h1>
      <nav class="nav-desktop">
          ${navLinks}
      </nav>
    </div>`;
}

/**
 * Inject the site footer into <footer id="site-footer">.
 */
export function initFooter() {
  const el = document.getElementById('site-footer');
  if (!el) return;
  el.innerHTML = `<small>© 2025 Leftist-Progressive Night Out!</small>`;
}
