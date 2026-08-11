# pi-ask-user-question

An `ask_user_question` tool for the [pi coding agent](https://github.com/earendil-works/pi), letting the LLM
ask the user structured multiple-choice questions mid-task instead of guessing. The schema is compatible
with Claude Code's `AskUserQuestion` tool (1–4 questions, 2–4 labeled+described options each, optional
`multiSelect`, an automatic "Other" free-text entry), but the UI is built entirely from Pi's own
`ctx.ui.select`/`ctx.ui.input` dialogs — no custom rendering.

## Install

```
pi install git:github.com/96tommykim/pi-ask-user-question
```

## Example

Single-select:

```
┌ Which auth method should the API use? (Auth method) ┐
│ ❯ API key — a static key sent in a header           │
│   OAuth2 — full authorization-code flow              │
│   Other (type your own answer)                       │
└────────────────────────────────────────────────────────┘
```

multiSelect (a single persistent dialog in the TUI — arrows move the cursor, space toggles a row, enter confirms):

```
┌ Which endpoints need rate limiting? (2 selected) ────┐
│ ❯ [x] /users — high traffic                          │
│   [ ] /orders — moderate traffic                      │
│   [x] /search — expensive queries                     │
│   [ ] Other (type your own answer)                    │
│                                                         │
│   ↑↓ move · space toggle · enter confirm · esc cancel │
└────────────────────────────────────────────────────────┘
```

## Behavior notes

- **Other entry**: every question gets a free-text "Other" choice for free, so the model should not add
  its own "Other" option — picking it opens a text input dialog. Dismissing that input (Esc) aborts the
  whole call the same as dismissing a select dialog; submitting it blank is only treated as "skip" inside
  the multiSelect flow (see below) — for a single-select question a blank answer also aborts the call.
- **multiSelect dialog**: in the TUI, a multi-select question is shown as one persistent custom dialog —
  ↑/↓ move the cursor, space toggles the row under it (including "Other"), and enter confirms the current
  selection. This keeps a single component alive for the whole question instead of reopening
  `ctx.ui.select` on every toggle, which used to flicker the screen and reset the cursor to the top each
  time. In non-TUI dialog-capable sessions (RPC), where custom components aren't available, it falls back
  to a toggle loop that reopens a `ctx.ui.select` per toggle, with a "✓ Done" row to finish. Either way, if
  "Other" ends up toggled on, a text input is shown afterward: a typed value is appended to the
  comma-joined answer, dismissing the input (Esc) aborts the whole call, and submitting it blank just
  skips the Other answer. If no options end up selected and there is no Other text, the answer is the
  literal string `(no options selected)` rather than an empty string.
- **Cancel / Escape**: dismissing any select dialog aborts the whole tool call with an error result telling
  the model the user dismissed the question.
- **Collision-safe rendering**: if a model-supplied option happens to render identically to another option,
  or to the built-in "Other"/"Done" entries, duplicate entries get a disambiguating " (2)", " (3)", …
  suffix so the built-in entries can never be hijacked by a same-looking option.
- **Non-interactive sessions**: the tool only requires dialog-capable UI (`ctx.hasUI`, true in both TUI and
  RPC modes) and is disabled for subagent children (`PI_SUBAGENT_CHILD=1`). When unavailable, it returns a
  graceful error telling the model to proceed with its best judgment or ask the user in plain text, instead
  of hanging on a dialog that can never be shown.

## Development

```
node --test extensions/ask-user-question/ask.test.ts
```

`extensions/ask-user-question/ask.ts` is pure logic with zero imports from Pi packages or TypeBox, so it
runs directly under `node --test`. `extensions/ask-user-question/index.ts` is the extension entry that
wires that logic into `pi.registerTool`; it relies on the TypeBox and Pi types that the Pi host provides
at runtime, so it isn't smoke-tested outside of a real `pi` installation.
