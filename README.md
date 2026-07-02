# pi-stream

A Pi extension that adds a **`--stream`** CLI flag.

```bash
pi --stream "your prompt here"
```

Runs the turn non-interactively and streams it as it plays out — thinking
deltas, text deltas, and tool activity — as plain text, with no TUI and no JSON
envelope. It's the flag form of the standalone `pi-stream.mjs` runner.

## Install

```bash
pi install git:github.com/robobryce/pi-stream
```

or, for local development:

```bash
pi -e ./src/extension.ts --stream "your prompt"
```

## What you get

```
$ pi --stream "What is 2+2? Think first."

── thinking ──
The user wants 2+2. That's basic arithmetic: 4.

The answer is 4.
```

Tool calls are shown inline as they run:

```
→ read({"path":"/etc/hostname"})
← read done
```

## Behavior notes

- **Non-interactive only.** The flag is active when there's no TUI — i.e. print
  mode (`-p`, or any run where stdout is not a TTY, such as a pipe or script).
  In interactive mode the TUI already renders the turn, so `--stream` is a
  no-op and the terminal is left untouched.
- **No duplicated output.** In plain print mode Pi normally echoes the final
  assistant text after the turn. Since `--stream` already streamed that text
  live, the extension strips the text blocks from the finalized message so it
  isn't printed twice. Tool calls and thinking in the transcript are left
  intact. Pass `--no-session` if you don't want the (text-trimmed) transcript
  persisted at all.
- **JSON mode is untouched.** Under `--mode json` Pi emits its own machine
  event stream and does no text echo, so `--stream` stays out of the way.

## Colors

Thinking is dimmed, tool activity is cyan, answer text is default. Colors are
ANSI escapes; pipe through a pager with `-R` (e.g. `less -R`) to preserve them,
or they'll degrade gracefully to plain text in most capture contexts.

## License

MIT
