#!/usr/bin/env node
// Minimal stand-in for an AI CLI (`claude -p <prompt>`) used only in tests.
// Always returns a response contaminated with leaked routing/self-talk
// preamble, so tests can assert the generator strips it before persisting.
process.stdout.write(
  "This is a plain content-generation task (writing a doc summary), not creative feature work or a coding task — no skill applies here.\n\n" +
  "The FooController handles inbound foo requests. Foo tracks a hall-of-fame point total.\n"
);
