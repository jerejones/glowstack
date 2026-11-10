// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The panel's frame, whatever its width: which layout applies (ui.css
// decides, through --layout), the side panel's icon rail, the tabs, and the
// phone's shell. On a phone the four tabs are a fixed bar at the bottom of
// the screen, in the thumb zone; the sheet sits above it with three detents
// (peek, half, full), follows the finger on its handle and header, and at
// the peek shows one line that says the current tab's state. The active tab
// and the rail are remembered per device. The tabs' contents belong to
// panel/*.js.
import { $, load, save, clamp } from './util.js';
import { icon } from './icons.js';

const TAB = 'glowstack.tab';
const RAIL = 'glowstack.rail';
const DETENT = 'glowstack.sheet.detent';
const routeTab = () => /^\/(looks|presets|setup|status)\/?$/.exec(location.pathname)?.[1] || null;
const PEEK = 52;   // the sheet's own part of a peek: the handle (24) and the state line (28); the tab bar is below it
const STRIP = 200; // the map above a full sheet: --strip in ui.css
const HALF = 0.64; // of the window's height at the half detent, tab bar included, the same on every tab so the map holds still: the sheet opens to the task, and the map band above it still shows the whole lit outline
const HALF_MIN = 300; // with the tab bar: room for a look card above the Apply bar on a short phone
export const DETENTS = ['peek', 'half', 'full'];
export const DETENT_WORDS = { peek: 'Lowered: one line', half: 'Half height', full: 'Full height' };

// detentStep is the detent a key on the handle goes to: Up and Down step,
// Home and End go to the ends, and anything else leaves it ('' for no move).
export function detentStep(detent, key) {
  const i = DETENTS.indexOf(detent);
  if (key === 'ArrowUp') return DETENTS[Math.min(2, i + 1)] === detent ? '' : DETENTS[Math.min(2, i + 1)];
  if (key === 'ArrowDown') return DETENTS[Math.max(0, i - 1)] === detent ? '' : DETENTS[Math.max(0, i - 1)];
  if (key === 'Home') return detent === 'peek' ? '' : 'peek';
  if (key === 'End') return detent === 'full' ? '' : 'full';
  return '';
}

// settle picks the detent a released drag lands on: the nearest to where the
// sheet is, or with a flick (vy in px/ms, down positive, faster than 0.5)
// the next one along the flick. h is the detents' heights, visible the
// sheet's height now.
export function settle(h, visible, vy = 0) {
  let best = DETENTS.reduce((a, b) => (Math.abs(h[b] - visible) < Math.abs(h[a] - visible) ? b : a));
  if (Math.abs(vy) > 0.5) {
    const i = DETENTS.indexOf(best), here = DETENTS.findIndex((d) => h[d] >= visible);
    if (vy < 0) best = DETENTS[Math.min(2, Math.max(i, here < 0 ? 2 : here))];
    else best = DETENTS[Math.max(0, Math.min(i, (here < 0 ? 3 : here) - 1))];
  }
  return best;
}

// dragsSheet says a touch that began on the sheet's content moves the sheet
// instead of scrolling: only when the content is at its top and the finger
// is going down, more down than sideways, past a small slop.
export function dragsSheet({ scrollTop, dx, dy, slop = 6 }) {
  return scrollTop <= 0 && dy > slop && dy > Math.abs(dx);
}

// guardSelection stops text selection while dragging() says so.
export function guardSelection(doc, dragging) {
  doc.addEventListener('selectstart', (e) => { if (dragging()) e.preventDefault(); });
}

