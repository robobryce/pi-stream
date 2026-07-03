// Unit test for swallowedPrompt: detect the flag-first case `pi --stream
// "prompt"` where Pi's arg parser eats the prompt as the flag value. The
// extension uses this to RECOVER the swallowed prompt (re-inject it and run the
// turn) instead of exiting immediately with no output. This pins the detection
// that gates that recovery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { swallowedPrompt } from "../src/extension.ts";

test("detects the swallowed prompt when --stream is followed by a bare word", () => {
  assert.equal(swallowedPrompt(["--stream", "Say READY"]), "Say READY");
  assert.equal(
    swallowedPrompt(["--stream", "explain this repo", "--model", "x"]),
    "explain this repo",
  );
});

test("no false positive for the recommended forms", () => {
  // pi -p "prompt" --stream  → --stream followed by a flag
  assert.equal(swallowedPrompt(["-p", "prompt", "--stream", "--model", "x"]), undefined);
  // --stream at end of args (piped stdin)
  assert.equal(swallowedPrompt(["--stream", "--model", "x"]), undefined);
  assert.equal(swallowedPrompt(["--stream"]), undefined);
  // explicit value form never swallows a positional
  assert.equal(swallowedPrompt(["--stream=true", "prompt"]), undefined);
});

test("no --stream present → undefined", () => {
  assert.equal(swallowedPrompt(["-p", "prompt", "--model", "x"]), undefined);
  assert.equal(swallowedPrompt([]), undefined);
});

test("handles --stream anywhere in argv", () => {
  assert.equal(swallowedPrompt(["--model", "x", "--stream", "my prompt"]), "my prompt");
});

test("recovers a realistic skill-invocation prompt (the reported failure)", () => {
  const prompt = "/essays:essay workers=3 rounds=5 words=300 output-dir=/tmp/run-6";
  assert.equal(swallowedPrompt(["--stream", prompt, "--model", "nemotron"]), prompt);
});
