// Deterministic test: drive the extension with a fake pi + synthetic events,
// capture stdout, assert streaming render + final-echo suppression.
// No LLM involved.
import assert from "node:assert/strict";
import { test } from "node:test";

// Load the extension via jiti-free strip-types (node runs .ts directly here).
const mod = await import("../src/extension.ts");
const register = mod.default;

function makeHarness({ hasUI, mode, flag }) {
  const handlers = new Map();
  const pi = {
    registerFlag() {},
    getFlag() { return flag; },
    on(event, handler) { handlers.set(event, handler); },
  };
  register(pi);
  const ctx = { hasUI, mode };
  return {
    fire: (event, payload) => handlers.get(event)?.(payload, ctx),
    fireEnd: (event, payload) => handlers.get(event)?.(payload, ctx),
  };
}

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { return fn(), chunks.join(""); }
  finally { process.stdout.write = orig; }
}

test("streams thinking, text, and tool activity in print mode", () => {
  let h;
  const out = captureStdout(() => {
    h = makeHarness({ hasUI: false, mode: "print", flag: true });
    h.fire("session_start", {});
    h.fire("message_update", { assistantMessageEvent: { type: "thinking_start" } });
    h.fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "hmm 2+2" } });
    h.fire("message_update", { assistantMessageEvent: { type: "thinking_end" } });
    h.fire("message_update", { assistantMessageEvent: { type: "text_start" } });
    h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "Four" } });
    h.fire("tool_execution_start", { toolName: "read", args: { path: "/x" } });
    h.fire("tool_execution_end", { toolName: "read", isError: false });
  });
  assert.match(out, /── thinking ──/);
  assert.match(out, /hmm 2\+2/);
  assert.match(out, /Four/);
  assert.match(out, /→ read\(\{"path":"\/x"\}\)/);
  assert.match(out, /← read done/);
});

test("suppresses final text echo in print mode (strips text blocks)", () => {
  let result;
  const h = makeHarness({ hasUI: false, mode: "print", flag: true });
  h.fire("session_start", {});
  captureStdout(() => {
    result = h.fireEnd("message_end", {
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "t" },
        { type: "text", text: "Four" },
      ] },
    });
  });
  assert.ok(result && result.message, "should return a replacement message");
  assert.equal(result.message.role, "assistant", "role preserved");
  assert.deepEqual(result.message.content.map((c) => c.type), ["thinking"], "text block removed, thinking kept");
});

test("does NOT suppress in json mode", () => {
  const h = makeHarness({ hasUI: false, mode: "json", flag: true });
  h.fire("session_start", {});
  const result = h.fireEnd("message_end", {
    message: { role: "assistant", content: [{ type: "text", text: "Four" }] },
  });
  assert.equal(result, undefined, "json mode must not modify the message");
});

test("is a no-op in interactive mode (hasUI true)", () => {
  const out = captureStdout(() => {
    const h = makeHarness({ hasUI: true, mode: "tui", flag: true });
    h.fire("session_start", {});
    h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "should NOT appear" } });
  });
  assert.equal(out, "", "interactive mode must not stream to stdout");
});

test("is a no-op when flag is not set", () => {
  const out = captureStdout(() => {
    const h = makeHarness({ hasUI: false, mode: "print", flag: false });
    h.fire("session_start", {});
    h.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "should NOT appear" } });
  });
  assert.equal(out, "", "no output when --stream absent");
});
