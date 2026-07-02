// Child harness: loads the real extension, drives it with synthetic events for
// one scenario, and lets it write to real fd 1 (this process's stdout). The
// parent test captures stdout and asserts. Scenario is argv[2] (JSON).
//
// This exercises the production fs.writeSync(1, ...) path against real fd 1 —
// the same channel the harness reserves for stdout — with no LLM.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, "..", "src", "extension.ts"));
const register = mod.default;

const scenario = JSON.parse(process.argv[2] ?? "{}");
const { hasUI = false, mode = "print", flag = true, events = [] } = scenario;

const handlers = new Map();
let lastMessageEndResult;
const pi = {
  registerFlag() {},
  getFlag() { return flag; },
  on(event, handler) { handlers.set(event, handler); },
};
register(pi);
const ctx = { hasUI, mode };

for (const ev of events) {
  const res = handlers.get(ev.type)?.(ev.payload ?? {}, ctx);
  if (ev.type === "message_end") lastMessageEndResult = res;
}

// Emit the message_end result (if any) to fd 2 as JSON so the parent can assert
// suppression without polluting the captured stdout.
if (lastMessageEndResult !== undefined) {
  process.stderr.write("__MSGEND__" + JSON.stringify(lastMessageEndResult) + "\n");
}
