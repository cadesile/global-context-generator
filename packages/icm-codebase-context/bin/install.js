#!/usr/bin/env node
'use strict';
// install.js — scaffolds the icm-codebase-context skill into a target repo.
//
// Pure file-copy scaffolding. No AI calls, no subprocess to any AI CLI.
// The actual .context/ content gets written later, by a live agent session
// following the installed skill (see skill/SKILL.md) — that's "warming."
const fs = require('node:fs');
const path = require('node:path');
const { updateAiInstructionFiles } = require('../lib/inject-context-reference');
const { updateGitignore } = require('../lib/agent-gitignore');

const CONTEXT_DIR = '.context';
const SKILL_DIR_REL = '.agents/skills/icm-codebase-context';
const STAGE_NAMES = [
  '01_overview',
  '02_architecture',
  '03_data',
  '04_interfaces',
  '05_ui',
  '06_documentation',
  '07_synthesis',
];

function parseArgs(argv) {
  const target = argv[2] || '.';
  return { target: path.resolve(target) };
}

function copySkill(target) {
  const src = path.join(__dirname, '..', 'skill');
  const dest = path.join(target, SKILL_DIR_REL);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function scaffoldContextSkeleton(target) {
  const contextRoot = path.join(target, CONTEXT_DIR);
  const created = [];

  if (!fs.existsSync(contextRoot)) {
    fs.mkdirSync(contextRoot, { recursive: true });
  }

  const routerPath = path.join(contextRoot, 'CONTEXT.md');
  if (!fs.existsSync(routerPath)) {
    fs.writeFileSync(
      routerPath,
      [
        '# Project Context',
        '',
        'No stages have run yet. See',
        `\`${SKILL_DIR_REL}/SKILL.md\` for how to build this out — the first`,
        'agent session to work in this repo should run stage `01_overview` now.',
        '',
      ].join('\n'),
    );
    created.push(routerPath);
  }

  for (const stage of STAGE_NAMES) {
    const stageDir = path.join(contextRoot, 'stages', stage);
    if (!fs.existsSync(stageDir)) {
      fs.mkdirSync(stageDir, { recursive: true });
      created.push(stageDir);
    }
  }

  return { contextRoot, created };
}

function main() {
  const { target } = parseArgs(process.argv);

  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    process.stderr.write(`✗ Target directory does not exist: ${target}\n`);
    process.exitCode = 1;
    return;
  }

  const skillDest = copySkill(target);
  const { created } = scaffoldContextSkeleton(target);
  const results = updateAiInstructionFiles(target, CONTEXT_DIR, SKILL_DIR_REL);
  const gitignoreResult = updateGitignore(target);

  process.stdout.write(`✓ Installed skill at ${path.relative(target, skillDest)}\n`);
  if (created.length) {
    process.stdout.write(`✓ Created ${CONTEXT_DIR}/ skeleton (${created.length} paths)\n`);
  } else {
    process.stdout.write(`✓ ${CONTEXT_DIR}/ already exists — left existing content alone\n`);
  }
  for (const { rel, result } of results) {
    process.stdout.write(`✓ ${rel}: ${result}\n`);
  }
  process.stdout.write(`✓ .gitignore: ${gitignoreResult}\n`);
  process.stdout.write(
    '\nOpen an agent session in this repo now — the injected pointer tells it\n' +
    'to read the skill and run stage 01_overview if .context/ is still empty.\n',
  );
}

main();
