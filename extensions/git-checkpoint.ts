// Derivative of chao/pi-tree-graph (MIT). Shadows are keyed by canonical repo root.
// Only sessions launched inside Git are active; checkpoint failures block matched writes.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOME = os.homedir();
const AGENT_DIR = path.join(HOME, ".pi", "agent");
const CKPT_ROOT = path.join(AGENT_DIR, "checkpoints");
const CODE_ROOT = path.join(HOME, "code");

// commit 身份兜底（-c 必须在子命令前）
const GIT_IDENTITY = ["-c", "user.name=pi-checkpoint", "-c", "user.email=pi-checkpoint@local"];

interface Target {
	label: string; // 展示名（/checkpoints 里用）
	worktree: string; // 被保护的工作树
	gitDir: string | null; // 影子 repo 的 .git 绝对路径；null = worktree 自身就是 repo
}

function gitEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	return env;
}

function git(target: Target, args: string[], opts: { allowFail?: boolean } = {}): string {
	try {
		return execFileSync("git", ["--git-dir", target.gitDir!, "--work-tree", target.worktree, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", timeout: 30000, env: gitEnv() });
	} catch (err) {
		if (opts.allowFail) return "";
		throw err;
	}
}

export function repoRoot(dir: string): string | null {
	try {
		const root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000, env: gitEnv() }).trim();
		return root ? fs.realpathSync(root) : null;
	} catch (error) {
		const failure = error as NodeJS.ErrnoException & { status?: number; stderr?: Buffer };
		if (failure.status === 128 && /not a git repository|must be run in a work tree/i.test(failure.stderr?.toString() ?? "")) return null;
		throw error;
	}
}

function secureTree(dir: string): void {
	fs.chmodSync(dir, 0o700);
	for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
		const child = path.join(dir, item.name);
		if (item.isSymbolicLink()) continue;
		if (item.isDirectory()) secureTree(child);
		else fs.chmodSync(child, 0o600);
	}
}

export function ensureShadowRepo(root: string): Target {
	root = fs.realpathSync(root);
	const id = createHash("sha256").update(root).digest("hex");
	const ckpt = path.join(CKPT_ROOT, id);
	const gitDir = path.join(ckpt, ".git");
	fs.mkdirSync(CKPT_ROOT, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(CKPT_ROOT).isSymbolicLink() || fs.realpathSync(CKPT_ROOT) !== CKPT_ROOT) throw new Error("Checkpoint store must not escape through a symlink");
	fs.chmodSync(CKPT_ROOT, 0o700);
	fs.mkdirSync(ckpt, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(ckpt).isSymbolicLink()) throw new Error(`Shadow repo path must not be a symlink: ${ckpt}`);
	fs.chmodSync(ckpt, 0o700);
	if (!fs.existsSync(gitDir)) {
		execFileSync("git", ["init", "--quiet", ckpt], { timeout: 30000, env: gitEnv() });
		fs.chmodSync(gitDir, 0o700);
		fs.writeFileSync(path.join(ckpt, "pi-checkpoint-worktree.txt"), root + "\n", { mode: 0o600 });
	}
	if (fs.lstatSync(gitDir).isSymbolicLink()) throw new Error(`Shadow Git directory must not be a symlink: ${gitDir}`);
	if (fs.readFileSync(path.join(ckpt, "pi-checkpoint-worktree.txt"), "utf8").trim() !== root) throw new Error(`Checkpoint identity mismatch for ${root}`);
	secureTree(ckpt);
	return { label: root, worktree: root, gitDir };
}

