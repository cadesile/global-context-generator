'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');

const INSTALL_BIN = path.join(__dirname, '..', 'bin', 'install.js');
const SKILL_SRC = path.join(__dirname, '..', 'skill');

function runInstaller(target) {
  return childProcess.spawnSync(process.execPath, [INSTALL_BIN, target], { encoding: 'utf8' });
}

function mkScratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'icm-install-test-'));
}

function listFilesRecursive(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

test('installer copies the skill byte-for-byte and scaffolds .context/', () => {
  const target = mkScratchDir();
  const r = runInstaller(target);
  assert.equal(r.status, 0, r.stderr);

  const installedSkill = path.join(target, '.agents/skills/icm-codebase-context');
  const srcFiles = listFilesRecursive(SKILL_SRC).map((f) => path.relative(SKILL_SRC, f));
  for (const rel of srcFiles) {
    const srcContent = fs.readFileSync(path.join(SKILL_SRC, rel));
    const destContent = fs.readFileSync(path.join(installedSkill, rel));
    assert.deepEqual(destContent, srcContent, `mismatch for ${rel}`);
  }

  assert.ok(fs.existsSync(path.join(target, '.context/CONTEXT.md')));
  for (const stage of ['01_overview', '02_architecture', '03_data', '04_interfaces', '05_documentation', '06_synthesis']) {
    assert.ok(fs.statSync(path.join(target, '.context/stages', stage)).isDirectory());
  }
});

test('sentinel injection: creates CLAUDE.md when none exists', () => {
  const target = mkScratchDir();
  runInstaller(target);
  const claude = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /context-generator: start/);
  assert.match(claude, /\.context\/CONTEXT\.md/);
  assert.match(claude, /icm-codebase-context\/SKILL\.md/);
});

test('sentinel injection: inserts after H1 in an existing CLAUDE.md with no sentinel', () => {
  const target = mkScratchDir();
  fs.writeFileSync(path.join(target, 'CLAUDE.md'), '# My Project\n\nSome existing notes.\n');
  runInstaller(target);
  const claude = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
  const lines = claude.split('\n');
  assert.equal(lines[0], '# My Project');
  assert.match(claude, /context-generator: start/);
  assert.match(claude, /Some existing notes\./);
});

test('sentinel injection: replaces a stale sentinel block in place on a second run', () => {
  const target = mkScratchDir();
  runInstaller(target);
  const before = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
  const staleContent = before.replace('Project Context (ICM)', 'STALE BLOCK');
  fs.writeFileSync(path.join(target, 'CLAUDE.md'), staleContent);

  runInstaller(target);
  const after = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(after, /STALE BLOCK/);
  assert.match(after, /Project Context \(ICM\)/);
  // exactly one sentinel block, not duplicated
  assert.equal(after.split('context-generator: start').length - 1, 1);
});

test('running twice on an unchanged CLAUDE.md is a no-op the second time', () => {
  const target = mkScratchDir();
  runInstaller(target);
  const first = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
  runInstaller(target);
  const second = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
  assert.equal(first, second);
});

test('fails cleanly on a missing target directory', () => {
  const r = runInstaller(path.join(os.tmpdir(), 'icm-install-test-does-not-exist'));
  assert.notEqual(r.status, 0);
});

test('.gitignore: creates a managed block ignoring agent pointer/local files, not .context/', () => {
  const target = mkScratchDir();
  runInstaller(target);
  const gitignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gitignore, /icm-codebase-context: start/);
  assert.match(gitignore, /^CLAUDE\.md$/m);
  assert.match(gitignore, /^CLAUDE\.local\.md$/m);
  assert.match(gitignore, /^\.claude\/settings\.local\.json$/m);
  assert.match(gitignore, /^AGENTS\.md$/m);
  assert.match(gitignore, /^GEMINI\.md$/m);
  assert.doesNotMatch(gitignore, /^\.context\/$/m);
  assert.doesNotMatch(gitignore, /^\.agents\//m);
});

test('.gitignore: appends the managed block to an existing file without touching its content', () => {
  const target = mkScratchDir();
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.DS_Store\n');
  runInstaller(target);
  const gitignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gitignore, /^node_modules\/$/m);
  assert.match(gitignore, /^\.DS_Store$/m);
  assert.match(gitignore, /icm-codebase-context: start/);
});

test('.gitignore: replaces a stale managed block in place on a second run, not duplicated', () => {
  const target = mkScratchDir();
  runInstaller(target);
  const before = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  fs.writeFileSync(path.join(target, '.gitignore'), before.replace('CLAUDE.md', 'STALE.md'));

  runInstaller(target);
  const after = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.doesNotMatch(after, /STALE\.md/);
  assert.match(after, /^CLAUDE\.md$/m);
  assert.equal(after.split('icm-codebase-context: start').length - 1, 1);
});
