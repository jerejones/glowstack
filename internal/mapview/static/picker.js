// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The picker: a button that opens a list in the page flow, like Show on.
// It stands in for a <select>: it has .value and .options, and fires
// change, so code that drove a select keeps working.
import { icon } from './icons.js';

// A list longer than this gets a search box.
export const SEARCH_FROM = 10;

export const matchOptions = (options, query) => {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
};

// stepActive is the list position an arrow or Home/End key moves to, or
// null for any other key.
export function stepActive(key, active, count) {
  if (!count) return null;
  switch (key) {
    case 'ArrowDown': return Math.min(active + 1, count - 1);
    case 'ArrowUp': return Math.max(active - 1, 0);
    case 'Home': return 0;
    case 'End': return count - 1;
  }
  return null;
}

// escapeCloses gives a popover its Escape: el is everything that can hold
// focus while it's open. Handled here, the key doesn't go on to clear the
// map's selection or drop the sheet.
export function escapeCloses(el, isOpen, close) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
}

// keepInList scrolls only the list, by what's needed to show row c.
function keepInList(list, c) {
  if (c.offsetTop < list.scrollTop) list.scrollTop = c.offsetTop;
  else if (c.offsetTop + c.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = c.offsetTop + c.offsetHeight - list.clientHeight;
}

let pickers = 0;

// createPicker takes options as [{ value, label, swatch }]; swatch is a
// CSS background for a strip beside the label.
export function createPicker(options = [], { label = '', id = '', name = '' } = {}) {
  const uid = `picker${++pickers}`;
  const el = document.createElement('div');
  el.className = 'picker';
  if (id) el.id = id;
  if (name) el.setAttribute('name', name);
  el.innerHTML = `<button type="button" class="picker-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="${uid}"><span class="picker-swatch" hidden></span><span class="picker-label"></span>${icon('chevronDown')}</button>
    <div class="picker-pop" hidden><input type="search" placeholder="Find" autocomplete="off" aria-label="Find" hidden><div class="picker-list" id="${uid}" role="listbox" tabindex="-1"></div><div class="muted small picker-none" hidden>Nothing matches.</div></div>`;
  const btn = el.querySelector('.picker-btn'), pop = el.querySelector('.picker-pop');
  const search = pop.querySelector('input'), list = pop.querySelector('.picker-list'), none = pop.querySelector('.picker-none');
  const shownLabel = btn.querySelector('.picker-label'), shownSwatch = btn.querySelector('.picker-swatch');
  if (label) { btn.setAttribute('aria-label', label); list.setAttribute('aria-label', label); }
  let value = '', shown = [], active = -1;

  const current = () => options.find((o) => o.value === value);
  function paintButton() {
    const o = current();
    shownLabel.textContent = o ? o.label : value;
    shownSwatch.hidden = !(o && o.swatch);
    if (o && o.swatch) shownSwatch.style.background = o.swatch;
    btn.title = o ? o.label : value;
    if (label) btn.setAttribute('aria-label', `${label}: ${shownLabel.textContent}`);
  }
  function setActive(i) {
    active = i;
    [...list.children].forEach((c, n) => c.classList.toggle('active', n === i));
    const c = list.children[i];
    if (c) { (search.hidden ? list : search).setAttribute('aria-activedescendant', c.id); keepInList(list, c); }
  }
  function paintList() {
    shown = matchOptions(options, search.value);
    list.replaceChildren(...shown.map((o, i) => {
      const row = document.createElement('div');
      row.id = `${uid}-${i}`;
      row.className = 'picker-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(o.value === value));
      if (o.swatch) { const s = document.createElement('span'); s.className = 'picker-swatch'; s.style.background = o.swatch; row.append(s); }
      const t = document.createElement('span');
      t.textContent = o.label;
      row.append(t);
      if (o.note) row.append(Object.assign(document.createElement('span'), { className: 'picker-note', textContent: o.note }));
      row.onclick = () => choose(o);
      return row;
    }));
    none.hidden = shown.length > 0;
    setActive(Math.max(0, shown.findIndex((o) => o.value === value)));
  }
  const outside = (e) => { if (!el.isConnected || !el.contains(e.target)) close(); };
  function open() {
    el.classList.add('open');
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    search.hidden = options.length < SEARCH_FROM;
    search.value = '';
    paintList();
    (search.hidden ? list : search).focus({ preventScroll: true });
    pop.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    document.addEventListener('pointerdown', outside, true);
  }
  function close(refocus) {
    el.classList.remove('open');
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (refocus) btn.focus();
  }
  function choose(o) {
    close(true);
    if (o.value === value) return;
    value = o.value;
    paintButton();
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  btn.onclick = () => (pop.hidden ? open() : close());
  btn.onkeydown = (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && pop.hidden) { e.preventDefault(); open(); }
  };
  pop.onkeydown = (e) => {
    const next = stepActive(e.key, active, shown.length);
    if (next !== null && !(e.target === search && (e.key === 'Home' || e.key === 'End'))) { e.preventDefault(); setActive(next); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active]); }
    else if (e.key === 'Tab') close();
  };
  escapeCloses(el, () => !pop.hidden, () => close(true));
  search.oninput = paintList;
  search.onchange = (e) => e.stopPropagation();

  Object.defineProperties(el, {
    value: { get: () => value, set(v) { value = String(v); paintButton(); if (!pop.hidden) paintList(); } },
    options: { get: () => options, set(list) { options = list; paintButton(); if (!pop.hidden) paintList(); } },
    isOpen: { get: () => !pop.hidden },
  });
  return el;
}

// upgradeSelects swaps each <select> under root for a picker.
export function upgradeSelects(root) {
  for (const s of root.querySelectorAll('select')) {
    const p = createPicker([...s.options].map((o) => ({ value: o.value, label: o.textContent })), { label: s.getAttribute('aria-label') || '', id: s.id, name: s.getAttribute('name') || '' });
    p.value = s.value;
    s.replaceWith(p);
  }
}
