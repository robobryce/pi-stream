/**
 * pi-stream — a `--stream` CLI flag.
 *
 * `pi --stream "your prompt"` runs the turn non-interactively and streams it as
 * it plays out — thinking deltas, text deltas, and tool activity — as plain
 * text with no TUI and no JSON envelope. It's the flag form of the standalone
 * pi-stream.mjs runner.
 *
 * How it works
 * ------------
 * The flag is only meaningful in a non-interactive run (`ctx.hasUI === false`,
 * i.e. print/json mode — which is also what you get whenever stdout is not a
 * TTY). In interactive mode the TUI already renders the turn, so the flag is a
 * no-op and we leave the terminal alone.
 *
 * When active we render the live stream ourselves from the session event
 * stream. In plain print mode (`ctx.mode === "print"`) the harness would also
 * echo the final assistant text after the turn, which would duplicate what we
 * already streamed; we suppress that echo by clearing the text blocks of the
 * finalized assistant message in `message_end` (the streamed text is the
 * output of record). Runs launched with `--stream` are transient viewing
 * sessions, so trimming the echoed copy from the transcript is the right
 * trade-off; pass `--no-session` if you want nothing written at all.
 *
 * In JSON mode (`ctx.mode === "json"`) the harness emits its own JSON event
 * stream and there is no final text echo, so we stay out of the way entirely.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const FLAG = "stream";

export default function registerStreamExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG, {
		description: "Stream the turn (thinking, text, tool activity) to stdout as plain text; non-interactive only.",
		type: "boolean",
		default: false,
	});

	// Resolved once the session context is known. Streaming is only enabled for
	// a non-interactive run with the flag set.
	let active = false;
	// Whether the harness will echo the final assistant text after the turn
	// (plain print/text mode only) — if so we suppress it to avoid duplication.
	let suppressFinalEcho = false;
	let inThinking = false;
	let wroteAnything = false;

	const out = (s: string) => {
		process.stdout.write(s);
		wroteAnything = true;
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		active = pi.getFlag(FLAG) === true && !ctx.hasUI;
		// hasUI is false for both print and json modes; only plain print ("print")
		// echoes the final text that we need to suppress. json mode emits its own
		// event stream and does no text echo, so leave it alone.
		suppressFinalEcho = active && ctx.mode === "print";
		inThinking = false;
		wroteAnything = false;
	});

	pi.on("message_update", (event) => {
		if (!active) return;
		const e = event.assistantMessageEvent;
		switch (e.type) {
			case "thinking_start":
				inThinking = true;
				out(`\n${DIM}── thinking ──\n`);
				break;
			case "thinking_delta":
				out(e.delta);
				break;
			case "thinking_end":
				out(`${RESET}\n`);
				inThinking = false;
				break;
			case "text_start":
				if (inThinking) {
					out(RESET);
					inThinking = false;
				}
				out("\n");
				break;
			case "text_delta":
				out(e.delta);
				break;
			default:
				break;
		}
	});

	pi.on("tool_execution_start", (event) => {
		if (!active) return;
		if (inThinking) {
			out(RESET);
			inThinking = false;
		}
		let args = "";
		try {
			args = JSON.stringify(event.args);
		} catch {
			args = "<unserializable args>";
		}
		out(`\n${CYAN}→ ${event.toolName}(${args})${RESET}\n`);
	});

	pi.on("tool_execution_end", (event) => {
		if (!active) return;
		out(`${CYAN}← ${event.toolName} done${event.isError ? " (error)" : ""}${RESET}\n`);
	});

	// Suppress the harness's post-turn echo of the final assistant text in plain
	// print mode: strip text blocks from the finalized message so print mode has
	// nothing to re-emit. We already streamed that text live. Non-text content
	// (tool calls, thinking) is left intact.
	pi.on("message_end", (event) => {
		if (!suppressFinalEcho) return;
		const message = event.message;
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		const content = message.content as Array<{ type: string }>;
		const hasText = content.some((c) => c.type === "text");
		if (!hasText) return;
		// Terminate the streamed line cleanly before the process exits.
		if (wroteAnything) out("\n");
		return {
			message: {
				...message,
				content: content.filter((c) => c.type !== "text") as typeof message.content,
			},
		};
	});
}
