'use strict';
// inject-context-reference.js — injects/updates a pointer block into a target
// repo's AI instruction file(s), pointing at the ICM skill and .context/.
//
// Ported from generate_project_context.js's buildContextBlock /
// injectContextReference / updateAiInstructionFiles (that script has been
// retired — see README.md). Only buildContextBlock's text content changed;
// the sentinel-replace/insert/create logic is unchanged.
const fs = require('node:fs');
const path = require('node:path');

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

const CONTEXT_SENTINEL_START = '<!-- context-generator: start -->';
const CONTEXT_SENTINEL_END = '<!-- context-generator: end -->';
// CLAUDE.md and AGENTS.md are always ensured (created if missing, injected if
// present) — AGENTS.md specifically because it's an increasingly vendor-
// neutral convention many agents beyond Claude Code check for by default, so
// always having it maximizes which agents actually see the pointer.
// .claude/CLAUDE.md and GEMINI.md are tool-specific opt-ins: only touched if
// the target repo already uses them, never created from scratch.
const ALWAYS_ENSURED_FILES = ['CLAUDE.md', 'AGENTS.md'];
const INJECT_IF_EXISTS_FILES = ['.claude/CLAUDE.md', 'GEMINI.md'];
// The full set this module can touch, in original priority order — kept for
// anything that wants to introspect "every file this module knows about."
const AI_INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

function buildContextBlock(contextDir, skillPath) {
  return [
    CONTEXT_SENTINEL_START,
    '## Project Context (ICM)',
    '',
    `\`${contextDir}/\` is the source of truth for this codebase's structure, stack,`,
    `data model, and interfaces — read \`${contextDir}/CONTEXT.md\` first; it routes`,
    'you to the stage relevant to your task.',
    '',
    `Read and follow \`${skillPath}/SKILL.md\` for how to use and maintain \`${contextDir}/\`.`,
    '',
    '**If this is the first time you (any agent) are reading this file in a',
    `session:** tell the human \`${contextDir}/\` and this skill are available,`,
    `before doing anything else. If \`${contextDir}/stages/*/output/\` is empty`,
    'or missing, explicitly ask whether to run stage `01_overview` now, in this',
    "session, to set it up (see the skill's CONTEXT.md) — don't just silently",
    'skip it and don\'t silently run it unasked either.',
    '',
    '**Finishing any task:** if your change affects a stage\'s documented content',
    '(schema/migration → `03_data`, new routes/services → `04_interfaces`,',
    'new module/directory → `02_architecture`, etc.), update that stage\'s',
    '`output/` as part of finishing the task — not as a separate step.',
    '',
    `This file is a disposable, regenerable pointer (see .gitignore) — \`${contextDir}/\``,
    'is the actual source of truth. If you ever find yourself in this repo',
    `without a file like this one, but \`${contextDir}/\` exists, treat it as`,
    'authoritative anyway and recreate this pointer for whichever agent you are.',
    CONTEXT_SENTINEL_END,
  ].join('\n');
}

function injectContextReference(filePath, contextDir, skillPath) {
  const block = buildContextBlock(contextDir, skillPath);
  const existing = readText(filePath);

  if (existing === null) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, block + '\n');
    return 'created';
  }

  // Replace existing sentinel block in-place
  if (existing.includes(CONTEXT_SENTINEL_START)) {
    const updated = existing.replace(
      new RegExp(`${CONTEXT_SENTINEL_START}[\\s\\S]*?${CONTEXT_SENTINEL_END}`),
      block,
    );
    if (updated === existing) return 'unchanged';
    fs.writeFileSync(filePath, updated);
    return 'updated';
  }

  // Insert after the first H1 heading (and any blank lines that follow it),
  // or prepend to the file if there is no H1.
  const lines = existing.split(/\r?\n/);
  const h1Idx = lines.findIndex((l) => /^# /.test(l));
  let insertAt = 0;
  if (h1Idx !== -1) {
    insertAt = h1Idx + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
  }
  lines.splice(insertAt, 0, '', block, '');
  fs.writeFileSync(filePath, lines.join('\n'));
  return 'injected';
}

function updateAiInstructionFiles(root, contextDir, skillPath) {
  const results = [];

  // CLAUDE.md and AGENTS.md: always ensured, created from scratch if missing.
  for (const rel of ALWAYS_ENSURED_FILES) {
    const abs = path.join(root, rel);
    const result = injectContextReference(abs, contextDir, skillPath);
    results.push({ rel, result });
  }

  // .claude/CLAUDE.md and GEMINI.md: tool-specific, only touched if already present.
  for (const rel of INJECT_IF_EXISTS_FILES) {
    const abs = path.join(root, rel);
    if (!exists(abs)) continue;
    const result = injectContextReference(abs, contextDir, skillPath);
    results.push({ rel, result });
  }

  return results;
}

module.exports = {
  CONTEXT_SENTINEL_START,
  CONTEXT_SENTINEL_END,
  AI_INSTRUCTION_FILES,
  ALWAYS_ENSURED_FILES,
  INJECT_IF_EXISTS_FILES,
  buildContextBlock,
  injectContextReference,
  updateAiInstructionFiles,
};
