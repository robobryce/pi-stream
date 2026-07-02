/**
 * pi-stream — a `--stream` CLI flag.
 *
 * `pi -p "your prompt" --stream` runs the turn non-interactively and streams it
 * as it plays out — thinking deltas, text deltas, and tool activity — as plain
 * text with no TUI and no JSON envelope. It's the flag form of the standalone
 * pi-stream.mjs runner.
 *
 * Invocation / flag parsing
 * -------------------------
 * Pi's arg parser runs before extensions load and doesn't know flag types, so a
 * bare `--stream` immediately followed by the prompt greedily consumes it:
 * `pi --stream "hi"` parses as `--stream="hi"` and leaves NO prompt for the
 * turn. So put the prompt BEFORE the flag (or use `=`), e.g.:
 *   pi -p "your prompt" --stream          ← recommended
 *   pi -p --stream=true "your prompt"
 *   pi "your prompt" --stream             ← non-TTY stdout ⇒ print mode
 * If `--stream` swallowed the prompt (flag-first with a space), we can't recover
 * it from an extension, so we print a one-line usage hint instead of running an
 * empty turn.
 *
 * Behavior
 * --------
 * Active only in a non-interactive run (`!ctx.hasUI` — print/json mode, or any
 * run whose stdout is not a TTY). In interactive mode the TUI renders the turn,
 * so the flag is a no-op. When active we render the live stream from the
 * session event stream. In plain print mode the harness also echoes the final
 * assistant text after the turn, duplicating what we streamed, so we strip text
 * blocks from the finalized message in `message_end`. JSON mode emits its own
 * machine stream and does no text echo, so we leave it alone.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const FLAG = "stream";

/**
 * Whether --stream is on. Boolean flag, so normally `true`. Pi's arg parser can
 * also hand a boolean flag a stringy value in some orderings, so accept the
 * common truthy strings too — anything other than an explicit off counts as on.
 */
function flagOn(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		return v !== "" && v !== "false" && v !== "0" && v !== "no";
	}
	return false;
}

/**
 * Detect the flag-first mistake `pi --stream "prompt"`, where Pi's arg parser
 * (which runs before extensions and doesn't know flag types) consumes the bare
 * word after `--stream` and leaves NO prompt for the turn — the process then
 * starts no turn and exits immediately with no output.
 *
 * The tell is in argv: a `--stream` token immediately followed by a non-flag
 * word (the swallowed prompt). The recommended forms don't match: `pi -p
 * "prompt" --stream` has `--stream` followed by another flag (or end of args),
 * and piped stdin puts no prompt after the flag either. Returns the swallowed
 * prompt when detected, else undefined.
 */
export function swallowedPrompt(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === `--${FLAG}`) {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) return next;
			return undefined;
		}
		// `--stream=value` never swallows a following positional.
		if (tok.startsWith(`--${FLAG}=`)) return undefined;
	}
	return undefined;
}

export default function registerStreamExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG, {
		description: "Stream the turn (thinking, text, tool activity) to stdout as plain text; non-interactive only. Put the prompt before the flag: pi -p \"your prompt\" --stream.",
		type: "boolean",
		default: false,
	});

	let active = false;
	let suppressFinalEcho = false;
	let inThinking = false;
	let wroteAnything = false;

	// Write straight to file descriptor 1 (real stdout). In print/json mode the
	// harness takes over `process.stdout.write` and redirects it to stderr,
	// reserving true stdout for its own guarded writer; writing to fd 1 directly
	// bypasses that takeover so our stream lands on real stdout. Shell/pipe
	// redirection is at the fd level, so `pi ... --stream > file` still works.
	const out = (s: string) => {
		try {
			fs.writeSync(1, s);
		} catch {
			// If fd 1 is unavailable (closed/EPIPE), fall back to process.stdout.
			process.stdout.write(s);
		}
		wroteAnything = true;
	};

	const endThinkingIfOpen = () => {
		if (inThinking) {
			out(RESET);
			inThinking = false;
		}
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		active = flagOn(pi.getFlag(FLAG)) && !ctx.hasUI;
		suppressFinalEcho = active && ctx.mode === "print";
		inThinking = false;
		wroteAnything = false;

		// If `--stream` swallowed the prompt (flag-first with a space), the turn has
		// nothing to run and Pi exits immediately with no output. We can't recover
		// the prompt from an extension, but we can turn a silent no-op exit into a
		// one-line usage hint so the mistake is obvious.
		if (active) {
			const eaten = swallowedPrompt(process.argv.slice(2));
			if (eaten !== undefined) {
				out(
					`${DIM}pi-stream: \`--stream\` consumed "${eaten}" as its value, leaving no prompt to run.\n` +
					`Put the prompt BEFORE the flag: pi -p "${eaten}" --stream${RESET}\n`,
				);
			}
		}
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
				endThinkingIfOpen();
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
		endThinkingIfOpen();
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
		if (wroteAnything) out("\n");
		return {
			message: {
				...message,
				content: content.filter((c) => c.type !== "text") as typeof message.content,
			},
		};
	});
}
