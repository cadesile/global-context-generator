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
  assert.strictEqual(d.primaryLang, 'node');
  assert.strictEqual(d.primaryExt, 'ts');
  assert.strictEqual(d.sourceDir, 'src');
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
