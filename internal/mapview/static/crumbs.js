// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The map breadcrumb's collapse rule (B147). The chain is one row that never
// scrolls and never clips an end: when the whole chain does not fit, the
// older ancestors fold into one "…" crumb that opens the whole chain as a
// menu, and the current target, its parent and the clear button stay.

// crumbPlans lists the ways to show a chain of n crumbs with crumb `on`
// current, widest first; the row takes the first that fits. Each plan is
// { show, menu, squeeze }: the indices drawn, whether the "…" crumb leads
// them, and which crumb may shorten with an ellipsis ('' none, 'parent',
// then 'current' only as the last resort).
export function crumbPlans(n, on) {
  const all = Array.from({ length: n }, (_, i) => i);
  const plans = [{ show: all, menu: false, squeeze: '' }];
  const add = (show, squeeze = '') => {
    const last = plans[plans.length - 1];
    if (show.join() === last.show.join() && squeeze === last.squeeze) return;
    if (show.length === n && !squeeze) return; // nothing folded: that is the first plan
    plans.push({ show, menu: show.length < n, squeeze });
  };
  const from = Math.max(0, on - 1);
  add(all.slice(from));              // the parent, the target and what is under it
  add(all.slice(from, on + 1));      // the parent and the target
  if (on > 0) add([on - 1, on], 'parent');
  add([on]);                         // the target alone: its parent is in the menu
  add([on], 'current');
  return plans;
}

// reachTaps is how many taps reach crumb i under a plan: one when it is
// drawn, two when it is in the menu.
export const reachTaps = (plan, i) => (plan.show.includes(i) ? 1 : 2);

// fitCrumbs draws the first plan that fits box (its scrollWidth within its
// clientWidth) with draw(plan), and returns it. The last plan is kept even
// if nothing fits: its current crumb shortens, so the row still ends inside.
export function fitCrumbs(box, n, on, draw) {
  const plans = crumbPlans(n, on);
  for (const plan of plans) {
    draw(plan);
    if (box.scrollWidth <= box.clientWidth) return plan;
  }
  return plans[plans.length - 1];
}

// crumbKind is the one word the menu puts beside a place: its biggest kind,
// and nothing beside Everything, which says it already.
export function crumbKind(nd) {
  const top = nd.members[nd.members.length - 1];
  return top.kind === 'all' ? '' : top.kind;
}
