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
/** Max recovery retries when the swallowed-prompt turn fails empty/transient. */
const RECOVERY_MAX_RETRIES = 3;
const RECOVERY_BASE_DELAY_MS = 2000;

interface TurnMessage {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string | null;
	errorMessage?: string | null;
	usage?: { totalTokens?: number; output?: number };
}

/**
 * Whether a recovered turn should be retried: an empty response, or a transient
 * (retryable) error. This matters specifically for the swallowed-prompt path,
 * which drives the turn via sendUserMessage from session_start and therefore
 * does NOT go through Pi's normal print-mode retry loop — so a 429/5xx or empty
 * response on that turn would otherwise end the run silently.
 */
export function shouldRetryRecoveredTurn(msg: TurnMessage | undefined): boolean {
	if (!msg || msg.role !== "assistant") return false;
	const content = Array.isArray(msg.content) ? msg.content : [];
	const hasToolCall = content.some((c) => c.type === "toolCall" || c.type === "tool_use");
	const hasText = content.some((c) => c.type === "text" && (c.text ?? "").trim().length > 0);

	if (msg.stopReason === "error") {
		const err = msg.errorMessage ?? "";
		// Permanent errors (auth, quota/billing, bad request) must not be retried.
		if (/invalid.?api.?key|unauthorized|authentication|permission denied|insufficient_quota|quota exceeded|billing|available balance|monthly usage limit|invalid.?request|400 |401 |403 |404 /i.test(err)) {
			return false;
		}
		return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|status code/i.test(err);
	}
	// Empty turn: clean stop but no tool call, no text, zero output tokens.
	if (msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== null) return false;
	if (hasToolCall || hasText) return false;
	const usage = msg.usage;
	return !usage || (usage.totalTokens ?? 0) === 0 || (usage.output ?? 0) === 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		active = flagOn(pi.getFlag(FLAG)) && !ctx.hasUI;
		suppressFinalEcho = active && ctx.mode === "print";
		inThinking = false;
		wroteAnything = false;

		// Recover a swallowed prompt. When invoked flag-first (`pi --stream "prompt"`),
		// Pi's arg parser — which runs before extensions and doesn't know --stream is
		// boolean — consumes the following bare word as the flag's value, so print
		// mode gets NO prompt and exits immediately with no output. The eaten word is
		// still in argv, so we recover it, inject it as the user message, and await
		// the turn here (session_start handlers are awaited in print mode) so the
		// process doesn't tear down before the turn we started completes. This makes
		// the flag-first form Just Work instead of silently doing nothing.
		if (active && ctx.mode === "print") {
			const eaten = swallowedPrompt(process.argv.slice(2));
			if (eaten !== undefined) {
				try {
					// Drive the recovered turn and retry it if it comes back empty or
					// with a transient error. This path bypasses Pi's normal print-mode
					// retry loop (we drive via sendUserMessage from session_start), so a
					// 429/5xx/empty here would otherwise end the run silently. Awaiting
					// the whole loop keeps print mode alive until we get a clean turn.
					for (let attempt = 0; attempt <= RECOVERY_MAX_RETRIES; attempt++) {
						let last: TurnMessage | undefined;
						const turnDone = new Promise<void>((resolve) => {
							const off = pi.on("agent_end", (ev: { messages?: TurnMessage[] }) => {
								const msgs = ev.messages ?? [];
								for (let i = msgs.length - 1; i >= 0; i--) {
									if (msgs[i]?.role === "assistant") { last = msgs[i]; break; }
								}
								try { off?.(); } catch { /* ignore */ }
								resolve();
							});
						});
						if (attempt === 0) {
							await pi.sendUserMessage(eaten, {});
						} else {
							await pi.sendMessage(
								{ customType: "stream-recover-retry", content: "The previous attempt failed (empty or transient error). Retry and complete the task.", display: false },
								{ triggerTurn: true, deliverAs: "followUp" },
							);
						}
						await turnDone;
						if (!shouldRetryRecoveredTurn(last)) break;
						if (attempt < RECOVERY_MAX_RETRIES) await sleep(RECOVERY_BASE_DELAY_MS * 2 ** attempt);
					}
				} catch {
					// If injection fails, fall back to a usage hint so the run isn't silent.
					out(
						`${DIM}pi-stream: \`--stream\` consumed "${eaten}" as its value and could not recover it.\n` +
						`Put the prompt BEFORE the flag: pi -p "${eaten}" --stream${RESET}\n`,
					);
				}
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
