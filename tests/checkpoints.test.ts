import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import checkpointExtension, { bashTargets, ensureShadowRepo, isWritingCommand, repoRoot, snapshot, targetForPath } from "../extensions/git-checkpoint.ts";
import treeExtension, { checkpointRefIsSafe } from "../extensions/tree-graph.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-graph-test-"));
const makeRepo = (dir: string) => {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	git(dir, "config", "user.name", "Fixture");
	git(dir, "config", "user.email", "fixture@example.invalid");
	fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
	fs.writeFileSync(path.join(dir, "file.txt"), "initial\n");
	git(dir, "add", ".gitignore", "file.txt");
	git(dir, "commit", "-qm", "initial");
};

export default async function () {
	try {
		const a = path.join(temp, "a", "same");
		const b = path.join(temp, "b", "same");
		const outside = path.join(temp, "outside");
		makeRepo(a);
		makeRepo(b);
		fs.mkdirSync(outside);
		fs.mkdirSync(path.join(a, "sub"));
		assert.equal(repoRoot(path.join(a, "sub")), fs.realpathSync(a));
		assert.equal(repoRoot(outside), null);
		assert.equal(targetForPath(path.join(outside, "file")), null);
		assert.equal(targetForPath(path.join(a, "not-yet-created", "nested", "file"))?.worktree, fs.realpathSync(a));
		const link = path.join(a, "linked-file");
		fs.symlinkSync(path.join(b, "file.txt"), link);
		assert.equal(targetForPath(link)?.worktree, fs.realpathSync(b), "file symlinks resolve to the destination repository");

		const ta = ensureShadowRepo(a);
		const tb = ensureShadowRepo(b);
		assert.notEqual(ta.gitDir, tb.gitDir, "same-named roots use unique shadows");
		const originalIndex = fs.readFileSync(path.join(a, ".git", "index"));
		fs.writeFileSync(path.join(a, "file.txt"), "before-write\n");
		fs.writeFileSync(path.join(a, ".env"), "fixture-secret-not-printed\n");
		fs.mkdirSync(path.join(a, "node_modules"), { recursive: true });
		fs.writeFileSync(path.join(a, "node_modules", "excluded"), "x");
		fs.mkdirSync(path.join(a, "build"), { recursive: true });
		fs.writeFileSync(path.join(a, "build", "excluded"), "x");
		const savedIndexEnv = process.env.GIT_INDEX_FILE;
		process.env.GIT_INDEX_FILE = path.join(a, ".git", "index");
		let writeBefore: string | null;
		try { writeBefore = snapshot(ta, "before write"); }
		finally {
			if (savedIndexEnv === undefined) delete process.env.GIT_INDEX_FILE;
			else process.env.GIT_INDEX_FILE = savedIndexEnv;
		}
		if (!writeBefore) throw new Error("expected a pre-write snapshot");
		assert.equal(checkpointRefIsSafe({ label: a, worktree: a, gitDir: ta.gitDir, hash: writeBefore }), true);
		assert.equal(checkpointRefIsSafe({ label: a, worktree: a, gitDir: null, hash: writeBefore }), false, "legacy real-worktree refs cannot restore into user repositories");
		assert.deepEqual(fs.readFileSync(path.join(a, ".git", "index")), originalIndex);
		const names = execFileSync("git", ["--git-dir", ta.gitDir!, "ls-tree", "-r", "--name-only", writeBefore], { encoding: "utf8" });
		assert.match(names, /\.env/);
		assert.match(names, /file\.txt/);
		assert.doesNotMatch(names, /node_modules|build/);
		const secret = execFileSync("git", ["--git-dir", ta.gitDir!, "--work-tree", a, "show", `${writeBefore}:.env`], { encoding: "utf8" });
		assert.equal(secret.length > 0, true); // Do not log fixture secret.
		fs.writeFileSync(path.join(a, "file.txt"), "after-write\n");
		git(a, "--git-dir", ta.gitDir!, "--work-tree", a, "checkout", writeBefore, "--", "file.txt");
		assert.equal(fs.readFileSync(path.join(a, "file.txt"), "utf8"), "before-write\n", "shadow snapshot restores content");
		assert.deepEqual(fs.readFileSync(path.join(a, ".git", "index")), originalIndex, "shadow operations never touch the user's index");
		assert.equal(fs.statSync(path.dirname(ta.gitDir!)).mode & 0o077, 0, "checkpoint directory is private");

		assert.equal(isWritingCommand("printf x>out"), true);
		assert.equal(isWritingCommand("echo x >>out"), true);
		assert.equal(isWritingCommand("git status"), false);
		assert.equal(isWritingCommand("git -C ../b/same checkout -- file.txt"), true);
		assert.ok(bashTargets(`echo x>${path.join(b, "file.txt")}`, a).some((t) => t.worktree === fs.realpathSync(b)));
		assert.ok(bashTargets("cd ../../b/same && echo x>file.txt", a).some((t) => t.worktree === fs.realpathSync(b)));
		assert.ok(bashTargets("git -C ../../b/same checkout -- file.txt", a).some((t) => t.worktree === fs.realpathSync(b)));
		assert.ok(bashTargets(`cp local ${path.join(b, "file.txt")}`, a).some((t) => t.worktree === fs.realpathSync(b)));

		const handlers: Record<string, (...args: any[]) => any> = {};
		const refs: unknown[] = [];
		const commands: string[] = [];
		const mockApi = {
			on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
			registerCommand: (name: string) => commands.push(name), appendEntry: (_type: string, data: unknown) => refs.push(data),
		};
		checkpointExtension(mockApi as unknown as ExtensionAPI);
		treeExtension({ on: () => {}, registerCommand: (name: string) => commands.push(name) } as unknown as ExtensionAPI);
		assert.ok(commands.includes("tg"), "tree-graph package module loads");
		const ctx = (cwd: string) => ({ cwd, ui: { setStatus: () => {}, notify: () => {} } });
		await handlers.session_start({}, ctx(path.join(a, "sub")));
		fs.writeFileSync(path.join(a, "file.txt"), "pre-write-hook\n");
		const beforeCount = refs.length;
		await handlers.tool_call({ toolName: "write", input: { path: path.join(a, "file.txt") } }, ctx(a));
		assert.ok(refs.length > beforeCount, "write hook records a before-write snapshot");
		const hookRef = refs[refs.length - 1] as { hash: string };
		assert.equal(git(a, "--git-dir", ta.gitDir!, "--work-tree", a, "show", `${hookRef.hash}:file.txt`), "pre-write-hook");

		fs.writeFileSync(path.join(b, "file.txt"), "pre-bash-hook\n");
		const nestedCommand = `printf after-bash > ${path.join(b, "file.txt")}`;
		await handlers.tool_call({ toolName: "bash", parentToolCallId: "codemode/1", input: { command: nestedCommand } }, ctx(a));
		assert.ok(refs.length > beforeCount + 1, "nested codemode bash is preflighted");
		const nestedRef = refs[refs.length - 1] as { hash: string };
		assert.equal(git(b, "--git-dir", tb.gitDir!, "--work-tree", b, "show", `${nestedRef.hash}:file.txt`), "pre-bash-hook");
		execFileSync("bash", ["-c", nestedCommand]);
		fs.writeFileSync(path.join(b, "file.txt"), "pre-user-bash\n");
		const userCommand = `printf after-user-bash > ${path.join(b, "file.txt")}`;
		await handlers.user_bash({ command: userCommand, cwd: a });
		assert.ok(refs.length > beforeCount + 2, "manual ! bash is preflighted");
		const userRef = refs[refs.length - 1] as { hash: string };
		assert.equal(git(b, "--git-dir", tb.gitDir!, "--work-tree", b, "show", `${userRef.hash}:file.txt`), "pre-user-bash");
		execFileSync("bash", ["-c", userCommand]);

		const failRepo = path.join(temp, "failure");
		makeRepo(failRepo);
		const id = createHash("sha256").update(fs.realpathSync(failRepo)).digest("hex");
		const broken = path.join(os.homedir(), ".pi", "agent", "checkpoints", id);
		fs.mkdirSync(broken, { recursive: true });
		git(broken, "init", "-q");
		fs.writeFileSync(path.join(broken, "pi-checkpoint-worktree.txt"), "/wrong/root\n");
		const logError = console.error;
		console.error = () => {};
		try {
			await handlers.session_start({}, ctx(failRepo));
			const blocked = await handlers.tool_call({ toolName: "write", input: { path: path.join(failRepo, "file.txt") } }, ctx(failRepo));
			assert.equal(blocked?.block, true, "shadow identity failure blocks the write");
			const blockedUserBash = await handlers.user_bash({ command: `echo x>${path.join(failRepo, "file.txt")}`, cwd: failRepo });
			assert.equal(blockedUserBash?.result?.exitCode, 1, "shadow failure blocks manual ! bash too");
		} finally { console.error = logError; }

		const refCount = refs.length;
		await handlers.session_start({}, ctx(outside));
		await handlers.tool_call({ toolName: "write", input: { path: path.join(a, "file.txt") } }, ctx(outside));
		assert.equal(refs.length, refCount, "outside-Git session deactivates checkpoints");
		console.log("checkpoint tests passed");
		process.exitCode = 0;
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
		process.exit(process.exitCode ?? 1);
	}
}
