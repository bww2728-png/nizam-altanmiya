'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const harness = fs.readFileSync(path.join(root, 'scripts/e2e-analysis.cjs'), 'utf8');
const releaseWorkflow = fs.readFileSync(path.join(root, '../.github/workflows/release.yml'), 'utf8');

test('Electron E2E drives real pointer input and checks the true hit target', () => {
  assert.match(harness, /sendInputEvent\(\{ type: 'mouseMove'/);
  assert.match(harness, /sendInputEvent\(\{ type: 'mouseDown'/);
  assert.match(harness, /sendInputEvent\(\{ type: 'mouseUp'/);
  assert.match(harness, /document\.elementFromPoint/);
  assert.match(harness, /target\.contains\(hit\)/);
  assert.doesNotMatch(harness, /\.click\(\)/);
});

test('Electron E2E records before/after screenshots and per-action traces', () => {
  assert.match(harness, /click-traces/);
  assert.match(harness, /beforeFile/);
  assert.match(harness, /afterFile/);
  assert.match(harness, /12-تتبع-التفاعلات\.json/);
});

test('Electron E2E opens the native file dialog path and verifies the workbook inventory UI', () => {
  assert.match(harness, /dialog\.showOpenDialog = async/);
  assert.match(harness, /اختيار ملف Excel/);
  assert.match(harness, /فحص بنية ملف Excel/);
  assert.match(harness, /inventoryUi\.sheetNames/);
  assert.match(harness, /inventoryUi\.visible/);
  assert.match(harness, /14-فهرس-الأوراق\.png/);
  assert.match(harness, /scrollIntoView\(\{ behavior: 'instant', block: 'start' \}\)/);
});

test('Electron E2E checks keyboard focus visibility', () => {
  assert.match(harness, /keyCode: 'TAB'/);
  assert.match(harness, /:focus-visible/);
});

test('Electron E2E verifies retained observation and quality data through dashboard summaries', () => {
  assert.match(harness, /ملخص قياسات المؤشرات وسجل الجودة/);
  assert.match(harness, /indicatorObservations/);
  assert.match(harness, /dataQualityIssues/);
  assert.doesNotMatch(harness, /clickByText\(window, '\.side-nav \.nav-item', '(?:سجل قياسات المؤشرات|جودة البيانات)'/);
});

test('Release workflow gates every push to main with tests before packaging', () => {
  assert.match(releaseWorkflow, /branches:\s*\[main\]/);
  assert.doesNotMatch(releaseWorkflow, /paths:/);
  const tests = releaseWorkflow.indexOf('name: Unit and integration tests');
  const version = releaseWorkflow.indexOf('name: Compute release version');
  const build = releaseWorkflow.indexOf('name: Build renderer');
  const pack = releaseWorkflow.indexOf('name: Package installer');
  const publish = releaseWorkflow.indexOf('name: Publish release');
  assert.ok(tests >= 0, 'test gate is present');
  assert.ok(version > tests && build > version && pack > build && publish > pack, 'pipeline steps are ordered');
  assert.match(releaseWorkflow, /run: npm test/);
  assert.match(releaseWorkflow, /scripts\/ci-version\.cjs/);
  assert.match(releaseWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(releaseWorkflow, /--publish never/);
});

test('theme toggle persists the preference and exposes accessible light and dark modes', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/App.jsx'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'src/renderer/components/AppShell.jsx'), 'utf8');
  const toggle = fs.readFileSync(path.join(root, 'src/renderer/components/ThemeToggle.jsx'), 'utf8');
  const theme = fs.readFileSync(path.join(root, 'src/renderer/styles/theme.css'), 'utf8');

  assert.match(app, /localStorage\.getItem\('ldi-theme'\)/);
  assert.match(app, /localStorage\.setItem\('ldi-theme', theme\)/);
  assert.match(app, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(shell, /<ThemeToggle theme=\{theme\} onToggle=\{onToggleTheme\} \/>/);
  assert.match(toggle, /aria-label=\{`التبديل إلى \$\{label\}`\}/);
  assert.match(theme, /:root\[data-theme='light'\]/);
});
