// Child harness: drives the REAL renderer (makeRenderer) with synthetic JSON
// events for one scenario, letting it write to real fd 1 (this process's
// stdout). The parent test captures stdout and asserts. This exercises the
// production fs.writeSync(1, ...) render path — the same one the --stream
// wrapper uses on the child's JSON stream — with no LLM and no subprocess.
//
// Scenario events use the flat JSON-line shape the child emits, e.g.
//   { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }
//   { type: "tool_execution_start", toolName: "bash", args: {...} }
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, "..", "src", "extension.ts"));
const { makeRenderer } = mod;

const scenario = process.argv[3] === "--file"
	? JSON.parse(fs.readFileSync(process.argv[2], "utf-8"))
	: JSON.parse(process.argv[2] ?? "{}");
const { flag = true, events = [] } = scenario;

// When the flag is off, the wrapper renders nothing — model this by not
// rendering at all (the wrapper simply wouldn't spawn/render).
// Accept both the flat JSON-line shape ({ type, assistantMessageEvent }) and the
// legacy nested shape ({ type, payload: {...} }); flatten the latter. Non-render
// events (session_start, message_end) are ignored by the renderer.
function normalize(ev) {
	if (ev && ev.payload && typeof ev.payload === "object") return { type: ev.type, ...ev.payload };
	return ev;
}

if (flag) {
	const renderer = makeRenderer();
	for (const ev of events) renderer.event(normalize(ev));
	renderer.finish();
}
