// Deterministic integration test: spawn a child that loads the REAL extension,
// drives it with synthetic session events, and lets it write to real fd 1. The
// parent captures the child's stdout and asserts the streamed render + the
// final-echo suppression (reported on fd 2). No LLM involved, and it exercises
// the production fs.writeSync(1, ...) path against a real stdout fd.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, "harness-child.mjs");

// Run the child harness for one scenario; return its real-fd-1 stdout and the
// fd-2 message_end result marker (if any).
function runScenario(scenario) {
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", child, JSON.stringify(scenario)],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (res.status !== 0) {
    throw new Error(`child harness failed (status ${res.status}): ${res.stderr}`);
  }
  const marker = /__MSGEND__(.*)/.exec(res.stderr || "");
  return { stdout: res.stdout, messageEnd: marker ? JSON.parse(marker[1]) : undefined };
}

function run(scenario) {
  return runScenario(scenario).stdout;
}

test("streams thinking, text, and tool activity in print mode (real fd 1)", () => {
  const out = run({
    hasUI: false, mode: "print", flag: true,
    events: [
      { type: "session_start" },
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

test("is a no-op in interactive mode (hasUI true)", () => {
  const out = run({
    hasUI: true, mode: "tui", flag: true,
    events: [
      { type: "session_start" },
      { type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", delta: "should NOT appear" } } },
    ],
  });
  assert.equal(out, "", "interactive mode must not stream to stdout");
});

test("is a no-op when flag is not set", () => {
  const out = run({
    hasUI: false, mode: "print", flag: false,
    events: [
      { type: "session_start" },
      { type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", delta: "should NOT appear" } } },
    ],
  });
  assert.equal(out, "", "no output when --stream absent");
});

test("activates for stringy-truthy flag values, not for off values", () => {
  for (const flag of [true, "true", "1"]) {
    const out = run({
      hasUI: false, mode: "print", flag,
      events: [
        { type: "session_start" },
        { type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", delta: "hi" } } },
      ],
    });
    assert.match(out, /hi/, `flag ${JSON.stringify(flag)} should stream`);
  }
  for (const flag of [false, "false", "0", "no"]) {
    const out = run({
      hasUI: false, mode: "print", flag,
      events: [
        { type: "session_start" },
        { type: "message_update", payload: { assistantMessageEvent: { type: "text_delta", delta: "hi" } } },
      ],
    });
    assert.equal(out, "", `flag ${JSON.stringify(flag)} should not stream`);
  }
});

test("suppresses final text echo in print mode (strips text blocks, keeps others)", () => {
  const { messageEnd } = runScenario({
    hasUI: false, mode: "print", flag: true,
    events: [
      { type: "session_start" },
      { type: "message_end", payload: { message: { role: "assistant", content: [
        { type: "thinking", thinking: "t" },
        { type: "text", text: "Four" },
        { type: "toolCall", id: "1", name: "read", arguments: {} },
      ] } } },
    ],
  });
  assert.ok(messageEnd && messageEnd.message, "should return a replacement message");
  assert.equal(messageEnd.message.role, "assistant", "role preserved");
  assert.deepEqual(messageEnd.message.content.map((c) => c.type), ["thinking", "toolCall"], "text stripped, others kept");
});

test("does NOT suppress final echo in json mode", () => {
  const { messageEnd } = runScenario({
    hasUI: false, mode: "json", flag: true,
    events: [
      { type: "session_start" },
      { type: "message_end", payload: { message: { role: "assistant", content: [{ type: "text", text: "Four" }] } } },
    ],
  });
  assert.equal(messageEnd, undefined, "json mode must not modify the message");
});
