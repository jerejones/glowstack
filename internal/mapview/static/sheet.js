// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The panel's frame, whatever its width: which layout applies (ui.css
// decides, through --layout), the bottom sheet on phones with its drag
// handle and three detents (peek, half, full), the side panel's icon
// rail, and the tabs. The active tab and the rail are remembered per
// device. The tabs' contents belong to panel/*.js.
import { $, load, save, clamp } from './util.js';

const TAB = 'glowstack.tab';
const RAIL = 'glowstack.rail';
const DETENT = 'glowstack.sheet.detent';
const routeTab = () => /^\/(looks|setup|status)\/?$/.exec(location.pathname)?.[1] || null;
const PEEK = 56;   // handle and tab bar
const STRIP = 120; // the map above a full sheet
const HALF = 0.45; // of the window's height

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

  const safeBottom = () => parseFloat(getComputedStyle(panel).paddingBottom) || 0;
  const heights = () => {
    const h = innerHeight, sb = safeBottom();
    return { peek: PEEK + sb, half: Math.max(PEEK + sb + 120, Math.round(h * HALF)), full: h - STRIP };
  };
  function setVisible(px) {
    visible = px;
    root.style.setProperty('--sheet-visible', px + 'px');
  }

  function showTab(name, navigation = 'push') {
    if (!tabs.some((b) => b.dataset.tab === name)) return;
    tab = name;
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
    if (!quiet) hooks.onDetent(d);
  }

  function showRail() {
    document.body.classList.toggle('rail', layout === 'side' && rail);
    const t = rail ? 'Expand the panel' : 'Collapse the panel';
    $('railToggle').title = t;
    $('railToggle').setAttribute('aria-label', t);
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
  $('railToggle').onclick = () => setRail(!rail);

  // Dragging the handle or the tab bar moves the sheet; letting go snaps
  // to the nearest detent, or the next one along a flick.
  let drag = null, dragged = false;
  const grab = (e) => {
    if (layout !== 'sheet') return;
    drag = { id: e.pointerId, y: e.clientY, start: visible, t: e.timeStamp, vy: 0, lastY: e.clientY, lastT: e.timeStamp, el: e.currentTarget };
    dragged = false;
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
  for (const el of [$('handle'), panel.querySelector('.tabs')]) {
    el.addEventListener('pointerdown', grab);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  }
  // Tapping the handle steps the sheet up, or back down from full.
  $('handle').addEventListener('click', () => {
    if (dragged || layout !== 'sheet') return;
    setDetent(detent === 'peek' ? 'half' : detent === 'half' ? 'full' : 'half');
  });

  refresh(true);
  showTab(tab, 'replace');
  window.addEventListener('popstate', () => {
    if (layout === 'side' && rail) setRail(false);
    if (layout === 'sheet' && detent === 'peek') setDetent('half');
    showTab(routeTab() || 'looks', 'none');
  });
  return {
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
  };
}
