'use strict';
/**
 * The comprehensive database table is the only screen whose column count is not
 * bounded by the design: it can reach 40+ columns. This guards the contract that
 * keeps it usable — a wrapper that scrolls on both axes, a table that keeps its
 * natural width, and a header that stays sticky while the body scrolls.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'src/renderer/pages/UnifiedDatabase.jsx'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles/app.css'), 'utf8');

/** Returns the declaration block of a selector, or '' when it is absent. */
function rule(selector) {
  // Anchored at a line start so ".unified-database-table table.data thead th"
  // never satisfies a lookup for the shorter shared selector.
  const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`).exec(css);
  if (!match) return '';
  const start = match.index + match[0].length;
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

test('the comprehensive database table scrolls on both axes', () => {
  assert.match(page, /className="table-wrap unified-database-table"/, 'the table uses the scrolling wrapper');
  assert.doesNotMatch(page, /table-wrap[^>]*maxHeight/, 'the height comes from the stylesheet, not an inline cap');

  const wrapper = rule('.unified-database-table');
  assert.match(wrapper, /overflow:\s*auto/, 'the wrapper is the scroll container');
  assert.match(wrapper, /max-height:\s*\d/, 'the wrapper caps the height so the page itself does not grow');

  const table = rule('.unified-database-table table.data');
  assert.match(table, /width:\s*max-content/, 'columns keep their natural width instead of squeezing');
  assert.match(table, /min-width:\s*100%/, 'a narrow table still fills the card');
});

test('the header stays visible while the wide table scrolls', () => {
  const th = rule('.unified-database-table table.data thead th');
  assert.match(th, /white-space:\s*nowrap/, 'header labels do not wrap');
  assert.match(th, /background:/, 'the sticky header hides the rows passing underneath');
  assert.match(rule('table.data thead th'), /position:\s*sticky/, 'the shared header rule is still sticky');
});

test('long cell text is truncated instead of widening the table', () => {
  const td = rule('.unified-database-table table.data tbody td');
  assert.match(td, /white-space:\s*nowrap/);
  assert.match(td, /text-overflow:\s*ellipsis/);
  assert.match(td, /max-width:\s*\d+px/);
});
