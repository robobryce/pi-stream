// Tests for the --stream wrapper: flag parsing, swallowed-prompt recovery, and
// child argv construction (prompt dedup, flag stripping, passthrough).
import assert from "node:assert/strict";
import { test } from "node:test";
import { flagOn, swallowedPrompt, buildChildArgs } from "../src/extension.ts";

test("flagOn treats boolean/truthy strings as on", () => {
	assert.equal(flagOn(true), true);
	assert.equal(flagOn("true"), true);
	assert.equal(flagOn("1"), true);
	assert.equal(flagOn(false), false);
	assert.equal(flagOn("false"), false);
	assert.equal(flagOn("0"), false);
	assert.equal(flagOn(""), false);
	assert.equal(flagOn(undefined), false);
});

test("swallowedPrompt detects flag-first swallow only", () => {
	assert.equal(swallowedPrompt(["--stream", "my prompt"]), "my prompt");
	assert.equal(swallowedPrompt(["--model", "x", "--stream", "hello world"]), "hello world");
	// recommended / safe forms: no swallow
	assert.equal(swallowedPrompt(["-p", "prompt", "--stream", "--model", "x"]), undefined);
	assert.equal(swallowedPrompt(["--stream"]), undefined);
	assert.equal(swallowedPrompt(["--stream=true", "prompt"]), undefined);
	assert.equal(swallowedPrompt(["-p", "prompt", "--model", "x"]), undefined);
});

test("buildChildArgs: prompt-first form → --mode json -p, no duplicate prompt", () => {
	// pi -p "PROMPT" --stream --model M  (event.text = PROMPT, swallowed = undefined)
	const argv = ["-p", "PROMPT", "--stream", "--model", "M"];
	const out = buildChildArgs(argv, "PROMPT", undefined);
	assert.deepEqual(out, ["--mode", "json", "-p", "PROMPT", "--model", "M"]);
	// prompt appears exactly once
	assert.equal(out.filter((a) => a === "PROMPT").length, 1);
	assert.ok(!out.includes("--stream"));
});

test("buildChildArgs: flag-first swallow → drops the swallowed value, single prompt", () => {
	// pi --stream "PROMPT" --model M  (swallowed = PROMPT)
	const argv = ["--stream", "PROMPT", "--model", "M"];
	const out = buildChildArgs(argv, "PROMPT", "PROMPT");
	assert.deepEqual(out, ["--mode", "json", "-p", "PROMPT", "--model", "M"]);
	assert.equal(out.filter((a) => a === "PROMPT").length, 1);
});

test("buildChildArgs: strips an existing --mode and -p/--print", () => {
	const argv = ["--mode", "json", "-p", "PROMPT", "--stream", "--provider", "nvidia-hub"];
	const out = buildChildArgs(argv, "PROMPT", undefined);
	assert.deepEqual(out, ["--mode", "json", "-p", "PROMPT", "--provider", "nvidia-hub"]);
	// exactly one --mode
	assert.equal(out.filter((a) => a === "--mode").length, 1);
});

test("buildChildArgs: passes through -e / arbitrary flags", () => {
	const argv = ["-p", "PROMPT", "--stream", "-e", "/path/ext.ts", "--no-extensions"];
	const out = buildChildArgs(argv, "PROMPT", undefined);
	assert.ok(out.includes("-e") && out.includes("/path/ext.ts") && out.includes("--no-extensions"));
});

// Note: runChild's error-exit + child-kill are integration behaviors verified
// live (forced-error → nonzero exit; SIGTERM → child killed via process signal
// handlers). They aren't unit-tested here because they require a real subprocess
// and signal delivery; buildChildArgs/flagOn/swallowedPrompt above cover the
// pure logic.
