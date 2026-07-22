// test/detection.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../generate_project_context.js');
const { copyFixture } = require('./helpers.js');

test('detects expo/node stack', () => {
  const root = copyFixture('expo-app');
  const d = g.detectStack(root);
  assert.strictEqual(d.stacks.node, true);
  assert.strictEqual(d.stacks.expo, true);
  assert.strictEqual(d.primaryLang, 'node');
  assert.strictEqual(d.primaryFramework, 'expo', 'a real expo dependency must surface a specific "expo" framework, not a bare "node" fallback');
  assert.strictEqual(d.primaryExt, 'ts');
  assert.strictEqual(d.sourceDir, 'src');
  const v = g.extractVersions(root, '.', d);
  assert.match(v.frameworkVersion, /^51/, 'frameworkVersion should come from the expo dependency version');
});

test('bare node with no expo/react-native/next/express dependency still falls back to "node"', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-bare-node-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
  const d = g.detectStack(tmp);
  assert.strictEqual(d.stacks.expo, false);
  assert.strictEqual(d.primaryFramework, 'node');
});

test('detects react-native (without the expo package itself) as the expo/RN framework', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-rn-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '^0.74.0' } }));
  const d = g.detectStack(tmp);
  assert.strictEqual(d.stacks.expo, true);
  assert.strictEqual(d.primaryFramework, 'expo');
});

test('detects laravel stack with dirs', () => {
  const root = copyFixture('laravel-app');
  const d = g.detectStack(root);
  assert.strictEqual(d.stacks.laravel, true);
  assert.strictEqual(d.primaryFramework, 'laravel');
  assert.strictEqual(d.modelsDir, 'app/Models');
  assert.strictEqual(d.controllersDir, 'app/Http/Controllers');
  const v = g.extractVersions(root, '.', d);
  assert.strictEqual(v.phpVersion, '8.2');
  assert.match(v.frameworkVersion, /11/);
});

test('detectDatabases finds sqlite hint in expo fixture', () => {
  const root = copyFixture('expo-app');
  assert.match(g.detectDatabases(root, '.'), /SQLite/);
});

test('unknown stack yields unknown lang', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-empty-'));
  const d = g.detectStack(tmp);
  assert.strictEqual(d.primaryLang, 'unknown');
});

test('laravel extractors: migrations and eloquent models', () => {
  const root = copyFixture('laravel-app');
  const d = g.detectStack(root);
  const ctx = { root, appDir: '.', detection: d, ignoreFn: g.createIgnoreMatcher({ root, contextDir: '.context' }), treeDepth: 3, dbHints: '', versions: {} };
  const labels = g.sectionLabels(d, 'MySQL');
  assert.strictEqual(labels.entities, 'laravel Entity Definitions');
});

test('envBlock prefers app subdir .env over root .env.example', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icm-env-'));
  fs.mkdirSync(path.join(tmp, 'app'));
  fs.writeFileSync(path.join(tmp, 'app/.env'), 'APP_SECRET=hidden\n');
  fs.writeFileSync(path.join(tmp, '.env.example'), 'ROOT_VAR=example\n');
  const out = g.envBlock({ root: tmp, appDir: 'app' });
  assert.match(out, /APP_SECRET=\*\*\*/);
  assert.ok(!out.includes('ROOT_VAR'));
});
