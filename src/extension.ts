/**
 * pi-print-stream — a `--stream` CLI flag that streams a non-interactive turn to
 * stdout as plain text (thinking, text, and tool activity), no TUI, no JSON.
 *
 * Architecture: WRAPPER over `pi --mode json -p`
 * ----------------------------------------------
 * `--stream` does not drive the turn itself. Instead, on the `input` event (in a
 * non-interactive run with the flag on) it intercepts the prompt, spawns a child
 * `pi --mode json -p "<prompt>"` inheriting the same model/flags, pretty-prints
 * the child's JSON event stream, and returns `action: "handled"` so Pi's own
 * turn does not also run. The child uses Pi's real print-mode path — so prompt
 * handling, the retry loop (429/5xx/empty/transient), compaction, and everything
 * else are exactly what a normal `pi -p` run gets. This avoids reimplementing
 * (and subtly breaking) the turn lifecycle inside an extension.
 *
 * The JSON events the child emits (`message_update` with an
 * `assistantMessageEvent`, `tool_execution_start/end`) are the same events an
 * in-process extension would see; we render them identically.
 *
 * Invocation
 * ----------
 *   pi -p "your prompt" --stream          ← recommended
 *   pi --stream "your prompt"             ← also works (we recover the prompt
 *                                            Pi's arg parser swallowed into the
 *                                            flag value)
 *   echo "your prompt" | pi --stream      ← piped stdin
 *
 * Active only in a non-interactive run (`!ctx.hasUI`). In interactive mode the
 * TUI renders the turn, so the flag is a no-op.
 */

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const FLAG = "stream";
/** Set on the spawned child so it renders normally instead of re-wrapping. */
const CHILD_GUARD = "PI_STREAM_WRAPPER_CHILD";

/** Whether --stream is on. Boolean flag; tolerate stringy truthy values. */
export function flagOn(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		return v !== "" && v !== "false" && v !== "0" && v !== "no";
	}
	return false;
}

/**
 * If Pi's arg parser swallowed the prompt into `--stream`'s value
 * (`pi --stream "prompt"` — the parser runs before extensions and doesn't know
 * `--stream` is boolean, so it eats the following bare word), return that word.
 * Recommended forms don't match: `--stream` followed by a flag, `--stream=...`,
 * or end-of-args. Returns undefined when nothing was swallowed.
 */
export function swallowedPrompt(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === `--${FLAG}`) {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) return next;
			return undefined;
		}
		if (tok.startsWith(`--${FLAG}=`)) return undefined;
	}
	return undefined;
}

/**
 * Build the child `pi --mode json -p <prompt>` argv from the parent's argv.
 * Passes through everything except: the prompt (supplied explicitly), --stream
 * (and its swallowed value), and any -p/--print/--mode (we set --mode json -p).
 *
 * `prompt` is the resolved prompt; `swallowed` is the value Pi's parser attached
 * to --stream (dropped so it isn't also passed through as a positional).
 */
export function buildChildArgs(
	argv: readonly string[],
	prompt: string,
	swallowed: string | undefined,
): string[] {
	const passthrough: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === `--${FLAG}`) {
			// Drop --stream and, if present, its swallowed bare-word value.
			if (swallowed !== undefined && argv[i + 1] === swallowed) i++;
			continue;
		}
		if (a.startsWith(`--${FLAG}=`)) continue;
		if (a === "-p" || a === "--print") continue;
		if (a === "--mode") { i++; continue; } // drop "--mode <value>"
		if (a.startsWith("--mode=")) continue;
		// Drop the bare prompt positional (we pass the prompt explicitly).
		if (a === prompt) continue;
		passthrough.push(a);
	}
	return ["--mode", "json", "-p", prompt, ...passthrough];
}

/** One shared renderer for the JSON event stream (child) or in-child fallback. */
export function makeRenderer() {
	let inThinking = false;
	const out = (s: string) => {
		try { fs.writeSync(1, s); } catch { process.stdout.write(s); }
	};
	const endThinking = () => { if (inThinking) { out(RESET); inThinking = false; } };
	return {
		/** Render one parsed JSON event from the child stream. */
		event(ev: { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; toolName?: string; args?: unknown; isError?: boolean }) {
			if (ev.type === "message_update") {
				const e = ev.assistantMessageEvent;
				switch (e?.type) {
					case "thinking_start": inThinking = true; out(`\n${DIM}── thinking ──\n`); break;
					case "thinking_delta": out(e.delta ?? ""); break;
					case "thinking_end": out(`${RESET}\n`); inThinking = false; break;
					case "text_start": endThinking(); out("\n"); break;
					case "text_delta": out(e.delta ?? ""); break;
				}
			} else if (ev.type === "tool_execution_start") {
				endThinking();
				let args = "";
				try { args = JSON.stringify(ev.args); } catch { args = "<unserializable args>"; }
				out(`\n${CYAN}→ ${ev.toolName}(${args})${RESET}\n`);
			} else if (ev.type === "tool_execution_end") {
				out(`${CYAN}← ${ev.toolName} done${ev.isError ? " (error)" : ""}${RESET}\n`);
			}
		},
		finish() { endThinking(); out("\n"); },
	};
}

