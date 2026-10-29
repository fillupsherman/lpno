/** Shared page components — header and footer */

const NAV_LINKS = [
  { href: '/index',         label: 'Events' },
  { href: '/subscribe',     label: 'Mailing List', dropdown: '<a href="/subscribe">Subscribe</a>' },
  { href: '/volunteer.html', label: 'Volunteer', dropdown: '<a href="/volunteer.html">Opportunities</a>' },
  { href: '/donate.html',   label: 'Donate', dropdown: '<a href="/donate.html">Supplies</a>' },
  { href: '/chapters.html', label: 'Chapters', dropdown: '<a href="/chapters.html">Find a Chapter</a>' },
  { href: '/about.html',    label: 'About', dropdown: '<a href="/about.html">Mission</a><a href="/subscribe">Newsletter</a>' },
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

  // Build dropdown content for each nav link
  const buildDropdownContent = (href, label) => {
    const active = isActivePath(href, path) ? ' aria-current="page"' : '';
    
    // Check if this link should have a dropdown menu
    let hasDropdown = false;
    for (const item of NAV_LINKS) {
      if (item.href === href && item.dropdown) {
        hasDropdown = true;
        break;
      }
    };
    
    const dropdownHTML = hasDropdown ? `
          <div class="dropdown">
            ${item.dropdown}
          </div>` : '';

    return `<a href="${href}"${active} class="nav-link">${label}</a>${dropdownHTML}`;
  };

  const navLinks = NAV_LINKS.map(({ href, label, dropdown }) => {
    return buildDropdownContent(href, label);
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

  // Add click handlers for mobile dropdown toggling
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      const dropdown = link.nextElementSibling?.closest('.dropdown');
      if (dropdown) {
        const isOpen = dropdown.classList.contains('open');
        // Close all other dropdowns first
        document.querySelectorAll('.dropdown.open:not(.active)').forEach(d => d.classList.remove('open'));
        if (!isOpen) {
          dropdown.classList.add('open', 'active');
        }
      }
    });
  });
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
