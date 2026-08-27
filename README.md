# pi-ask-user-question

Structured user prompts for the [pi coding agent](https://github.com/earendil-works/pi): an
`ask_user_question` tool letting the LLM ask multiple-choice questions mid-task instead of guessing, plus a
runtime gate that asks before external or destructive shell commands. Both share one dialog. The schema is compatible
with Claude Code's `AskUserQuestion` tool (1–4 questions, 2–4 labeled+described options each, optional
`multiSelect`, an automatic "Other" free-text entry). In the TUI, all questions for a call are shown in one
tabbed dialog with back/forward navigation; non-TUI dialog-capable sessions (RPC) fall back to Pi's
built-in `ctx.ui.select`/`ctx.ui.input` dialogs, asked one question at a time.

## Install

```
pi install git:github.com/96tommykim/pi-ask-user-question
```

## Example

TUI, more than one question — one tabbed dialog, ■/□ marking answered/unanswered questions:

```
┌─────────────────────────────────────┐
│ ← ■ Auth │ □ DB │ □ Deploy →        │
│                                     │
│ Which auth method should we use?    │
│ ❯ JWT — token-based                 │
│   Session — server-side session     │
│   Other (type your own answer)      │
│                                     │
│ ←→ switch question · ↑↓ move ·      │
│ enter select · esc cancel           │
└─────────────────────────────────────┘
```

A single question skips the tab bar; a multiSelect question shows checkboxes and swaps the hint to
`space toggle · enter confirm`.

## Behavior notes

- **Tabbed TUI dialog**: in the TUI, every question for a call is shown in one persistent custom dialog.
  ←/→ (or Tab/Shift+Tab) switch questions, wrapping around; each question keeps its own cursor and
  selection when you navigate away and back. The dialog uses a bounded viewport sized from the terminal:
  it keeps the selected option or Other editor cursor visible after navigation and resize, and shows ↑/↓
  indicators when wrapped content is outside the viewport and space permits. Answering a question (or confirming a multiSelect one)
  automatically advances to the next *unanswered* question. Once every question is answered, the dialog
  resolves and the call completes. Esc cancels the whole call — except while typing an "Other" answer,
  where it only backs out of that text input (see below); Ctrl+C always cancels the whole call, including
  while typing. This replaced an earlier design that reopened `ctx.ui.select` on every keystroke/toggle,
  which flickered the screen and reset the cursor to the top each time.
- **RPC fallback**: non-TUI dialog-capable sessions (no custom components available) fall back to asking
  each question sequentially with `ctx.ui.select`/`ctx.ui.input` — a multiSelect question there is a toggle
  loop that reopens the dialog per toggle, with a "✓ Done" row to finish.
- **Other entry**: every question gets a free-text "Other" choice for free, so the model should not add its
  own "Other" option. In the TUI dialog, selecting/confirming Other opens an inline text editor. Submitting
  non-blank text records the answer and advances. Esc, or submitting it blank, does *not* finalize anything:
  it just closes the editor and returns to the option list. For multiSelect this also drops "Other" back out
  of the selection and marks the question unanswered until re-confirmed with enter; for single-select any
  previously recorded answer is kept as-is. In the RPC fallback,
  dismissing the Other input (Esc) aborts the whole call, and a blank submit only means "skip" for
  multiSelect — for a single-select question there a blank answer also aborts the call.
- **Re-answering a multiSelect question**: toggling a checkbox (or dropping "Other" via Esc/blank as above)
  on a question that's already answered clears that answer and its ■ chip back to □ — the new selection
  isn't submitted until you press enter again to re-confirm.
- **multiSelect with nothing selected**: if no options end up selected and there is no Other text, the
  answer is the literal string `(no options selected)` rather than an empty string.
- **Cancel / Escape**: dismissing a dialog aborts the whole tool call with an error result telling the model
  the user dismissed the question.
