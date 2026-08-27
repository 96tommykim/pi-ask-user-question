import assert from "node:assert/strict";
import { test } from "node:test";
import { hasTerminalControl } from "./ask.ts";
import {
	APPROVE_LABEL,
	buildApprovalQuestion,
	CANCEL_LABEL,
	matchExternalAction,
	MAX_COMMAND_LENGTH,
	sanitizeCommand,
} from "./gate.ts";

function reasonFor(command: string): string | undefined {
	return matchExternalAction(command)?.reason;
}

test("git push is gated, and read-only git is not", () => {
	assert.match(reasonFor("git push") ?? "", /git push/);
	assert.match(reasonFor("git push origin main") ?? "", /git push/);
	assert.match(reasonFor("git push --force-with-lease") ?? "", /git push/);
	assert.match(reasonFor("cd /tmp && git push") ?? "", /git push/);

	assert.equal(matchExternalAction("git pull origin main"), undefined);
	assert.equal(matchExternalAction("git status"), undefined);
	assert.equal(matchExternalAction("git log --oneline"), undefined);
});

test("mutating gh subcommands are gated, read-only ones are not", () => {
	assert.match(reasonFor("gh pr create --title x") ?? "", /gh pr/);
	assert.match(reasonFor("gh pr merge 12") ?? "", /gh pr/);
	assert.match(reasonFor("gh issue close 3") ?? "", /gh issue/);
	assert.match(reasonFor("gh release upload v1 ./dist") ?? "", /gh release/);

	assert.equal(matchExternalAction("gh pr list"), undefined);
	assert.equal(matchExternalAction("gh pr view 12"), undefined);
	assert.equal(matchExternalAction("gh issue list"), undefined);
	assert.equal(matchExternalAction("gh release view v1"), undefined);
});

test("gh api is gated only when the request mutates", () => {
	assert.match(reasonFor("gh api -X POST /repos/o/r/issues") ?? "", /gh api/);
	assert.match(reasonFor("gh api --method=DELETE /repos/o/r/labels/x") ?? "", /gh api/);
	assert.match(reasonFor('gh api -X "PATCH" /repos/o/r') ?? "", /gh api/);
	// pflag accepts the value glued to the shorthand, which still defaults to POST.
	assert.match(reasonFor("gh api /repos/o/r/issues -ftitle=bug") ?? "", /gh api/);
	assert.match(reasonFor("gh api /repos/o/r/issues --field title=bug") ?? "", /gh api/);

	assert.equal(matchExternalAction("gh api /repos/o/r"), undefined);
	assert.equal(matchExternalAction("gh api -X GET /repos/o/r"), undefined);
});

test("recursive rm and sudo are gated, plain rm is not", () => {
	assert.match(reasonFor("rm -rf build") ?? "", /rm -rf/);
	assert.match(reasonFor("rm -fr build") ?? "", /rm -rf/);
	assert.match(reasonFor("rm -r build") ?? "", /rm -rf/);
	assert.match(reasonFor("sudo launchctl stop x") ?? "", /sudo/);
	assert.match(reasonFor("ls && sudo rm x") ?? "", /rm -rf|sudo/);

	assert.equal(matchExternalAction("rm build/app.o"), undefined);
	assert.equal(matchExternalAction("rm -f build/app.o"), undefined);
});

test("a substring of a longer word does not trigger a rule", () => {
	assert.equal(matchExternalAction("echo 'pseudorandom'"), undefined);
	assert.equal(matchExternalAction("./scripts/norm -r x"), undefined);
});

test("sanitizeCommand flattens the control characters the dialog rejects", () => {
	const heredoc = ["gh pr create \\", "  --title 'x' \\", "  --body 'a\tb'"].join("\n");
	const flattened = sanitizeCommand(heredoc);

	assert.equal(hasTerminalControl(flattened), false);
	assert.equal(flattened, "gh pr create \\ --title 'x' \\ --body 'a b'");
});

test("sanitizeCommand elides an oversized command", () => {
	const flattened = sanitizeCommand(`git push ${"x".repeat(MAX_COMMAND_LENGTH * 2)}`);

	assert.equal(flattened.length, MAX_COMMAND_LENGTH);
	assert.ok(flattened.endsWith("…"));
});

test("the approval question is safe-first and renderable", () => {
	const rule = matchExternalAction("git push origin main");
	assert.ok(rule);

	const question = buildApprovalQuestion(rule, "git push origin main\n# trailing");

	assert.equal(hasTerminalControl(question.question), false);
	assert.equal(hasTerminalControl(question.header), false);
	assert.match(question.question, /git push origin main/);
	// Cancel first: the cursor starts on it, so a stray enter blocks.
	assert.deepEqual(
		question.options.map((o) => o.label),
		[CANCEL_LABEL, APPROVE_LABEL],
	);
	assert.equal(question.multiSelect, undefined);
});

test("an all-control command still yields a renderable question", () => {
	const rule = matchExternalAction("git push");
	assert.ok(rule);

	const question = buildApprovalQuestion(rule, "\n\t\n");

	assert.equal(hasTerminalControl(question.question), false);
	assert.match(question.question, /\(empty command\)/);
});