// createPanel wires the panel. hooks:
//   onLayout(layout)  the layout changed: 'sheet' | 'side' | 'wide'
//   onDetent(detent)  the sheet settled at 'peek' | 'half' | 'full'
//   onTab(name)       a tab was shown
export function createPanel(hooks) {
  const root = document.documentElement;
  const panel = $('panel');
  const tabs = [...panel.querySelectorAll('.tabs [data-tab]')];
  let layout = '';
  let detent = load(DETENT, 'peek');
  if (!['peek', 'half', 'full'].includes(detent)) detent = 'peek';
  if (routeTab() && detent === 'peek') detent = 'half';
  let tab = routeTab() || load(TAB, 'looks');
  if (!tabs.some((b) => b.dataset.tab === tab)) tab = 'looks';
  let rail = !!load(RAIL, false);
  let visible = PEEK;
  const panelApi = {};
  const tabBar = panel.querySelector('.tabs'), handle = $('handle'), peekLine = $('peekLine');
  let peekExtra = 0; // what the peek shows besides its line: the apply bar's height while a preview is up

  // below is what sits under the sheet's content: the tab bar and the safe area (the panel's padding).
  const below = () => parseFloat(getComputedStyle(panel).paddingBottom) || 0;
  // heights are how much of the screen's bottom each detent covers, the tab bar included.
  const heights = () => {
    const h = innerHeight, sb = below();
    return { peek: PEEK + sb + peekExtra, half: Math.max(HALF_MIN + sb, Math.round(h * HALF)), full: h - STRIP };
  };
  // placeTabs puts the tab bar where the layout has it: the last thing on a
  // phone's screen (and in its Tab order), the panel's first row elsewhere.
  function placeTabs() {
    const home = layout === 'sheet' ? document.body : panel;
    if (tabBar.parentElement === home) return;
    const had = tabBar.contains(document.activeElement) ? document.activeElement : null;
    if (home === panel) panel.insertBefore(tabBar, $('content')); else panel.after(tabBar);
    had?.focus({ preventScroll: true });
  }
  function setVisible(px) {
    visible = px;
    root.style.setProperty('--sheet-visible', px + 'px');
  }

  function showTab(name, navigation = 'push') {
    if (!tabs.some((b) => b.dataset.tab === name)) return;
    if (name !== tab) $('content').scrollTop = 0; // the panel's one scroller
    tab = name;
    root.dataset.tab = name;
    const url = new URL(location.href);
    url.pathname = '/' + name;
    if (navigation !== 'none' && url.pathname !== location.pathname) {
      history[navigation === 'replace' ? 'replaceState' : 'pushState'](null, '', url);
    }
    document.title = `Glowstack · ${name[0].toUpperCase() + name.slice(1)}`;
    save(TAB, name);
    for (const b of tabs) {
      const on = b.dataset.tab === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    }
    for (const s of panel.querySelectorAll('.tab')) s.hidden = s.id !== 'tab-' + name;
    hooks.onTab(name);
  }

  function setDetent(d, quiet) {
    if (layout !== 'sheet') return;
    detent = d;
    save(DETENT, d);
    document.body.dataset.detent = d;
    setVisible(heights()[d]);
    if (d === 'peek') $('content').scrollTop = 0;
    handle.setAttribute('aria-valuenow', DETENTS.indexOf(d));
    handle.setAttribute('aria-valuetext', DETENT_WORDS[d]);
    showRail();
    if (!quiet) hooks.onDetent(d);
  }

  function showRail() {
    document.body.classList.toggle('rail', layout === 'side' && rail);
    // The rail's toggle is the side panel's. A phone has none: its sheet is
    // moved by its handle (ui.css hides this button in the sheet layout).
    const b = $('railToggle');
    const t = rail ? 'Open the panel' : 'Collapse the panel';
    b.title = t;
    b.setAttribute('aria-label', t);
    b.innerHTML = icon(rail ? 'chevronLeft' : 'chevronRight');
  }

  function setRail(on) {
    rail = on;
    save(RAIL, on);
    showRail();
    hooks.onLayout(layout);
  }

  // refresh applies the layout ui.css chose; quiet skips the hooks.
  function refresh(quiet) {
    const l = getComputedStyle(root).getPropertyValue('--layout').trim() || 'wide';
    const changed = l !== layout;
    layout = l;
    document.body.dataset.layout = l;
    placeTabs();
    showRail();
    if (l === 'sheet') setDetent(detent, true);
    else { delete document.body.dataset.detent; root.style.removeProperty('--sheet-visible'); }
    if (changed && !quiet) hooks.onLayout(l);
    return changed;
  }

  for (const b of tabs) {
    b.onclick = () => {
      if (dragged) return;
      if (layout === 'side' && rail) setRail(false);
      if (layout === 'sheet' && detent === 'peek') setDetent('half');
      showTab(b.dataset.tab);
    };
  }
  const stepUp = () => setDetent(detent === 'peek' ? 'half' : detent === 'half' ? 'full' : 'half');
  $('railToggle').onclick = () => { if (layout !== 'sheet') setRail(!rail); };

  // Dragging the handle or the peek's line moves the sheet with the finger;
  // letting go settles on the nearest detent, or the next one along a flick.
  let drag = null, dragged = false;
  const grab = (e) => {
    if (layout !== 'sheet') return;
    drag = { id: e.pointerId, y: e.clientY, start: visible, t: e.timeStamp, vy: 0, lastY: e.clientY, lastT: e.timeStamp, el: e.currentTarget };
    dragged = false;
    document.body.classList.add('sheet-dragging');
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!dragged && Math.abs(dy) < 6) return;
    if (!dragged) {
      dragged = true;
      panel.classList.add('dragging');
      drag.el.setPointerCapture(e.pointerId);
    }
    const dt = Math.max(1, e.timeStamp - drag.lastT);
    drag.vy = (e.clientY - drag.lastY) / dt;
    drag.lastY = e.clientY; drag.lastT = e.timeStamp;
    const h = heights();
    setVisible(clamp(drag.start - dy, h.peek, h.full));
  };
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag;
    drag = null;
    document.body.classList.remove('sheet-dragging');
    if (!dragged) return;
    panel.classList.remove('dragging');
    setDetent(settle(heights(), visible, was.vy));
    // The click that ends a drag isn't a tap on the handle.
    setTimeout(() => { dragged = false; }, 0);
  };
  // A mouse drag that starts here must not select the page's text.
  guardSelection(document, () => !!drag);
  for (const el of [handle, peekLine]) {
    el.addEventListener('pointerdown', grab);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    // Tapping the handle (or the peek's line) steps the sheet up, or back down from full.
    el.addEventListener('click', () => { if (!dragged && layout === 'sheet') stepUp(); });
  }
  // The handle is a named control with its state: Up and Down step the
  // detents, Home and End go to the ends, Enter and Space step like a tap.
  handle.addEventListener('keydown', (e) => {
    if (layout !== 'sheet') return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stepUp(); return; }
    const to = detentStep(detent, e.key);
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) e.preventDefault();
    if (to) setDetent(to);
  });

  // A finger on the content scrolls it. Only with the content at its top
  // and the finger going down does the same touch move the sheet instead,
  // so a list is never dragged away while it is being read.
  let pull = null;
  const content = $('content');
  const editable = (t) => !!t.closest?.('input, select, textarea, [contenteditable], .picker, .target-picker');
  content.addEventListener('touchstart', (e) => {
    pull = null;
    if (layout !== 'sheet' || e.touches.length !== 1 || editable(e.target)) return;
    const t = e.touches[0];
    pull = { x: t.clientX, y: t.clientY, top: content.scrollTop, on: false, start: visible, lastY: t.clientY, lastT: e.timeStamp, vy: 0 };
  }, { passive: true });
  content.addEventListener('touchmove', (e) => {
    if (!pull) return;
    const t = e.touches[0], dy = t.clientY - pull.y;
    if (!pull.on) {
      if (!dragsSheet({ scrollTop: pull.top, dx: t.clientX - pull.x, dy })) { if (Math.abs(dy) > 6 || content.scrollTop > 0) pull = dy > 0 && content.scrollTop <= 0 ? pull : null; return; }
      pull.on = true;
      panel.classList.add('dragging');
      document.body.classList.add('sheet-dragging');
    }
    e.preventDefault();
    const dt = Math.max(1, e.timeStamp - pull.lastT);
    pull.vy = (t.clientY - pull.lastY) / dt;
    pull.lastY = t.clientY; pull.lastT = e.timeStamp;
    const h = heights();
    setVisible(clamp(pull.start - dy, h.peek, h.full));
  }, { passive: false });
  const letGo = () => {
    const was = pull;
    pull = null;
    if (!was || !was.on) return;
    panel.classList.remove('dragging');
    document.body.classList.remove('sheet-dragging');
    setDetent(settle(heights(), visible, was.vy));
  };
  content.addEventListener('touchend', letGo);
  content.addEventListener('touchcancel', letGo);

  // Anything opened by hand scrolls clear of the sticky bar: scroll-padding
  // on .content is that bar's height. Polls that reopen a disclosure don't.
  let opening = null;
  $('content').addEventListener('click', (e) => { opening = e.target.closest?.('summary')?.parentElement || null; }, true);
  $('content').addEventListener('toggle', (e) => {
    if (e.target === opening && e.target.open) {
      const content = $('content'), room = content.clientHeight - (parseFloat(getComputedStyle(content).scrollPaddingBottom) || 0);
      // Too tall for half a sheet: it needs the room, not half of itself.
      if (layout === 'sheet' && detent === 'half' && e.target.offsetHeight > room) setDetent('full');
      e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    opening = null;
  }, true);

  // The fade under the content's top edge shows only while something has
  // scrolled under it: at rest the first card's top is whole (B146).
  const markScrolled = () => $('content').classList.toggle('scrolled', $('content').scrollTop > 0);
  $('content').addEventListener('scroll', markScrolled, { passive: true });
  markScrolled();

  // The first paint is already at the right height: no rise from the peek.
  panel.classList.add('dragging');
  refresh(true);
  requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('dragging')));
  showTab(tab, 'replace');
  window.addEventListener('popstate', () => {
    if (layout === 'side' && rail) setRail(false);
    if (layout === 'sheet' && detent === 'peek') setDetent('half');
    showTab(routeTab() || 'looks', 'none');
  });
  Object.assign(panelApi, {
    layout: () => layout,
    detent: () => (layout === 'sheet' ? detent : null),
    setDetent,
    tab: () => tab,
    // openTab shows a tab where it can be read: the rail expands, a
    // peeking sheet rises to half.
    openTab(name) {
      if (layout === 'side' && rail) setRail(false);
      if (layout === 'sheet' && detent === 'peek') setDetent('half');
      showTab(name);
    },
    // covered is how much of the map's bottom edge the sheet hides.
    covered: () => (layout === 'sheet' ? visible : 0),
    // collapsed reports a peeking sheet or an icon rail: the panel's
    // contents can't be seen.
    collapsed: () => (layout === 'sheet' ? detent === 'peek' : layout === 'side' && rail),
    refresh: () => refresh(false),
    // toTop scrolls the panel back to its heading.
    toTop: () => { $('content').scrollTop = 0; },
    // setPeekLine is the one line a peeking sheet shows: the current tab's state.
    setPeekLine(text) { if (peekLine.textContent !== text) peekLine.textContent = text; },
    // setPeekExtra says how tall the peek's extra row is (the apply bar while
    // a preview is up, 0 without one): a peeking sheet rises by that much.
    setPeekExtra(px) {
      if (px === peekExtra) return;
      peekExtra = px;
      if (layout === 'sheet' && detent === 'peek') { setVisible(heights().peek); hooks.onDetent('peek'); }
    },
    // tabBar is the height of the phone's tab bar with its safe area: 0 elsewhere.
    tabBar: () => (layout === 'sheet' ? below() : 0),
  });
  return panelApi;
}
