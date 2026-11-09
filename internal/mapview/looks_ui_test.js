// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Tests for how looks are drawn in the panels. Run with:
// node --test internal/mapview/looks_ui_test.js
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const form = () => import('./static/form.js');

const palettes = [
  { id: 'default', name: 'Default', stops: [[0, '#111111'], [1, '#222222']] },
  { id: 'color-1', name: '* Color 1', stops: [[0, '#111111']] },
  { id: 'colors-1-2', name: '* Colors 1&2', stops: [[0, '#111111']] },
  { id: 'party', name: 'Party', stops: [[0, '#5500ab'], [1, '#84007c']] },
  { id: 'rainbow', name: 'Rainbow', stops: [[0, '#ff0000'], [1, '#00ff00']] },
  { id: 'frost', name: 'frost', stops: [[0, '#0040ff/00'], [1, '#ffffff/ff']] },
  { id: 'Upper', name: 'Mixed name', stops: [[0, '#00ff00'], [1, '#0000ff']] },
  { id: 'blocks', name: 'Blocks', interpolate: 'step', wrap: true, stops: [[0, '#ff0000'], [0.5, '#0000ff']] },
  { id: 'late', name: 'Late', interpolate: 'step', wrap: true, stops: [[0.25, '#ff0000'], [0.75, '#0000ff']] },
  { id: 'late-flat', name: 'Late flat', interpolate: 'step', wrap: false, stops: [[0.25, '#ff0000'], [0.75, '#0000ff']] },
];
const orange = ['#ffa000', '#000000', '#000000'];
const catalog = { effects: [
  { id: 'gradient', params: [{ name: 'palette', type: 'palette', default: 'Default' }, { name: 'colors', type: 'colors', default: orange }] },
  { id: 'noise', params: [{ name: 'palette', type: 'palette', default: 'Default' }, { name: 'colors', type: 'colors', default: orange }] },
  { id: 'sparkle', params: [{ name: 'color', type: 'color', default: '#ffffff' }, { name: 'palette', type: 'palette', default: 'Default' }] },
  { id: 'glitter', params: [{ name: 'gradient.palette', type: 'palette', default: 'Rainbow' }, { name: 'gradient.colors', type: 'colors', default: orange }, { name: 'sparkle.color', type: 'color', default: '#ffffff' }, { name: 'sparkle.palette', type: 'palette', default: 'Default' }] },
  { id: 'chase', params: [{ name: 'colors', type: 'colors', default: ['#ffffff'] }, { name: 'background', type: 'color', default: '#000000' }] },
] };
const S = { palettes, catalog };

test('inline palette stops show their own colors, not the effect default', async () => {
  const { lookStrip } = await form();
  const red = lookStrip(S, 'gradient', { palette: [[0, '#ff0000'], [1, '#800000']] });
  assert.equal(red, 'linear-gradient(90deg, rgb(255,0,0) 0.0%, rgb(128,0,0) 100.0%)');
  assert.notEqual(red, lookStrip(S, 'gradient', { palette: [[0, '#00ff00'], [1, '#008000']] }));
});

test('Default resolves to each effect\'s own palette', async () => {
  const { lookStrip } = await form();
  assert.match(lookStrip(S, 'gradient', {}), /255,0,0/, 'gradient defaults to Rainbow');
  assert.match(lookStrip(S, 'noise', {}), /85,0,171/, 'noise defaults to Party');
  assert.match(lookStrip(S, 'sparkle', { color: '#ff0000' }), /, rgb\(255,0,0\)$/, 'sparkle defaults to its color');
});

test('the color palettes use the look\'s colors', async () => {
  const { lookStrip } = await form();
  assert.equal(lookStrip(S, 'gradient', { palette: '* Color 1', colors: ['#ff0000'] }), 'rgb(255,0,0)');
  assert.equal(lookStrip(S, 'gradient', { palette: 'colors-1-2', colors: ['#ff0000', '#0000ff'] }), 'linear-gradient(90deg, rgb(255,0,0), rgb(0,0,255))');
});

