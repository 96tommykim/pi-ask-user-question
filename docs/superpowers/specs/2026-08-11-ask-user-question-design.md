# pi-ask-user-question — Design

Date: 2026-08-11
Status: approved (conversation with Thomas, 2026-08-11)

## Purpose

Provide an `ask_user_question` tool for the [pi coding agent](https://github.com/earendil-works/pi)
so the LLM can ask the user structured multiple-choice questions mid-task, with
full schema compatibility with Claude Code's `AskUserQuestion` tool:

- 1–4 questions per call
- 2–4 options per question, each with `label` + `description`
- optional `multiSelect` per question
- an automatic "Other" free-text entry per question

## Distribution

Same pattern as `pi-response-viewer`:

- Standalone git repo at `github.com/96tommykim/pi-ask-user-question`
- Installed with `pi install git:github.com/96tommykim/pi-ask-user-question`
- Registered in dotfiles `native/pi/setup-extensions.sh` via `ensure_pi_package`
  and documented in `native/pi/README.md`

Git installs are discovered through Pi's `extensions/<name>/index.ts`
convention — no `package.json` needed, no npm dependencies (TypeBox and the Pi
types are provided by the host).

## Package layout

```
pi-ask-user-question/
├── extensions/
│   └── ask-user-question/
│       ├── index.ts       # entry: export default (pi: ExtensionAPI) → pi.registerTool(...)
│       ├── ask.ts         # pure logic: option formatting, multiSelect toggling, answer assembly
│       └── ask.test.ts    # node:test unit tests for ask.ts (no Pi imports)
├── docs/superpowers/specs/…this file…
├── README.md
├── LICENSE                # MIT
└── .gitignore
```

## Tool definition

`pi.registerTool()` with a TypeBox schema:

```
questions: Array 1–4 of {
  question:    string
  header:      string (short chip label, ~12 chars)
  options:     Array 2–4 of { label: string, description: string }
  multiSelect: optional boolean
}
```

## UI flow (Pi built-in dialogs only — no custom components)

Questions are asked sequentially.

Single-select:

```
┌ Question text (Header) ─────────────┐
│ ❯ Label A — description A          │
│   Label B — description B          │
│   Other (type your own answer)     │
└─────────────────────────────────────┘
```

`ctx.ui.select(title, items)`. Choosing "Other" opens `ctx.ui.input`.

multiSelect (repeated `ctx.ui.select` as a toggle loop):

```
┌ Question text (2 selected) ─────────┐
│ ❯ [x] Label A — description A      │
│   [ ] Label B — description B      │
│   [x] Label C — description C      │
│   [ ] Other (type your own answer) │
│   ✓ Done                           │
└─────────────────────────────────────┘
```

Selecting an item toggles it and re-opens the dialog; `✓ Done` finishes.
If "Other" is toggled on, `ctx.ui.input` is prompted after Done.

## Result format

Mirrors Claude Code's phrasing so models already know how to consume it:

```
Your questions have been answered: "<question>"="<label or free text>", …
```

multiSelect answers are comma-joined labels.

## Edge cases

- **Non-interactive session** (subagent child, `--print`/RPC): if
  `ctx.mode !== "tui"` or `PI_SUBAGENT_CHILD=1` or `ctx.ui` is unavailable,
  return an `isError` result telling the model the session is non-interactive
  and to proceed with its best judgment (or ask in plain text).
- **Cancel / ESC** (`select`/`input` resolve `undefined`): abort the whole tool
  call with an `isError` "User dismissed the question" result.
- **Schema violations**: TypeBox enforces min/max; runtime additionally clamps
  (max 4 questions, max 4 options) and proceeds.

## Verification

- `node --test extensions/ask-user-question/ask.test.ts` (pure logic)
- Smoke test of the non-interactive path: `pi -e extensions/ask-user-question/index.ts -p "…"`
- Manual interactive check in a real pi TUI session after install