/**
 * Spawn `pi --mode json -p <prompt>` and pretty-print its JSON stream. Resolves
 * with the child's exit code. Uses this process's own node+cli entry so it
 * doesn't depend on `pi` being on PATH.
 */
function runChild(childArgs: string[]): Promise<number> {
	return new Promise((resolve) => {
		const nodeBin = process.execPath;
		const cli = process.argv[1];
		const [cmd, args] = cli ? [nodeBin, [cli, ...childArgs]] : ["pi", childArgs];
		const child = spawn(cmd, args, {
			env: { ...process.env, [CHILD_GUARD]: "1" },
			stdio: ["ignore", "pipe", "inherit"],
		});

		// Kill the child if we're signalled, so a Ctrl-C / terminated parent never
		// leaves an orphaned `pi --mode json -p` running.
		const killChild = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
		const onSig = (sig: NodeJS.Signals) => { killChild(); process.exitCode = 130; process.off(sig, onSig as never); };
		process.once("SIGINT", onSig);
		process.once("SIGTERM", onSig);
		process.once("exit", killChild);

		// `pi --mode json -p` exits 0 even when the turn ends in an error, so we
		// track a final assistant error in the JSON stream and surface it as a
		// non-zero exit (matching `pi -p` text-mode semantics).
		let sawError = false;
		const renderer = makeRenderer();
		const rl = readline.createInterface({ input: child.stdout! });
		rl.on("line", (line) => {
			if (!line.trim()) return;
			let ev: { type?: string; message?: { role?: string; stopReason?: string } } | undefined;
			try { ev = JSON.parse(line); } catch { return; }
			if (ev?.type === "message_end" && ev.message?.role === "assistant") {
				sawError = ev.message.stopReason === "error";
			}
			renderer.event(ev as never);
		});
		const cleanup = () => {
			process.off("SIGINT", onSig as never);
			process.off("SIGTERM", onSig as never);
			process.off("exit", killChild);
		};
		child.on("close", (code) => {
			renderer.finish();
			cleanup();
			resolve(code && code !== 0 ? code : (sawError ? 1 : 0));
		});
		child.on("error", () => { cleanup(); resolve(1); });
	});
}

export default function registerStreamExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG, {
		description: "Stream the turn (thinking, text, tool activity) to stdout as plain text; non-interactive only. Wraps `pi --mode json -p`.",
		type: "boolean",
		default: false,
	});

	// Guard so the prompt is streamed once: the `input` path handles the normal
	// case; the `session_start` path handles the flag-first swallow case where no
	// `input` event ever fires. Whichever runs first claims the turn.
	let handled = false;

	const wrap = async (prompt: string, swallowed: string | undefined): Promise<void> => {
		handled = true;
		const childArgs = buildChildArgs(process.argv.slice(2), prompt, swallowed);
		const code = await runChild(childArgs);
		if (code !== 0) process.exitCode = code;
	};

	pi.on("input", async (event: { text: string }, ctx: ExtensionContext) => {
		if (process.env[CHILD_GUARD] || handled) return undefined;
		if (ctx.hasUI) return undefined;
		if (!flagOn(pi.getFlag(FLAG))) return undefined;

		const swallowed = swallowedPrompt(process.argv.slice(2));
		const prompt = (event.text && event.text.trim().length > 0) ? event.text : (swallowed ?? "");
		if (!prompt.trim()) return undefined; // nothing to run; let Pi handle it

		await wrap(prompt, swallowed);
		return { action: "handled" }; // Pi must not also run this turn
	});

	// Flag-first fallback: `pi --stream "prompt"` — Pi's arg parser swallows the
	// prompt into --stream's value, so print mode gets no initial message and no
	// `input` event ever fires. Recover the prompt from argv and drive the child
	// here. session_start handlers are awaited in print mode, so the child runs
	// to completion before the (promptless) parent turn would exit.
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (process.env[CHILD_GUARD] || handled) return;
		if (ctx.hasUI) return;
		if (!flagOn(pi.getFlag(FLAG))) return;
		if (ctx.mode !== "print") return; // only the print path lacks the input event

		const swallowed = swallowedPrompt(process.argv.slice(2));
		if (swallowed === undefined || !swallowed.trim()) return; // prompt not swallowed → input path handles it
		await wrap(swallowed, swallowed);
	});
}