function canonicalPath(abs: string, seen = new Set<string>()): string {
	abs = path.resolve(abs);
	if (seen.has(abs)) throw new Error(`Symlink cycle at ${abs}`);
	seen.add(abs);
	try {
		if (fs.lstatSync(abs).isSymbolicLink()) return canonicalPath(path.resolve(path.dirname(abs), fs.readlinkSync(abs)), seen);
		return fs.realpathSync(abs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = path.dirname(abs);
		if (parent === abs) throw error;
		return path.join(canonicalPath(parent, seen), path.basename(abs));
	}
}

export function targetForPath(abs: string): Target | null {
	abs = path.resolve(abs);
	if (abs === CKPT_ROOT || abs.startsWith(CKPT_ROOT + path.sep)) return null;
	const real = canonicalPath(abs);
	if (real === CKPT_ROOT || real.startsWith(CKPT_ROOT + path.sep)) return null;
	let probe = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? real : path.dirname(real);
	while (!fs.existsSync(probe)) probe = path.dirname(probe);
	const root = repoRoot(probe);
	return root ? ensureShadowRepo(root) : null;
}

let sessionActive = false;
function checkpointTargets(cwd: string, includeLegacy = false): Target[] {
	if (!sessionActive) return [];
	const root = repoRoot(cwd);
	if (!root) return [];
	const targets = [ensureShadowRepo(root)];
	const rel = path.relative(CODE_ROOT, root);
	if (includeLegacy && rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
		const old = path.join(CKPT_ROOT, rel.split(path.sep)[0]);
		const oldGit = path.join(old, ".git");
		const marker = path.join(old, "pi-checkpoint-worktree.txt");
		if (fs.existsSync(oldGit) && !fs.lstatSync(old).isSymbolicLink() && !fs.lstatSync(oldGit).isSymbolicLink() && fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === root) {
			targets.push({ label: rel.split(path.sep)[0], worktree: root, gitDir: oldGit });
		}
	}
	return targets;
}

// shortcut: shell detection is heuristic; add modifying forms when encountered, not a shell parser.
export function isWritingCommand(command: string): boolean {
	return /(?:^|[^<])(?:\d*>>?|&>>?)\s*(?![&=])/.test(command) ||
		/(?:^|[;&|]\s*|\s)(?:sudo\s+)?(?:tee|cp|mv|install|touch|truncate|dd|rm|mkdir|rmdir|chmod|chown|ln|git\s+(?:-C\s+[^\s]+\s+)?(?:checkout|reset|clean|apply|am|merge|rebase|cherry-pick|restore))\b/.test(command) ||
		/(?:^|[;&|]\s*|\s)(?:sed|perl)\s+[^;&|]*\s-[^\s;&|]*i[^\s;&|]*(?:\s|$)/.test(command);
}

export function bashTargets(command: string, cwd: string): Target[] {
	const paths = new Set([path.join(cwd, ".pi-checkpoint-probe")]);
	const pathPattern = /(?:^|[;&|]\s*)cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))|(?:\d*>>?|&>>?)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))|\b(?:tee|touch|truncate|rm|mkdir|rmdir|chmod|chown|cp|mv|install)\s+(?:-[^\s]+\s+)*([^\s;&|]+)|\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
	for (const m of command.matchAll(pathPattern)) {
		const dest = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9] ?? m[10];
		if (!dest || dest === "-" || dest.startsWith("&")) continue;
		const resolved = path.resolve(cwd, dest);
		paths.add(m[1] || m[2] || m[3] || m[8] || m[9] || m[10] ? path.join(resolved, ".pi-checkpoint-probe") : resolved);
	}
	for (const m of command.matchAll(/\b(?:tee|touch|truncate|rm|mkdir|rmdir|chmod|chown|cp|mv|install)\s+([^;&|]+)/g)) {
		for (const token of m[1].matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)) {
			const arg = token[1] ?? token[2] ?? token[3] ?? "";
			if (arg && !arg.startsWith("-") && !/^\d+$/.test(arg)) paths.add(path.resolve(cwd, arg));
		}
	}
	const targets = new Map<string, Target>();
	for (const file of paths) {
		const t = targetForPath(file);
		if (t) targets.set(t.worktree, t);
	}
	return [...targets.values()];
}

/** session 里记录快照关联的 customType（tree-graph 插件消费，勿改） */
const CKPT_REF_TYPE = "git-checkpoint-ref";

interface PruneConfig {
	retentionDays: number; // 只清理早于此天数的提交
	minKeep: number; // 永远保留最新的 N 个提交
	hardCap: number; // 总数硬上限（失控保护）
	auto: boolean; // session_start 是否自动清理
}

