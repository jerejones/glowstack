// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The page's one tooltip, for controls that are an icon and no words (the
// More glyph, a clear x, the sheet's handle, the brightness icon). A native
// `title` never shows on touch or in a capture and takes its time with a
// mouse; this one is drawn in the page. A control opts in with `data-tip`,
// and has no `title` of its own. The tooltip:
//
//   - shows HOVER_MS after the pointer rests on the control, and at once
//     when the keyboard focuses it;
//   - shows on touch after a long press (PRESS_MS), and lingers a moment;
//   - sits above the control, or below when there is no room, and never
//     over it;
//   - is aria-hidden: the control's accessible name is its own
//     (aria-label), so nothing is said twice;
//   - is not shown where the control already shows those words (a phone's
//     "Brightness" label beside its icon).

export const HOVER_MS = 400;  // the pointer rests this long first
export const PRESS_MS = 500;  // a long press on touch
export const LINGER_MS = 1500; // how long it stays after a long press lets go
const GAP = 6;                // px between the control and its tooltip

// tipSpot is where a tooltip of size (w, h) goes for a control at anchor
// ({left, top, right, bottom}), in a viewport W by H: centered above it, or
// below when above has no room, held inside the viewport, and never
// overlapping the control. Returns { left, top, below }.
export function tipSpot(anchor, w, h, W, H, gap = GAP) {
  const cx = (anchor.left + anchor.right) / 2;
  const left = Math.max(4, Math.min(cx - w / 2, W - w - 4));
  const above = anchor.top - gap - h;
  const below = above < 4;
  // With no room either way it still goes clear of the control, on the side with more room.
  const top = !below ? above : anchor.bottom + gap + h <= H - 4 || H - anchor.bottom >= anchor.top ? anchor.bottom + gap : above;
  return { left: Math.round(left), top: Math.round(top), below: top > anchor.top };
}

// tipFor is the tooltip's text for el, or '' for none: its data-tip, unless
// the control already shows those words.
export function tipFor(el) {
  const tip = el?.dataset?.tip || '';
  if (!tip) return '';
  const shown = (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return shown && shown.includes(tip.toLowerCase()) ? '' : tip;
}

// installTooltips wires the one tooltip to doc. It returns { show, hide }.
export function installTooltips(doc = document) {
  const box = doc.createElement('div');
  box.id = 'tip';
  box.className = 'tip';
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  doc.body.append(box);
  let timer = 0, shownFor = null;
  const anchorOf = (t) => (t && t.closest ? t.closest('[data-tip]') : null);
  function hide() {
    clearTimeout(timer);
    shownFor = null;
    box.hidden = true;
  }
  function show(el) {
    clearTimeout(timer);
    const text = tipFor(el);
    if (!text || !el.isConnected) { hide(); return; }
    box.textContent = text;
    box.hidden = false;
    const r = el.getBoundingClientRect();
    const view = doc.defaultView;
    const at = tipSpot(r, box.offsetWidth, box.offsetHeight, view.innerWidth, view.innerHeight);
    box.style.left = at.left + 'px';
    box.style.top = at.top + 'px';
    shownFor = el;
  }
  const later = (el, ms) => { clearTimeout(timer); timer = setTimeout(() => show(el), ms); };
  // Mouse: after the pointer rests.
  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = anchorOf(e.target);
    if (el && el !== shownFor) later(el, HOVER_MS);
  });
  doc.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = anchorOf(e.target);
    if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hide();
  });
  // Keyboard: at once. A click's focus is not the keyboard's, and shows nothing.
  doc.addEventListener('focusin', (e) => {
    const el = anchorOf(e.target);
    if (el && e.target.matches?.(':focus-visible')) show(el);
  });
  doc.addEventListener('focusout', (e) => { if (anchorOf(e.target)) hide(); });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  // Touch: a long press shows it; it lingers briefly after the finger lifts.
  let pressAt = null;
  doc.addEventListener('pointerdown', (e) => {
    hide();
    if (e.pointerType === 'mouse') return;
    const el = anchorOf(e.target);
    if (!el) return;
    pressAt = [e.clientX, e.clientY];
    later(el, PRESS_MS);
  }, true);
  doc.addEventListener('pointermove', (e) => {
    if (pressAt && Math.hypot(e.clientX - pressAt[0], e.clientY - pressAt[1]) > 10) { pressAt = null; if (!shownFor) clearTimeout(timer); }
  }, true);
  const lift = () => {
    pressAt = null;
    if (shownFor) { clearTimeout(timer); timer = setTimeout(hide, LINGER_MS); } else clearTimeout(timer);
  };
  doc.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') lift(); }, true);
  doc.addEventListener('pointercancel', lift, true);
  // The page moved under it: it would point at nothing.
  doc.addEventListener('scroll', () => { if (shownFor) hide(); }, true);
  return { show, hide };
}