- **Collision-safe rendering** (RPC fallback's option lists): if a model-supplied option happens to render
  identically to another option, or to the built-in "Other"/"Done" entries, duplicate entries get a
  disambiguating " (2)", " (3)", … suffix so the built-in entries can never be hijacked by a same-looking
  option.
- **Input validation**: before any UI opens, runtime input is checked independently of the schema. Questions
  need non-empty question text and headers, and 2–4 options with non-empty labels; descriptions may be empty.
  Terminal control characters (including ANSI/APC escapes) are rejected in every rendered field. Oversized
  question and option arrays retain the historical max-four clamp. Malformed values throw a clear tool failure
  rather than reaching the dialog renderer.
- **The tool asks, the gate blocks**: `ask_user_question` is a generic question tool, not a permission
  mechanism. `executionMode: "sequential"` orders that assistant message's tool-call batch but does not
  cancel or conditionally suppress later sibling calls, so an answer never gates a later operation.
  Approval is enforced by the separate runtime gate below instead, which needs nothing sequenced by the
  model. An answer arriving does not require the model to end its turn: it may act on the answer right
  away.
- **Non-interactive sessions**: the tool only requires dialog-capable UI (`ctx.hasUI`, true in both TUI and
  RPC modes). A subagent child (`PI_SUBAGENT_CHILD=1`) always fails first and must escalate to its parent agent
  to request that the parent ask the user. A headless non-subagent fails with guidance to ask the user in plain
  text, instead of hanging on a dialog that can never be shown.

## External-action gate

A `tool_call` handler asks before `bash` runs anything external or destructive, and blocks the call unless
the user picks **Approve once**:

| Gated | Not gated |
|---|---|
| `git push` | `git pull`, `git status`, `git log` |
| `gh pr\|issue\|release` create/edit/merge/close/… | `gh pr list`, `gh pr view` |
| `gh api` with `-X POST\|PUT\|PATCH\|DELETE` or body fields (`-f`, `--field`, `--input`) | `gh api /repos/o/r`, `gh api -X GET` |
| `rm -r`/`-rf`/`--recursive` | `rm file`, `rm -f file` |
| `sudo` | — |

- **The host enforces it, not the model.** The gate runs before the tool executes, whatever the model
  intended. There is no policy to remember, no approval to carry across turns, and no reason for the model
  to stop and wait for another user message after an answer.
- **Approval is per call.** Each matching command opens its own dialog; nothing is remembered. Changing the
  command means a new call, so it asks again.
- **Fail-closed.** A session with no dialog-capable UI (`-p`, JSON mode) and any subagent child
  (`PI_SUBAGENT_CHILD=1`) blocks with guidance to escalate the exact command. A dialog error, an Escape, an
  abort, and a free-text answer all count as *not approved*. Pi additionally treats a throwing `tool_call`
  handler as blocking.
- **Cancel is first**, so the cursor starts on it and a stray enter blocks rather than approves.
- **Commands are flattened before rendering.** Every dialog field rejects terminal control characters,
  which includes the newlines a heredoc or a `\`-continued command carries, so whitespace and control runs
  collapse to single spaces and anything past 1000 characters is elided.
- **Sibling ports.** The same rule set is enforced natively in other harnesses through
  `native/claude/hooks/confirm-external-writes.sh` (Claude Code PreToolUse hook) and
  `native/codex/rules/confirm-external-writes.rules` (Codex execpolicy) in the author's dotfiles. Unlike the
  Codex `prefix_rule` port, these rules can inspect flags, so `gh api` matches only a mutating request.

## Development

```
node --test extensions/ask-user-question/*.test.ts
```

`extensions/ask-user-question/ask.ts`, `gate.ts`, and `viewport.ts` are pure logic with zero imports from
Pi packages or TypeBox, so they run directly under `node --test`. The entry and dialog tests import the
real `index.ts` and `dialog.ts` through small, local Pi/TypeBox/TUI mocks; they cover tool control flow and bounded component
rendering without a real `pi` installation. A manual interactive TUI check remains appropriate for host rendering
and terminal behavior.
