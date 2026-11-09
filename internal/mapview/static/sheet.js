// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The panel's frame, whatever its width: which layout applies (ui.css
// decides, through --layout), the bottom sheet on phones with its drag
// handle and three detents (peek, half, full), the side panel's icon
// rail, and the tabs. The active tab and the rail are remembered per
// device. The tabs' contents belong to panel/*.js.
import { $, load, save, clamp } from './util.js';
import { icon } from './icons.js';

const TAB = 'glowstack.tab';
const RAIL = 'glowstack.rail';
const DETENT = 'glowstack.sheet.detent';
const routeTab = () => /^\/(looks|presets|setup|status)\/?$/.exec(location.pathname)?.[1] || null;
const PEEK = 68;   // handle (with Expand) and tab bar
const STRIP = 200; // the map above a full sheet: --strip in ui.css
const HALF = 0.5; // of the window's height, the same on every tab so the map holds still
const HALF_MIN = 344; // room for a look card above the Apply bar on a short phone

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

  const safeBottom = () => parseFloat(getComputedStyle(panel).paddingBottom) || 0;
  const heights = () => {
    const h = innerHeight, sb = safeBottom();
    return { peek: PEEK + sb, half: Math.max(HALF_MIN + sb, Math.round(h * HALF)), full: h - STRIP };
  };
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
    showRail();
    if (!quiet) hooks.onDetent(d);
  }

  function showRail() {
    document.body.classList.toggle('rail', layout === 'side' && rail);
    const b = $('railToggle');
    const up = layout === 'sheet' ? detent !== 'full' : rail;
    const t = layout === 'sheet' ? (up ? 'Expand the sheet' : 'Collapse the sheet') : rail ? 'Expand the panel' : 'Collapse the panel';
    b.title = t;
    b.setAttribute('aria-label', t);
    const word = layout === 'sheet' ? `<span class="lbl">${up ? 'Expand' : 'Collapse'}</span>` : '';
    b.innerHTML = icon(layout === 'sheet' ? (up ? 'chevronUp' : 'chevronDown') : rail ? 'chevronLeft' : 'chevronRight') + word;
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
  $('railToggle').onclick = () => {
    if (layout !== 'sheet') setRail(!rail);
    else if (!dragged) stepUp();
  };

  // Dragging the handle or the tab bar moves the sheet; letting go snaps
  // to the nearest detent, or the next one along a flick.
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
    const h = heights();
    const order = ['peek', 'half', 'full'];
    let best = order.reduce((a, b) => (Math.abs(h[b] - visible) < Math.abs(h[a] - visible) ? b : a));
    if (Math.abs(was.vy) > 0.5) {
      const i = order.indexOf(best), here = order.findIndex((d) => h[d] >= visible);
      if (was.vy < 0) best = order[Math.min(2, Math.max(i, here < 0 ? 2 : here))];
      else best = order[Math.max(0, Math.min(i, (here < 0 ? 3 : here) - 1))];
    }
    setDetent(best);
    // The click that ends a drag isn't a tab tap.
    setTimeout(() => { dragged = false; }, 0);
  };
  // A mouse drag that starts here must not select the page's text.
  guardSelection(document, () => !!drag);
  for (const el of [$('handle'), panel.querySelector('.tabs')]) {
    el.addEventListener('pointerdown', grab);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  }
  // Tapping the handle steps the sheet up, or back down from full.
  $('handle').addEventListener('click', () => {
    if (dragged || layout !== 'sheet') return;
    stepUp();
  });

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

  refresh(true);
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
  });
  return panelApi;
}
