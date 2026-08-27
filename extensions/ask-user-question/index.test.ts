import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { formatOption } from "./ask.ts";
import { APPROVE_LABEL, buildApprovalQuestion, CANCEL_LABEL, matchExternalAction } from "./gate.ts";

const mockTypebox = `data:text/javascript,${encodeURIComponent(`
	export const Type = {
		Object: () => ({}), String: () => ({}), Array: () => ({}), Optional: () => ({}), Boolean: () => ({}),
	};
`)}`;
const mockDialog = `data:text/javascript,${encodeURIComponent(`
	let nextResult = undefined;
	export function setPromptResult(result) { nextResult = result; }
	export async function promptQuestions() { return nextResult; }
`)}`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		const isIndex = context.parentURL.includes("/extensions/ask-user-question/index.ts");
		if (specifier === "typebox" && isIndex) return { shortCircuit: true, url: mockTypebox };
		if (specifier === "./dialog.ts" && isIndex) {
			return { shortCircuit: true, url: mockDialog };
		}
		return nextResolve(specifier, context);
	},
});

const dialog = await import(mockDialog);
let registeredTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
type GateHook = (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;
let registeredHook: GateHook | undefined;
const pi = {
	registerTool(tool: typeof registeredTool) {
		registeredTool = tool;
	},
	on(event: string, handler: GateHook) {
		if (event === "tool_call") registeredHook = handler;
	},
};
const { default: register } = await import(new URL("./index.ts", import.meta.url).href);
register(pi as never);
if (!registeredTool) throw new Error("ask_user_question tool was not registered");
if (!registeredHook) throw new Error("external-action gate was not registered");

const validParams = {
	questions: [
		{
			question: "Continue?",
			header: "Confirm",
			options: [
				{ label: "Yes", description: "Continue" },
				{ label: "No", description: "Stop" },
			],
		},
	],
};

function context(mode: "tui" | "rpc", selected: Array<string | undefined> = [], typed: Array<string | undefined> = []) {
	const selectTitles: string[] = [];
	const signals: unknown[] = [];
	return {
		ctx: {
			hasUI: true,
			mode,
			signal: undefined as AbortSignal | undefined,
			ui: {
				async select(title: string, _items: string[], options: { signal?: unknown }) {
					selectTitles.push(title);
					signals.push(options.signal);
					return selected.shift();
				},
				async input(_title: string, _placeholder: string, options: { signal?: unknown }) {
					signals.push(options.signal);
					return typed.shift();
				},
			},
		},
		selectTitles,
		signals,
	};
}

function execute(params: unknown, ctx: ReturnType<typeof context>["ctx"], signal?: AbortSignal) {
	return registeredTool!.execute("call", params, signal, () => {}, ctx);
}

async function withoutSubagent<T>(run: () => Promise<T>) {
	const prior = process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_CHILD;
	try {
		return await run();
	} finally {
		if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = prior;
	}
}

test("tool execution rejects malformed runtime arguments and terminal-control injection", async () => {
	await assert.rejects(execute({}, context("rpc").ctx), /Invalid ask_user_question input/);
	const escapedQuestion = { ...validParams, questions: [{ ...validParams.questions[0], question: "Continue?\u001b[2J" }] };
	const apcLabel = { ...validParams, questions: [{ ...validParams.questions[0], options: [{ label: "Yes\x1b_pi:c\x07", description: "Continue" }, validParams.questions[0].options[1]] }] };
	await assert.rejects(execute(escapedQuestion, context("rpc").ctx), /question.*terminal control characters/);
	await assert.rejects(execute(apcLabel, context("rpc").ctx), /label.*terminal control characters/);
});

test("tool execution rejects non-interactive and subagent sessions without leaking environment", async () => {
	const nonInteractive = { ...context("rpc").ctx, hasUI: false };
	await withoutSubagent(async () => assert.rejects(execute(validParams, nonInteractive), /Ask the user in plain text/));

	const prior = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		await assert.rejects(execute(validParams, context("rpc").ctx), /Escalate to the parent agent/);
		await assert.rejects(execute(validParams, { ...context("rpc").ctx, hasUI: false }), /Escalate to the parent agent/);
	} finally {
		if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = prior;
	}
	assert.equal(process.env.PI_SUBAGENT_CHILD, prior);
});

test("tool uses the TUI dialog result and turns dialog cancellation into a failure", async (t) => {
	t.after(() => dialog.setPromptResult(undefined));
	await withoutSubagent(async () => {
		dialog.setPromptResult([{ question: "Continue?", answer: "Yes" }]);
		assert.deepEqual(await execute(validParams, context("tui").ctx), {
			content: [{ type: "text", text: 'Your questions have been answered: "Continue?"="Yes"' }],
			details: undefined,
		});

		dialog.setPromptResult(undefined);
		await assert.rejects(execute(validParams, context("tui").ctx), /User dismissed the question/);
	});
});

