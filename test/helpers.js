'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'generate_project_context.js');

function copyFixture(name) {
  const src = path.join(__dirname, 'fixtures', name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `icm-${name}-`));
  fs.cpSync(src, tmp, { recursive: true });
  return tmp;
}

function runGenerator(cwd, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

module.exports = { copyFixture, runGenerator, SCRIPT };