test('stops with a white channel make valid CSS', async () => {
  const { lookStrip } = await form();
  assert.doesNotMatch(lookStrip(S, 'gradient', { palette: 'frost' }), /\/|#/);
});

test('step palettes show hard edges, as the renderer holds each stop', async () => {
  const { lookStrip } = await form();
  assert.equal(lookStrip(S, 'gradient', { palette: 'blocks' }),
    'linear-gradient(90deg, rgb(255,0,0) 0.0%, rgb(255,0,0) 50.0%, rgb(0,0,255) 50.0%, rgb(0,0,255) 100.0%)');
  assert.match(lookStrip(S, 'gradient', { palette: 'late' }), /^linear-gradient\(90deg, rgb\(0,0,255\) 0\.0%, rgb\(0,0,255\) 25\.0%, rgb\(255,0,0\) 25\.0%/, 'a wrapping palette starts on its last stop');
  assert.match(lookStrip(S, 'gradient', { palette: 'late-flat' }), /^linear-gradient\(90deg, rgb\(255,0,0\) 0\.0%, rgb\(255,0,0\) 25\.0%/, 'one that does not wrap starts on its first');
});

test('palettes are found by exact id or by name in any case', async () => {
  const { palette } = await form();
  assert.equal(palette(S, 'Upper').id, 'Upper');
  assert.equal(palette(S, 'MIXED NAME').id, 'Upper');
  assert.equal(palette(S, 'upper'), null);
});

test('a composite uses its first palette, whichever key is written first', async () => {
  const { lookStrip } = await form();
  const params = { 'sparkle.palette': 'frost', 'gradient.palette': 'Party' };
  assert.match(lookStrip(S, 'glitter', params), /85,0,171/);
});

test('plain color lists still draw', async () => {
  const { lookStrip } = await form();
  assert.equal(lookStrip(S, 'solid-list', { colors: ['#ff0000', '#0000ff'] }), 'linear-gradient(90deg, rgb(255,0,0), rgb(0,0,255))');
});

test('tapping a look already in preview takes it off rather than stacking it', async () => {
  const { lookAction } = await import('./static/panel/looks.js');
  const look = { preset: 'dusk' };
  const layer = { id: 'p1', target: 'porch', preset: 'dusk' };
  assert.deepEqual(lookAction([], 'porch', look), { add: true });
  assert.deepEqual(lookAction([layer], 'porch', look), { remove: 'p1' });
  assert.deepEqual(lookAction([layer], 'yard', look), { add: true }, 'in preview is per target');
  assert.deepEqual(lookAction([layer], 'porch', { effect: 'dusk' }), { add: true }, 'an effect is not a preset of the same name');
  assert.deepEqual(lookAction([{ ...layer, params: { speed: 2 } }], 'porch', look), { focus: 'p1' }, 'a tweak is not thrown away');
  assert.deepEqual(lookAction([layer], 'porch', look, { p1: 'h1' }), { focus: 'p1' }, 'nor is a copy being edited');
});

test('the clock shows hours and minutes in plain words, and milliseconds only while scrubbing', async () => {
  const { clockText } = await import('./static/panel/looks.js');
  const st = { t: 1_700_000_000, paused: false, following: true, speed: 1, offset: 0 };
  const line = clockText(st);
  assert.doesNotMatch(line, /\.\d{3}/);
  assert.match(line, /in step with the lights$/);
  assert.match(clockText({ ...st, paused: true }), /^Paused · /);
  assert.match(clockText({ ...st, following: false, offset: 1.5 }), /1\.50 s ahead of the lights$/);
  assert.match(clockText({ ...st, following: false, offset: -2 }), /2\.00 s behind the lights$/);
  assert.match(clockText(st, true), /\d{3}/, 'scrubbing shows milliseconds');
});

test('the lanes use the shared states, including a failed load', async () => {
  const { previewState, houseState } = await import('./static/panel/looks.js');
  assert.equal(previewState(null, 'loading').kind, 'loading');
  assert.equal(previewState(null, 'failed').kind, 'error');
  assert.equal(previewState({ layers: [] }, 'ready'), null, 'an empty preview is the stage with no rows');
  assert.equal(previewState({ layers: [{}] }, 'ready'), null);
  assert.equal(houseState('loading', 0).kind, 'loading');
  assert.equal(houseState('unavailable', 0).kind, 'error');
  assert.equal(houseState('available', 0).kind, 'empty');
  assert.equal(houseState('available', 2), null);
});

test('places group by name with repeats resolved, and search finds them', async () => {
  const { buildTree, targetGroups, targetName } = await import('./static/select.js');
  const geo = {
    pixels: { count: 6, run: [0, 0, 1, 1, 2, 2] },
    runs: [{ id: 'shed-eave' }, { id: 'fence-a' }, { id: 'side-gate' }],
    areas: [{ id: 'shed-eave', ranges: [[0, 1]] }, { id: 'front', ranges: [[0, 3]] }],
    zones: [{ id: 'z1', name: 'Front yard', area: 'front' }],
  };
  const tree = buildTree(geo);
  const groups = targetGroups(tree);
  assert.deepEqual(groups.map((g) => g.label), ['Everything', 'Zones', 'Areas', 'Runs']);
  assert.deepEqual(groups.find((g) => g.label === 'Areas').items, [{ value: 'shed-eave', label: 'Shed eave' }], 'a run that is also an area is one row');
  assert.deepEqual(groups.find((g) => g.label === 'Zones').items, [{ value: 'front', label: 'Front yard' }]);
  assert.deepEqual(targetGroups(tree, { query: 'SIDE' }).flatMap((g) => g.items.map((i) => i.label)), ['Side gate']);
  assert.deepEqual(targetGroups(tree, { query: 'z1' }).flatMap((g) => g.items.map((i) => i.label)), ['Front yard'], 'ids still match');
  assert.equal(targetGroups(tree, { visibleRuns: [true, false, true] }).find((g) => g.label === 'Runs').items.some((i) => i.label === 'Fence a'), false);
  assert.equal(targetName(geo, 'front'), 'Front yard');
  assert.equal(targetName(geo, 'run:side-gate'), 'Side gate');
  assert.equal(targetName(geo, 'all'), 'Everything');
});

test('a preset with no name of its own reads in words', async () => {
  const { presetName } = await form();
  assert.equal(presetName({ id: 'slow-crawl' }), 'Slow crawl');
  assert.equal(presetName({ id: 'slow-crawl', name: 'slow-crawl' }), 'Slow crawl');
  assert.equal(presetName({ id: 'x', name: 'Named' }), 'Named');
});

test('setting labels say what the setting does', async () => {
  const { paramLabel } = await form();
  assert.equal(paramLabel('span'), 'Repeat length');
  assert.equal(paramLabel('gradient.span'), 'Gradient repeat length');
  assert.equal(paramLabel('colors.0'), 'Color 1');
});

test('palettes are in before the first panel renders', async () => {
  const { createLibrary } = await import('./static/library.js');
  const seen = {};
  await createLibrary(seen, async (p) => ({ effects: [], presets: [], palettes: [{ id: 'sample', name: 'Sample', stops: [] }] }))();
  assert.equal(seen.palettes[0].id, 'sample');
  assert.equal(seen.library.palettes, 'ready');
});
