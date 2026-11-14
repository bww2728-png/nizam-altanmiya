'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The central manual-entry catalogue is a pinned column with a fixed maximum
 * height, and it holds a long scrollable list. When the list was allowed to size
 * itself by content, it grew past the column's box (730px box, 1114px list) and
 * painted 653px of domain rows on top of the entry form below it: the two text
 * layers interleaved and the form became unreadable. The clamp only works when
 * the list row is bounded (`minmax(0, 1fr)`) and the list itself can shrink to
 * zero (`min-height: 0`), so those two declarations are pinned here.
 */

const CSS = path.resolve(__dirname, '..', 'src', 'renderer', 'styles', 'app.css');

function rules() {
  const source = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const map = new Map();
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    // Keep the first (base) declaration list; later blocks inside media queries refine it.
    if (!map.has(selector)) map.set(selector, match[2].replace(/\s+/g, ' ').trim());
  }
  return map;
}

test('the pinned catalogue column bounds its list row', () => {
  const body = rules().get('.data-entry-catalog');
  assert.ok(body, '.data-entry-catalog rule should exist');
  assert.match(body, /grid-template-rows:[^;]*minmax\(0,\s*1fr\)/, 'the last row must be allowed to shrink: grid-template-rows: ... minmax(0, 1fr)');
  assert.match(body, /overflow:\s*hidden/, 'the column must clip instead of painting over the next section');
  assert.match(body, /max-height:/, 'the column still needs a viewport-bound height for the clamp to have meaning');
});

test('the domain list can shrink so it scrolls instead of overflowing', () => {
  const body = rules().get('.data-entry-domain-list');
  assert.ok(body, '.data-entry-domain-list rule should exist');
  assert.match(body, /min-height:\s*0\b/, 'a positive min-height re-opens the overflow that hid the entry form');
  assert.match(body, /overflow:\s*auto/, 'the list must own its scrolling');
});

test('short or narrow windows drop the pin instead of clipping content', () => {
  const source = fs.readFileSync(CSS, 'utf8');
  assert.match(source, /@media \(max-width: 860px\)/, 'the stacked layout breakpoint must stay');
  assert.match(source, /@media \(max-height: 820px\) and \(min-width: 861px\)/, 'a short window needs a height-based fallback');
  const shortWindow = source.slice(source.indexOf('@media (max-height: 820px)'));
  assert.match(shortWindow, /\.data-entry-catalog \{[^}]*position:\s*static/, 'the fallback must unpin the catalogue');
});
