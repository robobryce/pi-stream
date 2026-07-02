# pi-stream

A Pi extension that adds a **`--stream`** CLI flag.

```bash
pi -p "your prompt here" --stream
```

Runs the turn non-interactively and streams it as it plays out — thinking
deltas, text deltas, and tool activity — as plain text, with no TUI and no JSON
envelope. It's the flag form of the standalone `pi-stream.mjs` runner.

## Usage — put the prompt BEFORE the flag

```bash
pi -p "your prompt here" --stream      # recommended
```

Pi's argument parser runs before extensions load and treats `--stream` followed
by a bare word as taking that word for its value, so `pi --stream "your prompt"`
would swallow the prompt and leave the turn with nothing to do. Put the prompt
first (or pipe it) and it always works:

```bash
pi -p "explain this repo" --stream
echo "explain this repo" | pi --stream         # stdin ⇒ print mode
pi -p "..." --stream | less -R                 # keep ANSI colors in a pager
```

## Install

```bash
pi install git:github.com/robobryce/pi-stream
```

or, for local development:

```bash
pi -e ./src/extension.ts -p "your prompt" --stream
```

## What you get

```
$ pi -p "What is 2+2? Think first." --stream

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
