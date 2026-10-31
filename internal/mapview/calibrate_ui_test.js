// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'static/calibrate.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Run the real panel script with a minimal DOM and a controlled server.
// Buttons and inputs are rebuilt from its HTML, as they are in a browser.
async function panel(fetch, saved = new Map()) {
  const elements = new Map();
  const box = {
    buttons: [],
    set innerHTML(html) {
      this.buttons = [...html.matchAll(/<button[^>]*data-a="(\d+)"[^>]*>([^<]*)<\/button>/g)]
        .map((m) => ({ dataset: { a: m[1] }, label: m[2] }));
      if (html.includes('id="calNext"')) {
        elements.set('calNext', { checked: /id="calNext" checked/.test(html) });
      }
    },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '[data-a]' ? this.buttons : []; },
  };
  elements.set('cal', box);
  elements.set('calToggle', {});
  const document = {
    body: { classList: { contains() { return false; } } },
    activeElement: null,
    addEventListener() {},
  };
  vm.runInNewContext(source, {
    document, S: { geo: null }, $: (id) => elements.get(id), esc: String,
    fetch, setInterval() {}, resize() {}, markDirty() {},
    sessionStorage: { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
  });
  await flush();
  return {
    elements,
    click(label) {
      const b = box.buttons.find((b) => b.label === label);
      assert.ok(b, `missing button ${label}`);
      b.onclick({ preventDefault() {} });
    },
  };
}

function state() {
  return {
    active: true, label: 'anchor corner on eave', side: 0,
    target: { kind: 'anchor', run: 'eave', node: 'corner' },
    cursors: [{ controller: 'shed', index: 5, estimate: 5, min: 0, max: 20, source: 'estimated' }],
    progress: [],
  };
}

const reply = (st) => ({ ok: true, text: async () => JSON.stringify(st) });

test('confirm waits for an earlier nudge to finish', async () => {
  const st = state();
  let releaseNudge, confirmedIndex;
  const p = await panel(async (url, opts) => {
    if (url.endsWith('/nudge')) {
      await new Promise((resolve) => { releaseNudge = resolve; });
      st.cursors[0].index += JSON.parse(opts.body).by;
    }
    if (url.endsWith('/confirm')) confirmedIndex = st.cursors[0].index;
    return reply(st);
  });
  p.click('+1');
  await flush();
  p.click('Confirm');
  await flush();
  const confirmedBeforeNudge = confirmedIndex !== undefined;
  releaseNudge();
  await flush();
  await flush();
  assert.equal(confirmedBeforeNudge, false, 'confirm overtook the pending nudge');
  assert.equal(confirmedIndex, 6);
});

test('confirm-and-next preference survives the reload caused by confirming', async () => {
  const saved = new Map();
  const fetch = async () => reply(state());
  const first = await panel(fetch, saved);
  const checkbox = first.elements.get('calNext');
  checkbox.checked = false;
  checkbox.onchange();
  first.click('Confirm');
  await flush();
  const reloaded = await panel(fetch, saved);
  assert.equal(reloaded.elements.get('calNext').checked, false);
});