function numEnv(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function getPruneConfig(): PruneConfig {
	return {
		retentionDays: numEnv("PI_CHECKPOINT_RETENTION_DAYS", 30),
		minKeep: numEnv("PI_CHECKPOINT_MIN_KEEP", 50),
		hardCap: numEnv("PI_CHECKPOINT_HARD_CAP", 1000),
		auto: process.env["PI_CHECKPOINT_PRUNE"] !== "0",
	};
}

/** 归档 bundle 存放目录（影子 repo 旁 / agent 的 checkpoints 下，均被 agent 快照排除） */
export function archiveDir(t: Target): string {
	if (t.gitDir) return path.dirname(t.gitDir);
	return path.join(CKPT_ROOT, "agent");
}

export function listBundles(t: Target): string[] {
	try {
		const dir = archiveDir(t);
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter((f) => f.startsWith("archive-") && f.endsWith(".bundle"))
			.sort()
			.map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

/** 打快照：工作树与 HEAD 无差异则跳过。返回快照 hash（无快照时 null）。 */
export function snapshot(t: Target, message: string): string | null {
	const exclude = [":(exclude,glob)**/.git", ":(exclude,glob)**/.git/**", ...["node_modules", "build"].map((x) => `:(exclude,glob)**/${x}/**`)];
	const storeRel = path.relative(t.worktree, CKPT_ROOT);
	if (storeRel && !storeRel.startsWith("..") && !path.isAbsolute(storeRel)) exclude.push(`:(exclude,glob)${storeRel}/**`);
	git(t, [...GIT_IDENTITY, "add", "-A", "-f", "--", ".", ...exclude]);
	if (!git(t, ["diff", "--cached", "--name-only"]).trim()) return null;
	git(t, [...GIT_IDENTITY, "commit", "--quiet", "-m", `[pi-checkpoint] ${message}`]);
	secureTree(path.dirname(t.gitDir!));
	return git(t, ["rev-parse", "--short", "HEAD"]).trim();
}

/** 打快照并把 hash 作为 custom entry 写进当前 session（供 /tree-graph 展示与恢复）。 */
function snapshotAndRecord(pi: ExtensionAPI, t: Target, message: string): string | null {
	const hash = snapshot(t, message);
	if (hash) {
		pi.appendEntry(CKPT_REF_TYPE, {
			label: t.label,
			worktree: t.worktree,
			gitDir: t.gitDir,
			hash,
			message,
		});
	}
	return hash;
}

interface CommitMeta {
	sha: string;
	tree: string;
	an: string;
	ae: string;
	at: string;
	cn: string;
	ce: string;
	ct: string;
	body: string;
}

/**
 * 批量取历史元数据（一次 git log 全取，禁止逐提交派生进程：
 * macOS 每次派生 ~13ms，几百提交就是十几秒）。
 * 记录分隔用 \\x1e，字段分隔用 \\x00（message 不可能含 NUL）。
 */
function batchLog(t: Target, branch: string, full: boolean): CommitMeta[] | null {
	try {
		const prefix = t.gitDir ? ["--git-dir", t.gitDir, "--work-tree", t.worktree] : ["-C", t.worktree];
		const fmt = full
			? "%H%x00%ct%x00%T%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%B%x1e"
			: "%H%x00%ct%x00%T%x1e";
		const out = execFileSync("git", [...prefix, "log", "--reverse", `--format=${fmt}`, branch], {
			encoding: "utf8",
			timeout: 60000,
			env: gitEnv(),
		});
		const metas: CommitMeta[] = [];
		for (const rec of out.split("\x1e")) {
			const line = rec.replace(/^\n+/, "");
			if (!line.trim()) continue;
			const p = line.split("\0");
			if (p.length < 3) return null;
			metas.push({
				sha: p[0], ct: p[1], tree: p[2],
				an: p[3] ?? "", ae: p[4] ?? "", at: p[5] ?? "",
				cn: p[6] ?? "", ce: p[7] ?? "", body: p.slice(8).join("\0"),
			});
		}
		return metas;
	} catch {
		return null;
	}
}

/**
 * 清理目标 repo 的老快照，返回人类可读的报告；无需清理返回 null。
 * 只删"早于保留期且不在最新 minKeep 内"的提交；重写历史前先把被删区间
 * 打包成 bundle（git bundle create），恢复时可取回。只动 .git，不管工作树。
 */
export function pruneTarget(t: Target, cfg: PruneConfig = getPruneConfig()): string | null {
	try {
		const prefix = t.gitDir ? ["--git-dir", t.gitDir, "--work-tree", t.worktree] : ["-C", t.worktree];
		const run = (args: string[], extra?: Record<string, string>): string => {
			const env = gitEnv();
			for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE"]) {
				if (extra?.[key]) env[key] = extra[key];
			}
			return execFileSync("git", [...prefix, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8", timeout: 60000, env }).trim();
		};
		const branch = run(["symbolic-ref", "--short", "HEAD"]);
		if (!branch) return null;
		// 轻量批量查询定剪裁集（1 次派生）；无事可做直接返回
		const light = batchLog(t, branch, false);
		if (!light || !light.length) return null;
		const tip = light[light.length - 1].sha;
		if (light.length <= cfg.minKeep) return null;

		const all = light.map((m) => m.sha);
		const ctOf = new Map(light.map((m) => [m.sha, Number(m.ct) * 1000]));
		const cutoffTime = Date.now() - cfg.retentionDays * 86400 * 1000;
		const keepNewest = new Set(all.slice(-cfg.minKeep));
		const pruneSet = new Set(all.filter((sha) => !keepNewest.has(sha) && (ctOf.get(sha) ?? 0) < cutoffTime));
		if (all.length - pruneSet.size > cfg.hardCap) {
			// 硬上限兜底：从最老开始补删（罕见，失控循环时触发）
			const rest = all.filter((sha) => !keepNewest.has(sha) && !pruneSet.has(sha));
			for (const sha of rest.slice(0, all.length - pruneSet.size - cfg.hardCap)) pruneSet.add(sha);
		}
		if (!pruneSet.size) return null;

		// 真要动手才取全量元数据（第 2 次派生）：tail = 保留的提交（位置序），cutoff = 被删中最新的一个
		const full = batchLog(t, branch, true);
		if (!full) return null;
		const metaOf = new Map(full.map((m) => [m.sha, m]));
		const tail = all.filter((sha) => !pruneSet.has(sha));
		const cutoff = all.filter((sha) => pruneSet.has(sha)).pop() as string;

		// 1. 归档被删区间
		const dir = archiveDir(t);
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const bundle = path.join(dir, `archive-${stamp}.bundle`);
		// bundle create 接裸 SHA 会判空包，用临时 tag 带 ref 归档被删区间
		const tag = `tmp-archive-${stamp}`;
		try {
			run(["tag", tag, cutoff]);
			run(["bundle", "create", bundle, tag]);
			run(["bundle", "verify", bundle]);
		} finally {
			run(["tag", "-d", tag]);
		}

		// 2. 新 root（cutoff 的树）+ 按序重放 tail（保留作者/时间/message）
		const baseEnv = (m: CommitMeta): Record<string, string> => ({
			...process.env as Record<string, string>,
			GIT_AUTHOR_NAME: m.an, GIT_AUTHOR_EMAIL: m.ae, GIT_AUTHOR_DATE: m.at,
			GIT_COMMITTER_NAME: m.cn, GIT_COMMITTER_EMAIL: m.ce, GIT_COMMITTER_DATE: m.ct,
		});
		const baseMeta = metaOf.get(cutoff);
		if (!baseMeta) return null;
		// baseline 用当前时间（不用被删提交的旧身份），否则下次运行会再次被清理导致反复重写
		const now = Math.floor(Date.now() / 1000).toString();
		const baseEnvNow: Record<string, string> = {
			...process.env as Record<string, string>,
			GIT_AUTHOR_NAME: "pi-checkpoint", GIT_AUTHOR_EMAIL: "pi-checkpoint@local", GIT_AUTHOR_DATE: now,
			GIT_COMMITTER_NAME: "pi-checkpoint", GIT_COMMITTER_EMAIL: "pi-checkpoint@local", GIT_COMMITTER_DATE: now,
		};
		let parent = run(["commit-tree", baseMeta.tree, "-m", `[pi-checkpoint] baseline（auto-prune ${stamp}，老快照见 ${path.basename(bundle)}）`], baseEnvNow);
		for (const sha of tail) {
			const m = metaOf.get(sha);
			if (!m || !m.tree) return null;
			parent = run(["commit-tree", m.tree, "-p", parent, "-m", m.body], baseEnv(m));
		}
		// 3. 原子切换分支（oldvalue 校验防并发）
		run(["update-ref", `refs/heads/${branch}`, parent, tip]);
		return `${t.label}：清理 ${pruneSet.size} 个老快照，保留 ${tail.length + 1} 个，归档 ${path.basename(bundle)}`;
	} catch (err) {
		console.warn(`[git-checkpoint] 清理 ${t.label} 失败（历史未动）:`, err instanceof Error ? err.message.slice(0, 200) : String(err));
		return null;
	}
}

function commitExists(t: Target, hash: string): boolean {
	try {
		const prefix = t.gitDir ? ["--git-dir", t.gitDir, "--work-tree", t.worktree] : ["-C", t.worktree];
		execFileSync("git", [...prefix, "rev-parse", "--verify", "--quiet", `${hash}^{commit}`], { env: gitEnv() });
		return true;
	} catch {
		return false;
	}
}

type EntryRendererRegistration = (
	this: ExtensionAPI,
	type: string,
	renderer: (entry: { data?: unknown }, opts: { expanded: boolean }, theme: { fg: (c: string, s: string) => string }) => Box,
) => void;

export default function (pi: ExtensionAPI) {
	// 快照条目在正文里的渲染（无 renderer 时正文直接跳过 custom 条目）；
	// 方法不存在的老版本 pi 直接跳过，保证扩展主体不受影响。
	// SAFETY: older host versions omit this optional renderer API; access is guarded below.
	const registerRenderer = (pi as unknown as Record<string, unknown>)["registerEntryRenderer"];
	if (typeof registerRenderer === "function") {
		(registerRenderer as EntryRendererRegistration).call(pi, CKPT_REF_TYPE, (entry: { data?: unknown }, opts: { expanded: boolean }, theme: { fg: (c: string, s: string) => string }) => {
			const data = (entry.data ?? {}) as { hash?: string; message?: string; label?: string; worktree?: string };
			const box = new Box(1, 1, (text: string) => theme.fg("dim", text));
			box.addChild(new Text(`⎇ ${data.hash ?? "?"} ${data.message ?? ""}`.trimEnd()));
			if (opts.expanded) {
				box.addChild(new Text(theme.fg("dim", `${data.label ?? ""} · ${data.worktree ?? ""}`)));
			}
			return box;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		sessionActive = false;
		sessionActive = repoRoot(ctx.cwd) !== null;
		if (!sessionActive) {
			ctx.ui.setStatus("git-checkpoint", "checkpoints inactive (session outside Git)");
			return;
		}
		try {
			const targets = checkpointTargets(ctx.cwd);
			for (const t of targets) snapshotAndRecord(pi, t, "session start");
			const cfg = getPruneConfig();
			if (cfg.auto) for (const t of targets) {
				const n = Number(git(t, ["rev-list", "--count", "HEAD"], { allowFail: true }).trim() || "0");
				if (n > cfg.minKeep) pruneTarget(t, cfg);
			}
			ctx.ui.setStatus("git-checkpoint", `💾 ${targets.map((t) => t.label).join(" · ")}`);
		} catch (err) {
			console.error("[git-checkpoint] session_start checkpoint failed:", err);
		}
	});
	pi.on("session_shutdown", () => { sessionActive = false; });

	const protect = (command: string, cwd: string) => {
		if (!sessionActive || !isWritingCommand(command)) return;
		for (const t of bashTargets(command, cwd)) snapshotAndRecord(pi, t, "before bash write");
	};
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (isToolCallEventType("bash", event)) protect(event.input.command, ctx.cwd);
			else if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				const p = event.input.path;
				if (typeof p === "string" && p) {
					const expanded = p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;
					const t = sessionActive ? targetForPath(path.resolve(ctx.cwd, expanded)) : null;
					if (t) snapshotAndRecord(pi, t, `before edit ${path.basename(expanded)}`);
				}
			}
		} catch (err) {
			console.error("[git-checkpoint] refusing write after checkpoint failure:", err);
			return { block: true, reason: `Checkpoint failed; write blocked: ${err instanceof Error ? err.message : String(err)}` };
		}
		return { block: false };
	});
	pi.on("user_bash", (event) => {
		try { protect(event.command, event.cwd); }
		catch (err) {
			console.error("[git-checkpoint] refusing user bash after checkpoint failure:", err);
			return { result: { output: `Checkpoint failed; command blocked: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1, cancelled: false, truncated: false } };
		}
	});

	pi.registerCommand("checkpoints", {
		description: "git-checkpoint: 列出各保护目标的最近快照",
		handler: async (_args, ctx) => {
			const targets = checkpointTargets(ctx.cwd, true);
			if (!sessionActive) { ctx.ui.notify("Checkpoints are inactive outside Git sessions.", "info"); return; }
			const lines: string[] = [];
			for (const t of targets) {
				if (!t) continue;
				const count = git(t, ["rev-list", "--count", "HEAD"], { allowFail: true }).trim() || "0";
				lines.push(`── ${t.label}（${count} 个快照）──`);
				lines.push(
					git(t, ["log", "--format=%h %ad %s", "--date=format:%m-%d %H:%M", "-n", "10"], { allowFail: true }).trimEnd() ||
						"（还没有快照）",
				);
				lines.push("");
			}
			ctx.ui.notify(lines.join("\n").trim() || "无可保护的 checkpoint 目标", "info");
		},
	});

	pi.registerCommand("checkpoint-prune", {
		description: "git-checkpoint: 立即清理过期快照（归档 bundle + 重写历史）",
		handler: async (_args, ctx) => {
			if (!sessionActive) { ctx.ui.notify("Checkpoints are inactive outside Git sessions.", "info"); return; }
			const cfg = getPruneConfig();
			const lines: string[] = [`Retention: ${cfg.retentionDays} days / newest ${cfg.minKeep} / cap ${cfg.hardCap}`];
			const targets = checkpointTargets(ctx.cwd, true);
			for (const t of targets) {
				if (!t) continue;
				lines.push(pruneTarget(t, cfg) ?? `${t.label}：无需清理`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("checkpoint-restore", {
		description: "git-checkpoint: 恢复工作树到指定快照（用法: /checkpoint-restore <hash>）",
		handler: async (args, ctx) => {
			const hash = args.trim().split(/\s+/)[0];
			if (!/^[0-9a-f]{7,64}$/i.test(hash ?? "")) {
				ctx.ui.notify("用法: /checkpoint-restore <hash>（先 /checkpoints 查看快照列表）", "warning");
				return;
			}
			if (!sessionActive) { ctx.ui.notify("Checkpoints are inactive outside Git sessions.", "info"); return; }
			const candidates = checkpointTargets(ctx.cwd, true);
			let hit = candidates.find((t) => commitExists(t, hash));
			if (!hit) {
				// 清理归档的 bundle 里找：取回后再恢复
				for (const t of candidates) {
					if (!t || hit) break;
					for (const b of listBundles(t)) {
						git(t, ["fetch", "--quiet", b, hash], { allowFail: true });
						if (commitExists(t, hash)) {
							hit = t;
							break;
						}
					}
				}
			}
			if (!hit) {
				ctx.ui.notify(`在已知保护目标（含归档）中找不到快照 ${hash}`, "warning");
				return;
			}
			const ok = await ctx.ui.confirm(
				"git-checkpoint",
				`将 ${hit.label} 的文件恢复到快照 ${hash}？\n覆盖已跟踪文件的当前内容；快照之后新建的文件不会被删除。\n继续？`,
				{ timeout: 30000 },
			);
			if (!ok) {
				ctx.ui.notify("已取消恢复", "info");
				return;
			}
			git(hit, [...GIT_IDENTITY, "checkout", hash, "--", "."]);
			ctx.ui.notify(`✅ ${hit.label} 已恢复到 ${hash}`, "info");
		},
	});
}