test("tool completes and cancels the RPC select flow", async () => {
	await withoutSubagent(async () => {
		const successful = context("rpc", ["Yes — Continue"]);
		assert.deepEqual(await execute(validParams, successful.ctx), {
			content: [{ type: "text", text: 'Your questions have been answered: "Continue?"="Yes"' }],
			details: undefined,
		});
		assert.deepEqual(successful.selectTitles, ["Continue? (Confirm)"]);

		await assert.rejects(execute(validParams, context("rpc", [undefined]).ctx), /User dismissed the question/);
	});
});

test("RPC Other and multiSelect flows preserve answers, cancellation, and signals", async () => {
	await withoutSubagent(async () => {
		const controller = new AbortController();
		const singleOther = context("rpc", ["Other (type your own answer)"], ["manual answer"]);
		assert.match((await execute(validParams, singleOther.ctx, controller.signal) as { content: Array<{ text: string }> }).content[0].text, /"Continue\?"="manual answer"/);
		assert.deepEqual(singleOther.signals, [controller.signal, controller.signal]);

		const multiParams = { questions: [{ ...validParams.questions[0], multiSelect: true }] };
		const multiOther = context("rpc", ["[ ] Yes — Continue", "[ ] Other (type your own answer)", "✓ Done"], ["custom"]);
		assert.match((await execute(multiParams, multiOther.ctx) as { content: Array<{ text: string }> }).content[0].text, /"Continue\?"="Yes, custom"/);
		await assert.rejects(execute(validParams, context("rpc", ["Other (type your own answer)"], [undefined]).ctx), /User dismissed the question/);
	});
});

function gate(command: string, ctx: unknown, toolName = "bash") {
	return registeredHook!({ toolName, toolCallId: "call", input: { command } }, ctx);
}

test("gate ignores non-bash tools and commands no rule matches", async () => {
	await withoutSubagent(async () => {
		assert.equal(await gate("git status", context("tui").ctx), undefined);
		assert.equal(await gate("gh pr list", context("tui").ctx), undefined);
		// A gated command reaching a different tool is not this gate's business.
		assert.equal(await gate("git push", context("tui").ctx, "read"), undefined);
	});
});

test("gate approves through the TUI dialog and blocks every other outcome", async (t) => {
	t.after(() => dialog.setPromptResult(undefined));
	await withoutSubagent(async () => {
		dialog.setPromptResult([{ question: "q", answer: APPROVE_LABEL }]);
		assert.equal(await gate("git push origin main", context("tui").ctx), undefined);

		dialog.setPromptResult([{ question: "q", answer: CANCEL_LABEL }]);
		assert.deepEqual(await gate("git push origin main", context("tui").ctx), {
			block: true,
			reason: "Not approved by the user: git push — pushes to a remote repository.",
		});

		// Escape/abort resolves undefined, and free text is never an approval.
		dialog.setPromptResult(undefined);
		assert.equal((await gate("sudo rm -rf /", context("tui").ctx))?.block, true);
		dialog.setPromptResult([{ question: "q", answer: "yes go ahead" }]);
		assert.equal((await gate("git push", context("tui").ctx))?.block, true);
	});
});

test("gate blocks when the session cannot ask", async () => {
	await withoutSubagent(async () => {
		const blocked = await gate("git push", { ...context("tui").ctx, hasUI: false });
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /Escalate the exact command/);
	});

	const prior = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const blocked = await gate("git push", context("tui").ctx);
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /Escalate the exact command/);
	} finally {
		if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = prior;
	}
});

test("gate blocks when the dialog itself fails", async () => {
	await withoutSubagent(async () => {
		const failing = {
			...context("rpc").ctx,
			ui: {
				async select() {
					throw new Error("dialog exploded");
				},
			},
		};
		assert.equal((await gate("git push", failing))?.block, true);
	});
});

test("gate uses the RPC select fallback and passes the turn signal", async () => {
	await withoutSubagent(async () => {
		const rule = matchExternalAction("git push origin main")!;
		const items = buildApprovalQuestion(rule, "git push origin main").options.map(formatOption);
		const controller = new AbortController();

		const approved = context("rpc", [items[1]]);
		approved.ctx.signal = controller.signal;
		assert.equal(await gate("git push origin main", approved.ctx), undefined);
		assert.deepEqual(approved.signals, [controller.signal]);

		assert.equal((await gate("git push origin main", context("rpc", [items[0]]).ctx))?.block, true);
		assert.equal((await gate("git push origin main", context("rpc", [undefined]).ctx))?.block, true);
	});
});
