'use strict';
// agent-gitignore.js — adds a managed block to the target repo's .gitignore
// covering agent-specific local/instruction files. `.context/` is the master,
// committed source of truth; these per-agent files are thin, disposable
// pointers to it (see inject-context-reference.js) and don't need to be
// tracked — anyone can regenerate their own by re-running the installer, or
// by an agent noticing .context/ exists and recreating its own pointer file.
const fs = require('node:fs');
const path = require('node:path');

function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

const GITIGNORE_SENTINEL_START = '# icm-codebase-context: start';
const GITIGNORE_SENTINEL_END = '# icm-codebase-context: end';

// Per-agent sections. Claude Code, the AGENTS.md convention (Codex and
// others), and Gemini CLI are the ones this package actively manages via
// inject-context-reference.js, so their entries are confirmed correct.
// Cursor/Copilot/Windsurf entries are included on a best-effort basis for
// "all other prominent agents" as requested — file conventions for those
// tools move fast, so double-check if one seems stale for your version.
const AGENT_SECTIONS = [
  {
    heading: 'Claude Code',
    files: ['.claude/settings.local.json', 'CLAUDE.local.md', 'CLAUDE.md'],
  },
  {
    heading: 'AGENTS.md convention (Codex, and others that share it)',
    files: ['AGENTS.md'],
  },
  {
    heading: 'Gemini CLI',
    files: ['.gemini/settings.local.json', 'GEMINI.local.md', 'GEMINI.md'],
  },
  {
    heading: 'GitHub Copilot',
    files: ['.github/copilot-instructions.local.md', '.github/copilot-instructions.md'],
  },
  {
    heading: 'Cursor',
    files: ['.cursor/rules/*.local.mdc', '.cursorrules'],
  },
  {
    heading: 'Windsurf',
    files: ['.windsurf/rules/*.local.md', '.windsurfrules'],
  },
];

function buildGitignoreBlock() {
  const lines = [GITIGNORE_SENTINEL_START, ''];
  for (const { heading, files } of AGENT_SECTIONS) {
    const label = `# ${heading} #`;
    lines.push(label, '#'.repeat(label.length), ...files, '');
  }
  lines.push(
    '# .context/ is the master, committed source of truth — the files above',
    '# are disposable per-agent pointers to it, not tracked here.',
    GITIGNORE_SENTINEL_END,
  );
  return lines.join('\n');
}

function updateGitignore(root) {
  const filePath = path.join(root, '.gitignore');
  const block = buildGitignoreBlock();
  const existing = readText(filePath);

  if (existing === null) {
    fs.writeFileSync(filePath, block + '\n');
    return 'created';
  }

  if (existing.includes(GITIGNORE_SENTINEL_START)) {
    const updated = existing.replace(
      new RegExp(`${GITIGNORE_SENTINEL_START}[\\s\\S]*?${GITIGNORE_SENTINEL_END}`),
      block,
    );
    if (updated === existing) return 'unchanged';
    fs.writeFileSync(filePath, updated);
    return 'updated';
  }

  const sep = existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(filePath, existing + sep + '\n' + block + '\n');
  return 'appended';
}

module.exports = {
  GITIGNORE_SENTINEL_START,
  GITIGNORE_SENTINEL_END,
  AGENT_SECTIONS,
  buildGitignoreBlock,
  updateGitignore,
};
