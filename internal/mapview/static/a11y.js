// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Working without a pointer (move G): the one live region that says what
// changed, and roving focus for the groups (a grid of cards, a list of
// rows, a segmented bar, the tabs, a menu of places). A group is one Tab
// stop: the arrow keys move inside it, Home and End go to its ends, and
// Enter or Space activates as on any button. Nothing here draws anything:
// the focus ring is ui.css's.

// ---------- the live region ----------

// announce says text to a screen reader: politely, or at once for an error
// (assertive). The same sentence twice in a row is still said twice.
let polite = null, alert = null, flip = false;
export function announce(text, { assertive = false } = {}) {
  const doc = globalThis.document;
  if (!doc || !text || typeof doc.getElementById !== 'function') return;
  polite ||= doc.getElementById('live');
  alert ||= doc.getElementById('liveAlert');
  const box = assertive ? alert : polite;
  if (!box) return;
  // A changed node is what gets read: alternate a trailing no-break space
  // so a repeat is a change too.
  flip = !flip;
  box.textContent = String(text).replace(/ /g, ' ') + (flip ? ' ' : '');
}

// selectionWords is what a change of selection announces.
export const selectionWords = (name, zone = '') => (name ? `Selected ${name}${zone && zone !== name ? `, in ${zone}` : ''}` : 'Selection cleared: the next look goes on everything');

// previewWords is what a change in the preview announces: prev and next are
// the previewed looks' names before and after, where the place the newest
// one is on. '' when nothing worth saying changed.
export function previewWords(prev, next, where = '') {
  if (next.length > prev.length) return `Previewing ${next[0]}${where ? ` on ${where}` : ''}${next.length > 1 ? `: ${next.length} looks in the preview` : ''}`;
  if (!next.length && prev.length) return 'Preview cleared';
  if (next.length < prev.length) return `Removed from the preview: ${next.length} ${next.length === 1 ? 'look' : 'looks'} left`;
  return '';
}

// mapWords is the map's description for someone who cannot see it: what is
// selected, what the map shows, and how to choose a place without a pointer.
export function mapWords({ selected = '', zone = '', showing = '' }) {
  const sel = selected ? `Selected: ${selected}${zone && zone !== selected ? `, in ${zone}` : ''}.` : 'Nothing selected: the next look goes on everything.';
  return `${sel}${showing ? ` ${showing}.` : ''} To choose a run, an area or a zone without a pointer, use the Next look control on Looks.`;
}

// ---------- roving focus ----------

// GROUPS are the roving groups: [the group's selector, its items' selector].
// An item is counted only while it is on screen and enabled.
export const GROUPS = [
  ['[role=tablist]', '[role=tab]'],
  ['.seg', ':scope > button'],
  ['.chips.toggles', ':scope > button'],
  ['.cards', '.preset'],
  ['.target-list', 'button'],
  ['.preset-library', '.preset-actions button:not([role=menuitem])'],
  ['.cal-prog', 'summary, button'],
];
const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

// roveTo is the index focus moves to from item i for key: rects are the
// items' boxes ({ left, top, right, bottom }) in order. Left and Right step
// through the order; Up and Down go to the nearest item in the row above or
// below (by horizontal overlap, then by distance); Home and End go to the
// ends. In a single row or column every arrow steps. -1 for no move.
export function roveTo(rects, i, key) {
  const n = rects.length;
  if (!n || i < 0 || !KEYS.includes(key)) return -1;
  if (key === 'Home') return i === 0 ? -1 : 0;
  if (key === 'End') return i === n - 1 ? -1 : n - 1;
  const mid = (r) => (r.top + r.bottom) / 2, cx = (r) => (r.left + r.right) / 2;
  const sameRow = (a, b) => Math.abs(mid(a) - mid(b)) < Math.min(a.bottom - a.top, b.bottom - b.top) / 2;
  const oneRow = rects.every((r) => sameRow(r, rects[0]));
  const oneCol = rects.every((r) => Math.abs(cx(r) - cx(rects[0])) < 2) && !oneRow;
  const back = key === 'ArrowLeft' || key === 'ArrowUp';
  if (oneRow || oneCol || key === 'ArrowLeft' || key === 'ArrowRight') {
    const to = i + (back ? -1 : 1);
    return to < 0 || to >= n ? -1 : to;
  }
  // Up or Down in a grid: the row above or below, the item most under this one.
  const here = rects[i];
  const others = rects.map((r, k) => ({ r, k })).filter(({ r }) => (back ? mid(r) < here.top : mid(r) > here.bottom));
  if (!others.length) return -1;
  const edge = back ? Math.max(...others.map(({ r }) => mid(r))) : Math.min(...others.map(({ r }) => mid(r)));
  const row = others.filter(({ r }) => Math.abs(mid(r) - edge) < (r.bottom - r.top) / 2);
  row.sort((a, b) => Math.abs(cx(a.r) - cx(here)) - Math.abs(cx(b.r) - cx(here)));
  return row[0].k;
}

// current is the index of a group's one Tab stop: the item with the focus,
// else the chosen one (pressed, selected or current), else the first.
// items are { focused, chosen } in order.
export function currentItem(items) {
  let i = items.findIndex((it) => it.focused);
  if (i < 0) i = items.findIndex((it) => it.chosen);
  return i < 0 ? 0 : i;
}

// On screen and enabled. A control that is aria-disabled still takes the focus: pressed, it says why it does nothing.
const shown = (el) => el.getClientRects().length > 0 && !el.disabled && !el.closest('[inert]');
const itemsOf = (group, sel) => [...group.querySelectorAll(sel)].filter((el) => shown(el) && el.closest(GROUPS.map(([g]) => g).join(', ')) === group);
const groupOf = (el) => {
  for (const [g, items] of GROUPS) {
    const group = el.closest?.(g);
    if (group && itemsOf(group, items).includes(el)) return [group, items];
  }
  return null;
};
const chosen = (el) => el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || el.hasAttribute('aria-current') || el.classList.contains('here');

// syncGroup leaves a group one Tab stop.
function syncGroup(group, sel, doc) {
  const items = itemsOf(group, sel);
  if (!items.length) return;
  const at = currentItem(items.map((el) => ({ focused: el === doc.activeElement, chosen: chosen(el) })));
  items.forEach((el, i) => { const want = i === at ? 0 : -1; if (el.tabIndex !== want) el.tabIndex = want; });
}

// installRoving wires the groups under doc: the keys, and one Tab stop per
// group kept through every redraw. onMove(item, group, key) is told of a
// move (the tabs select as focus moves).
export function installRoving(doc, { onMove = null } = {}) {
  const syncAll = () => { for (const [g, sel] of GROUPS) for (const group of doc.querySelectorAll(g)) syncGroup(group, sel, doc); };
  let queued = false;
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; syncAll(); }); };
  doc.addEventListener('keydown', (e) => {
    if (!KEYS.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (!t || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
    const found = groupOf(t);
    if (!found) return;
    const [group, sel] = found, items = itemsOf(group, sel);
    const to = roveTo(items.map((el) => el.getBoundingClientRect()), items.indexOf(t), e.key);
    e.preventDefault(); // an arrow in a group never scrolls the panel from under it
    if (to < 0) return;
    items[to].focus();
    onMove?.(items[to], group, e.key);
  });
  doc.addEventListener('focusin', (e) => { const found = groupOf(e.target); if (found) syncGroup(found[0], found[1], doc); });
  new MutationObserver(later).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed', 'aria-selected', 'open', 'disabled'] });
  syncAll();
  return syncAll;
}
