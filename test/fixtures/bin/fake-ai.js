#!/usr/bin/env node
// Minimal stand-in for an AI CLI (`claude -p <prompt>`) used only in tests.
// Branches on the prompt text so different callAi() call sites (06_synthesis
// vs. the knowledge-gaps review) can be tested against distinct canned
// responses. Every response is deliberately contaminated with leaked
// routing/self-talk preamble so tests can assert the generator strips it
// before persisting either kind of output.
const prompt = process.argv[3] || '';
const PREAMBLE = "This is a plain content-generation task (writing a doc summary), not creative feature work or a coding task — no skill applies here.\n\n";

if (/knowledge gap/i.test(prompt)) {
  process.stdout.write(PREAMBLE +
    "## hallOfFamePoints refund handling\n" +
    "**Question:** What happens to Foo's hallOfFamePoints if a refund is issued after points were already awarded?\n" +
    "**Why it matters:** FooController::create persists new Foo records but no code here shows points being reversed.\n"
  );
} else {
  process.stdout.write(PREAMBLE +
    "The FooController handles inbound foo requests. Foo tracks a hall-of-fame point total.\n"
  );
}
