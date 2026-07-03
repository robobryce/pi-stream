// Deterministic render test: spawn the child harness, which drives the REAL
// renderer (makeRenderer) with synthetic JSON events and writes to real fd 1.
// The parent captures stdout and asserts the rendered output. This is the same
// render path the --stream wrapper uses on the child `pi --mode json -p` JSON
// stream. No LLM, no subprocess pi. (Flag parsing + wrapper behavior are covered
// in wrapper.test.mjs; the interactive no-op is enforced by the ctx.hasUI guard
// in the real handlers.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, "harness-child.mjs");

function run(scenario) {
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", child, JSON.stringify(scenario)],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (res.status !== 0) throw new Error(`child harness failed (status ${res.status}): ${res.stderr}`);
  return res.stdout;
}

test("renders thinking, text, and tool activity (real fd 1)", () => {
  const out = run({
    flag: true,
    events: [
      { type: "message_update", payload: { assistantMessageEvent: { type: "thinking_start" } } },
      { type: "message_update", payload: { assistantMessageEvent: { type: "thinking_delta", delta: "hmm 2+2" } } },
      { type: "message_update", payload: { assistantMessageEvent: { type: "thinking_end" } } },
      { type: "message_update", payload: { assistantMessageEvent: { type: "text_start" } } },
      { type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", delta: "Four" } } },
      { type: "tool_execution_start", payload: { toolName: "read", args: { path: "/x" } } },
      { type: "tool_execution_end", payload: { toolName: "read", isError: false } },
    ],
  });
  assert.match(out, /── thinking ──/);
  assert.match(out, /hmm 2\+2/);
  assert.match(out, /Four/);
  assert.match(out, /→ read\(\{"path":"\/x"\}\)/);
  assert.match(out, /← read done/);
});

test("marks tool errors", () => {
  const out = run({
    flag: true,
    events: [
      { type: "tool_execution_start", payload: { toolName: "bash", args: { command: "x" } } },
      { type: "tool_execution_end", payload: { toolName: "bash", isError: true } },
    ],
  });
  assert.match(out, /← bash done \(error\)/);
});

test("renders nothing when the flag is off (wrapper wouldn't spawn/render)", () => {
  const out = run({
    flag: false,
    events: [{ type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", delta: "should NOT appear" } } }],
  });
  assert.equal(out.trim(), "");
});
