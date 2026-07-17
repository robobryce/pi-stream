# pi-print-stream

A Pi extension that adds a **`--stream`** CLI flag.

```bash
pi -p "your prompt here" --stream
```

Runs the turn non-interactively and streams it as it plays out — thinking
deltas, text deltas, and tool activity — as plain text, with no TUI and no JSON
envelope.

## How it works — a wrapper over `pi --mode json -p`

`--stream` does **not** drive the turn itself. It intercepts the prompt and
spawns a child `pi --mode json -p "<prompt>"` (inheriting your model/flags),
pretty-prints the child's JSON event stream, and returns `handled` so Pi's own
turn doesn't also run. The child uses Pi's real print-mode path, so prompt
handling, the retry loop (429/5xx/empty/transient), and compaction are exactly
what a normal `pi -p` run gets — no reimplemented (and subtly broken) turn
lifecycle inside the extension.

## Usage

```bash
pi -p "explain this repo" --stream      # recommended
pi --stream "explain this repo"         # also works (prompt recovered from argv)
echo "explain this repo" | pi --stream  # piped stdin
pi -p "..." --stream | less -R           # keep ANSI colors in a pager
```

## Install

```bash
pi install npm:pi-print-stream
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
