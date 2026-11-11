// tree-graph — pi 会话树的可视化插件（git-graph 风格分叉连线 + git-checkpoint 联动）
//
// /tree-graph  打开全屏图形树：
//   - 真实分叉连线（├─ └─ │），当前活跃路径高亮，分支之间空行分隔
//   - ↑↓ / j k 移动，enter 跳转到选中节点（ctx.navigateTree）
//   - f 循环过滤：full(全部) → no-tools(无工具结果) → user(仅用户/锚点)
//   - g 在 git 快照行上恢复代码（checkout 快照）
//   - esc / q / ctrl+c 关闭
//
// git 联动：依赖 git-checkpoint.ts 扩展写入的 custom entries
//（customType "git-checkpoint-ref"，字段 label/worktree/gitDir/hash/message）。
// 本插件只读展示 + 触发恢复，不自行创建快照。未安装 git-checkpoint 时其余功能照常。
//
// 数据源：ctx.sessionManager.getTree() → SessionTreeNode[]（entry/children/label）。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";

export const GIT_REF_TYPE = "git-checkpoint-ref";

export interface GitRefData {
	label: string;
	worktree: string;
	gitDir: string | null;
	hash: string;
	message?: string;
}

function execGit(args: string[], timeout = 3000): string {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	return execFileSync("git", args, { encoding: "utf8", timeout, env, stdio: ["ignore", "pipe", "pipe"] });
}

export function checkpointRefIsSafe(data: GitRefData): boolean {
	if (!data.gitDir || !/^[0-9a-f]{7,64}$/i.test(data.hash)) return false;
	try {
		const store = path.join(os.homedir(), ".pi", "agent", "checkpoints");
		const root = fs.realpathSync(store) + path.sep;
		const gitDir = fs.realpathSync(data.gitDir);
		const worktree = fs.realpathSync(data.worktree);
		return gitDir.startsWith(root) && fs.readFileSync(path.join(path.dirname(gitDir), "pi-checkpoint-worktree.txt"), "utf8").trim() === worktree;
	} catch { return false; }
}

export type FilterMode = "full" | "no-tools" | "user";
export const FILTER_MODES: FilterMode[] = ["user", "no-tools", "full"];
export const FILTER_LABEL: Record<FilterMode, string> = {
	full: "全部",
	"no-tools": "无工具结果",
	user: "仅用户/锚点",
};

// ---------- entry 可见性 ----------

function roleOf(entry: SessionEntry): string | undefined {
	return entry.type === "message" ? (entry.message as { role?: string }).role : undefined;
}

/** 噪音 custom_message 黑名单（任何模式都不显示） */
const NOISE_CUSTOM_TYPES = ["auto-retry"];

function isNoise(entry: SessionEntry): boolean {
	if (entry.type === "custom_message" && NOISE_CUSTOM_TYPES.some((t) => entry.customType.startsWith(t))) {
		return true;
	}
	if (entry.type === "custom" && NOISE_CUSTOM_TYPES.some((t) => entry.customType.startsWith(t))) {
		return true;
	}
	return false;
}

export function isVisible(entry: SessionEntry, filter: FilterMode): boolean {
	if (entry.type === "label") return false; // 元数据，并入目标行显示
	if (isNoise(entry)) return false;
	if (filter === "full") return true;
	if (filter === "no-tools") return roleOf(entry) !== "toolResult";
	// user 模式：结构锚点（git 快照/压缩/分支摘要）+ 用户输入。
	// 扩展注入的提示（custom_message）与 session_info 不属于对话内容，隐藏。
	if (entry.type === "custom") {
		if (entry.customType !== GIT_REF_TYPE) return false;
		// 启动快照（每次启动/reload/跳转都打一条）恢复价值低且数量多，user 模式默认不占行；
		// full / no-tools 模式仍显示，g 恢复能力不受影响
		const cp = entry.data as GitRefData;
		return cp?.message !== "session start";
	}
	if (entry.type === "message") {
		const role = roleOf(entry);
		return role === "user" || role === "bashExecution";
	}
	return entry.type === "compaction" || entry.type === "branch_summary";
}

// ---------- 虚拟可见树（过滤时收缩不可见节点、子孙提升） ----------

export interface VNode {
	node: SessionTreeNode | null; // null = 被过滤收缩，子孙提升到本层
	children: VNode[];
}

export function buildVNode(node: SessionTreeNode, filter: FilterMode): VNode | null {
	// 显式栈后序遍历：超长会话链（数千层）递归会爆栈；visiting 断开 parentId 环
	const built = new Map<string, VNode | null>();
	const visiting = new Set<string>();
	const stack: { node: SessionTreeNode; expanded: boolean }[] = [{ node, expanded: false }];
	while (stack.length) {
		const top = stack[stack.length - 1];
		const id = top.node.entry.id;
		if (built.has(id)) {
			stack.pop();
			continue;
		}
		if (!top.expanded) {
			if (visiting.has(id)) {
				built.set(id, null); // 环：断开
				stack.pop();
				continue;
			}
			visiting.add(id);
			top.expanded = true;
			for (let i = top.node.children.length - 1; i >= 0; i--) {
				const c = top.node.children[i];
				if (!built.has(c.entry.id)) stack.push({ node: c, expanded: false });
			}
		} else {
			visiting.delete(id);
			const kids: VNode[] = [];
			for (const c of top.node.children) {
				const v = built.get(c.entry.id);
				if (v) kids.push(v);
			}
			built.set(
				id,
				isVisible(top.node.entry, filter) ? { node: top.node, children: kids } : kids.length ? { node: null, children: kids } : null,
			);
			stack.pop();
		}
	}
	return built.get(node.entry.id) ?? null;
}

export interface Row {
	kind: "entry" | "sep" | "merge";
	node?: SessionTreeNode;
	line: string; // 已构造的行首连线（无色，渲染时着色）
	active?: boolean;
	/** 被吸收的 git 快照（同一 user turn 内多次 edit 的快照聚合到 user 行） */
	badges?: GitRefData[];
	/** 合并链（连发同文消息）的全部 entry id，node 指向最新 */
	mergedIds?: string[];
	/** 最近可见祖先的 entry id（过滤收缩后 parentId 可能指向不可见节点） */
	parentVisibleId?: string | null;
	/** 本行是某分叉的分支头（fork 点的分支），其独子链上的快照不可被吸收 */
	forked?: boolean;
}

/**
 * 合并相邻重复节点：同连线、同类型、同摘要文本的连续行（如连发的「继续」）
 * 合并为一行「继续 ×N」，指向最新节点。被 sep/不同连线隔开、或文本不同的行不合并；
 * 吸收的 git 快照徽章（badges）随合并一起保留。
 */
export function mergeDuplicateRows(rows: Row[]): void {
	let i = 1;
	while (i < rows.length) {
		const prev = rows[i - 1]!;
		const cur = rows[i]!;
		if (
			prev.kind === "entry" &&
			cur.kind === "entry" &&
			prev.node &&
			cur.node &&
			prev.line === cur.line &&
			prev.node.entry.type === cur.node.entry.type &&
			describeEntry(cur.node).text !== "" &&
			describeEntry(prev.node).text === describeEntry(cur.node).text
		) {
			const prevIds = prev.mergedIds ?? [prev.node.entry.id];
			const curIds = cur.mergedIds ?? [cur.node.entry.id];
			prev.node = cur.node; // 指向最新节点（enter 跳到最新）
			prev.mergedIds = [...prevIds, ...curIds];
			prev.active = prev.active || cur.active;
			if (cur.badges?.length) prev.badges = [...(prev.badges ?? []), ...cur.badges];
			rows.splice(i, 1); // 不前进 i，继续吞下一行
		} else {
			i++;
		}
	}
}

const isCheckpointEntry = (entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> =>
	entry.type === "custom" && entry.customType === GIT_REF_TYPE;

/**
 * git 快照吸收（user 模式）：同一 user turn 内的连续快照不再占行，
 * 聚合为 user/bash 行尾徽章（恢复时取最新一个）。sep（分支边界）阻断，
 * 分支头或无宿主的快照保留独立行。
 */
export function absorbCheckpoints(rows: Row[]): Row[] {
	const out: Row[] = [];
	let lastUser: Row | null = null;
	for (const row of rows) {
		if (row.kind !== "entry") {
			lastUser = null;
			out.push(row);
			continue;
		}
		const entry = row.node!.entry;
		if (isCheckpointEntry(entry)) {
			if (lastUser && !row.forked) {
				(lastUser.badges ??= []).push(entry.data as GitRefData);
				// 摘除后其子行的可见父改挂到被吸收行的可见父，避免轨道断线
				const redirect = row.parentVisibleId ?? null;
				for (const later of rows) {
					if (later.parentVisibleId === entry.id) later.parentVisibleId = redirect;
				}
				continue; // 摘除
			}
			out.push(row);
			continue;
		}
		const role = roleOf(entry);
		if (entry.type === "message" && (role === "user" || role === "bashExecution")) {
			lastUser = row;
		}
		out.push(row);
	}
	return out;
}

/** 收集 root→leaf 的活跃路径 id 集合。 */
export function collectActiveIds(tree: SessionTreeNode[], leafId: string): Set<string> {
	const byId = new Map<string, SessionTreeNode>();
	const stack = [...tree];
	while (stack.length) {
		const n = stack.pop()!;
		if (byId.has(n.entry.id)) continue; // 子树环：跳过已访问
		byId.set(n.entry.id, n);
		for (const c of n.children) stack.push(c);
	}
	const ids = new Set<string>();
	let cur = byId.get(leafId);
	while (cur && !ids.has(cur.entry.id)) {
		ids.add(cur.entry.id); // parentId 环：遇到已收录即停
		cur = cur.entry.parentId ? byId.get(cur.entry.parentId) : undefined;
	}
	return ids;
}

/**
 * DFS 收集可见节点行（不生成连线；连线由 applyTimeOrder 按时间倒序重新计算）。
 */
export function emitRows(
	v: VNode,
	visibleParentId: string | null,
	forked: boolean,
	activeIds: Set<string>,
	out: Row[],
): void {
	// 显式栈 DFS：与递归版同序（节点先行、子节点按序，逆序入栈）；path 断开环
	interface Frame {
		v: VNode;
		pid: string | null;
		fork: boolean;
		exit: boolean;
	}
	const stack: Frame[] = [{ v, pid: visibleParentId, fork: forked, exit: false }];
	const path = new Set<VNode>();
	while (stack.length) {
		const f = stack.pop()!;
		if (f.exit) {
			path.delete(f.v);
			continue;
		}
		if (path.has(f.v)) continue; // 环：跳过
		path.add(f.v);
		stack.push({ v: f.v, pid: f.pid, fork: f.fork, exit: true });
		if (f.v.node) {
			out.push({
				kind: "entry",
				node: f.v.node,
				line: "",
				active: activeIds.has(f.v.node.entry.id),
				parentVisibleId: f.pid,
				forked: f.fork,
			});
			const myFork = f.v.children.length > 1;
			for (let i = f.v.children.length - 1; i >= 0; i--) {
				stack.push({ v: f.v.children[i], pid: f.v.node.entry.id, fork: myFork, exit: false });
			}
		} else {
			// 虚拟节点穿透：可见父不变；虚拟节点自己是分叉点时保留 fork 标记
			const forkNow = f.fork || f.v.children.length > 1;
			for (let i = f.v.children.length - 1; i >= 0; i--) {
				stack.push({ v: f.v.children[i], pid: f.pid, fork: forkNow, exit: false });
			}
		}
	}
}

// ---------- 时间倒序轨道布局（git log --graph 风格） ----------

/**
 * 按时间从近到远重排行，并用槽位算法生成轨道连线：
 *  - 最新节点在最上方，越往下越早，超长会话打开即最新；
 *  - 每个节点占一条轨道（│），分叉向右开新轨，多子汇合时用 / 归并回父轨道。
 */
export function applyTimeOrder(rows: Row[]): void {
	// 1. 时间降序（同秒保持 DFS 序的逆，保证父在子下方）
	const idx = rows.map((r, i) => ({ r, i }));
	idx.sort((a, b) => {
		const ta = a.r.node?.entry.timestamp ?? "";
		const tb = b.r.node?.entry.timestamp ?? "";
		if (ta !== tb) return tb < ta ? -1 : 1;
		return b.i - a.i;
	});
	const sorted = idx.map((x) => x.r);

	// 2. 槽位连线：遍历（新→旧），子已把自己的 id 写入槽，父行接住；
	//    parent 已被其他子占用时，本槽用 / 汇合行归并过去
	const slots: (string | null)[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const row = sorted[i];
		if (row.kind !== "entry") continue; // 汇合行已在前面插入，跳过
		const id = row.node!.entry.id;
		let col = slots.indexOf(id);
		if (col < 0) {
			const free = slots.indexOf(null);
			if (free >= 0) slots[free] = id;
			else slots.push(id);
			col = free >= 0 ? free : slots.length - 1;
		}
		row.line = slotLine(slots, col);

		const others: number[] = [];
		slots.forEach((s, i) => {
			if (s === id && i !== col) others.push(i);
		});
		others.forEach((i) => (slots[i] = null));

		const p = row.parentVisibleId ?? row.node!.entry.parentId;
		const pSlot = p ? slots.indexOf(p) : -1;
		if (!p) {
			slots[col] = null;
		} else if (pSlot >= 0 && pSlot !== col) {
			// 父轨道已被兄弟占用：插入汇合行，本线归并过去
			const mergeRow: Row = { kind: "merge", line: mergeLine(col, pSlot, slots) };
			sorted.splice(sorted.indexOf(row) + 1, 0, mergeRow);
			slots[col] = null;
		} else {
			slots[col] = p;
		}
	}
	// 重写数组顺序（原地，保持外部引用）
	sorted.forEach((r, i) => (rows[i] = r));
	rows.length = sorted.length;
}

function slotLine(slots: (string | null)[], nodeCol: number): string {
	// 保留最后一个非空槽（含其后的一个空格），纯空格尾列截断
	const parts: string[] = [];
	let last = -1;
	for (let i = 0; i < slots.length; i++) {
		const ch = i === nodeCol || slots[i] ? "│ " : "  ";
		parts.push(ch);
		if (ch !== "  ") last = i;
	}
	return parts.slice(0, last + 1).join("");
}

/** 汇合行：本槽的线斜归父槽（/ 左下、\ 右下），中间跨槽用 ─。 */
function mergeLine(col: number, pSlot: number, slots: (string | null)[]): string {
	let s = "";
	const lo = Math.min(col, pSlot);
	const hi = Math.max(col, pSlot);
	for (let i = 0; i <= hi; i++) {
		if (i === pSlot) s += "│ ";
		else if (i === col) s += col > pSlot ? "/ " : "\\ ";
		else if (i > lo && i < hi) s += "──";
		else s += slots[i] ? "│ " : "  ";
	}
	return s;
}

// ---------- 摘要与展示 ----------

function fmtTime(ts: string | number | undefined): string {
	if (ts === undefined || ts === null || ts === "") return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	if (
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate()
	) {
		return hm;
	}
	return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			out += (block as { text?: string }).text ?? "";
		}
	}
	return out;
}

export function oneLine(s: string, max = 120): string {
	return s.replace(/\s+/g, " ").trim().slice(0, max);
}

export function argPreview(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	for (const key of ["path", "file_path", "pattern", "command", "url", "query", "name"]) {
		const v = args[key];
		if (typeof v === "string" && v) return oneLine(v, 40);
	}
	const first = Object.values(args).find((v) => typeof v === "string" && v);
	return first ? oneLine(first as string, 40) : "";
}

export interface EntryDesc {
	icon: string;
	color: string; // theme.fg 颜色名
	text: string;
	bold?: boolean; // 行内加粗（user 主角行）
	time?: string; // 右对齐时间
	detail?: string; // footer 详情（选中时显示）
	restore?: GitRefData; // git 快照行可恢复
}

export function describeEntry(node: SessionTreeNode): EntryDesc {
	const entry = node.entry;
	const time = fmtTime(entry.timestamp);
	switch (entry.type) {
		case "message": {
			const msg = entry.message as Record<string, unknown> & {
				role?: string;
				content?: unknown;
				command?: string;
				toolName?: string;
				isError?: boolean;
				errorMessage?: string;
			};
			const role = msg.role;
			if (role === "user") {
				return {
					icon: "❯",
					color: "accent",
					text: oneLine(textOf(msg.content)) || "(empty)",
					bold: true,
					time,
				};
			}
			if (role === "assistant") {
				const toolCall = Array.isArray(msg.content)
					? msg.content.find(
							(b) =>
								b &&
								typeof b === "object" &&
								(b as { type?: string }).type === "toolCall",
						)
					: undefined;
				if (toolCall) {
					const tc = toolCall as { name?: string; arguments?: Record<string, unknown> };
					const arg = argPreview(tc.arguments);
					return { icon: "⚙", color: "toolTitle", text: `${tc.name ?? "tool"}${arg ? `(${arg})` : "()"}`, time };
				}
				const text = oneLine(textOf(msg.content));
				if (!text && msg.errorMessage) {
					return { icon: "◆", color: "error", text: oneLine(msg.errorMessage), time };
				}
				return { icon: "◆", color: "text", text: text || "(no text)", time };
			}
			if (role === "toolResult") {
				const ok = !msg.isError;
				return { icon: "↳", color: ok ? "dim" : "error", text: `${msg.toolName ?? "tool"} ${ok ? "✓" : "✗"}`, time };
			}
			if (role === "bashExecution") {
				return { icon: "❯", color: "bashMode", text: `!${oneLine(msg.command ?? "", 100)}`, bold: true, time };
			}
			return { icon: "◇", color: "muted", text: role ?? "message", time };
		}
		case "custom": {
			if (entry.customType === GIT_REF_TYPE) {
				const data = entry.data as GitRefData;
				return {
					icon: "⎇",
					color: "success",
					text: `${data?.hash ?? "?"} ${oneLine(data?.message ?? "", 60)}`,
					time,
					detail: data?.label,
					restore: data,
				};
			}
			return { icon: "◇", color: "muted", text: `custom:${entry.customType}`, time };
		}
		case "custom_message":
			return {
				icon: "◇",
				color: "customMessageText",
				text: oneLine(textOf(entry.content)) || entry.customType,
				time,
			};
		case "compaction":
			return {
				icon: "⧉",
				color: "customMessageText",
				text: "compaction",
				time,
				detail: `${entry.tokensBefore ?? "?"} tokens`,
			};
		case "branch_summary":
			return { icon: "⑂", color: "customMessageText", text: oneLine(entry.summary, 100), time };
		case "model_change":
			return { icon: "◇", color: "dim", text: `model → ${entry.modelId}`, time };
		case "thinking_level_change":
			return { icon: "◇", color: "dim", text: `thinking → ${entry.thinkingLevel}`, time };
		case "session_info":
			return { icon: "◇", color: "dim", text: `session: ${entry.name ?? ""}`, time };
		default:
			return { icon: "◇", color: "dim", text: entry.type, time };
	}
}

// ---------- 组件 ----------

export interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ViewDeps {
	tree: SessionTreeNode[];
	leafId: string | null;
	sessionName: string;
	branch: string;
	theme: ThemeLike;
	tui: { terminal: { rows: number; columns: number }; requestRender(): void };
	onJump: (entryId: string) => Promise<void>;
	onRestore: (data: GitRefData) => Promise<void>;
	onClose: () => void;
}

function padTo(s: string, width: number, t: ThemeLike): string {
	const pad = Math.max(0, width - visibleWidth(s));
	return s + t.bg("selectedBg", " ".repeat(pad));
}

export class TreeGraphView {
	private rows: Row[] = [];
	private selected = 0;
	private offset = 0;
	private filter: FilterMode = "user"; // 默认只看用户输入 + 锚点（git 快照/压缩/分支摘要）

	constructor(private deps: ViewDeps) {
		this.rebuild();
	}

	private rebuild(keepEntryId?: string): void {
		const activeIds = this.deps.leafId
			? collectActiveIds(this.deps.tree, this.deps.leafId)
			: new Set<string>();
		const roots = this.deps.tree
			.map((r) => buildVNode(r, this.filter))
			.filter((v): v is VNode => v !== null);
		let rows: Row[] = [];
		roots.forEach((r) => emitRows(r, null, false, activeIds, rows));
		if (this.filter === "user") rows = absorbCheckpoints(rows);
		mergeDuplicateRows(rows);
		applyTimeOrder(rows);
		this.rows = rows;
		const findRow = (id: string) =>
			rows.findIndex((r) => (r.mergedIds ? r.mergedIds.includes(id) : r.node?.entry.id === id));
		let idx = keepEntryId ? findRow(keepEntryId) : -1;
		if (idx < 0 && this.deps.leafId) {
			idx = findRow(this.deps.leafId);
		}
		this.selected = Math.max(0, idx < 0 ? 0 : idx);
		this.offset = 0;
	}

	private renderRow(row: Row, width: number, isSel: boolean): string {
		const t = this.deps.theme;
		if (row.kind !== "entry") {
			const line = t.fg("borderMuted", row.line);
			return isSel ? t.bg("selectedBg", padTo(line, width, t)) : line;
		}
		const node = row.node!;
		const desc = describeEntry(node);
		const count = row.mergedIds?.length ?? 1;
		const linePart = t.fg(row.active ? "accent" : "borderMuted", row.line);
		const text = t.fg(desc.color, count > 1 ? `${desc.text} ×${count}` : desc.text);
		const leftStr = linePart + t.fg(desc.color, `${desc.icon} `) + (desc.bold ? t.bold(text) : text);

		// 右对齐区：label · git 徽章 · 时间 · leaf
		const rights: string[] = [];
		if (node.label) rights.push(t.fg("customMessageLabel", `★${node.label}`));
		const badges = row.badges ?? [];
		if (badges.length) {
			const latest = badges[badges.length - 1];
			const extra = badges.length > 1 ? t.fg("dim", `(+${badges.length - 1})`) : "";
			rights.push(t.fg("success", `⎇${latest.hash}`) + extra);
		}
		if (desc.time) rights.push(t.fg("dim", desc.time));
		const isLeaf = row.mergedIds
			? row.mergedIds.includes(this.deps.leafId ?? "")
			: node.entry.id === this.deps.leafId;
		if (isLeaf) rights.push(t.fg("accent", "◀"));
		const rightStr = rights.join(" ");

		const gap = width - visibleWidth(leftStr) - visibleWidth(rightStr) - 1;
		let content: string;
		if (gap > 1) content = leftStr + " ".repeat(gap) + rightStr;
		else content = truncateToWidth(`${leftStr} ${rightStr}`, width - 1, "");
		return isSel ? t.bg("selectedBg", padTo(content, width, t)) : content;
	}

	private pageSize(): number {
		// 全屏 custom 视窗比终端少 ~2 行，再留余量避免 header 被滚出
		return Math.max(3, this.deps.tui.terminal.rows - 6);
	}

	render(width: number): string[] {
		const t = this.deps.theme;
		const bodyHeight = this.pageSize();
		// clamp 视窗，保持选中可见
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + bodyHeight) this.offset = this.selected - bodyHeight + 1;
		const maxOffset = Math.max(0, this.rows.length - bodyHeight);
		if (this.offset > maxOffset) this.offset = maxOffset;

		const lines: string[] = [];
		const name = this.deps.sessionName || "session";
		const branch = this.deps.branch ? `  ⎇ ${this.deps.branch}` : "";
		const nodeCount = this.rows.filter((r) => r.kind === "entry").length;
		lines.push(
			truncateToWidth(
				t.bold(t.fg("accent", " Session Tree")) +
					t.fg("muted", `  ${name}${branch}  ·  ${nodeCount} 节点`),
				width,
			),
		);
		lines.push(truncateToWidth(t.fg("border", "─".repeat(width)), width));

		const sel = this.selected;
		for (let i = 0; i < bodyHeight; i++) {
			const row = this.rows[this.offset + i];
			if (!row) {
				lines.push("");
				continue;
			}
			lines.push(this.renderRow(row, width, this.offset + i === sel));
		}

		const selRow = this.rows[sel];
		let selText = selRow?.node ? describeEntry(selRow.node).detail || describeEntry(selRow.node).text : "";
		const selCount = selRow?.mergedIds?.length ?? 1;
		if (selCount > 1) selText += ` ×${selCount}`;
		const selBadges = selRow?.badges;
		if (selBadges?.length) {
			const latest = selBadges[selBadges.length - 1];
			selText = `${selBadges.length} 快照 · 最新 ${latest.hash} ${latest.message ?? ""} · g 恢复`;
			if (selCount > 1) selText = `×${selCount} ` + selText;
		}
		lines.push(
			truncateToWidth(
				t.fg("dim", ` ${sel + 1}/${this.rows.length}  ${selText}`),
				width,
			),
		);
		lines.push(
			truncateToWidth(
				t.fg("dim", ` ↑↓/jk move · Pg 翻页 · enter jump · f filter(${FILTER_LABEL[this.filter]}) · g restore · esc close`),
				width,
			),
		);
		return lines;
	}

	private moveBy(delta: number): void {
		const max = Math.max(0, this.rows.length - 1);
		const step = delta > 0 ? 1 : -1;
		for (let i = 0; i < Math.abs(delta); i++) {
			let next = this.selected;
			do {
				next = Math.min(Math.max(next + step, 0), max);
			} while (this.rows[next] && this.rows[next].kind !== "entry" && next > 0 && next < max);
			if (next === this.selected) break;
			this.selected = next;
		}
		if (delta !== 0) this.deps.tui.requestRender();
	}

	private rowAt(y: number): number {
		// 局部 y：0 header、1 分隔线、2+ 正文（offset 起）；-1 表示点空
		const bi = y - 2;
		if (bi < 0 || bi >= this.pageSize()) return -1;
		const idx = this.offset + bi;
		return idx >= 0 && idx < this.rows.length && this.rows[idx]?.kind === "entry" ? idx : -1;
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
		if (event.type === "wheel" && event.wheelDelta) {
			// 每 tick 只走一行：pi 送来的 wheelDelta 自带多行步长（如 3），
			// 直接按步长走就会跳行；触控板/滚轮事件流本身连续，单步跟手且不丢滚动
			this.moveBy(event.wheelDelta > 0 ? 1 : -1);
			return { handled: true };
		}
		// shift+点击留给终端文本选择，不拦截
		if (event.shift) return undefined;
		if (event.type === "press") {
			// 侧键以后退/前进上报（SGR 8/9），pi-tui 归一化为 alt+左键/中键：
			// 后退 → 往新（上一条），前进 → 往旧（下一条）
			if (event.alt && event.button === "left") {
				this.moveBy(-1);
				return { handled: true };
			}
			if (event.alt && event.button === "middle") {
				this.moveBy(1);
				return { handled: true };
			}
			// 普通左键按下即选中（必须处理 press，TUI 才会合成后续 click）
			if (event.button === "left") {
				const idx = this.rowAt(event.y);
				if (idx >= 0) this.selected = idx;
				return { handled: true };
			}
			return undefined;
		}
		if (event.type === "click" && event.button === "left" && !event.alt) {
			const idx = this.rowAt(event.y);
			if (idx >= 0) {
				this.selected = idx;
				return { handled: true };
			}
		}
		return undefined;
	}

	handleInput(data: string): void {
		const d = this.deps;
		const max = Math.max(0, this.rows.length - 1);
		const move = (delta: number) => this.moveBy(delta);
		if (matchesKey(data, Key.up) || data === "k") move(-1);
		else if (matchesKey(data, Key.down) || data === "j") move(1);
		else if (matchesKey(data, Key.pageUp) || data === "\x02") move(-this.pageSize()); // ctrl-b
		else if (matchesKey(data, Key.pageDown) || data === "\x06") move(this.pageSize()); // ctrl-f
		else if (matchesKey(data, Key.home)) {
			this.selected = 0;
			d.tui.requestRender();
		} else if (matchesKey(data, Key.end) || data === "G") {
			this.selected = max;
			d.tui.requestRender();
		} else if (data === "f") {
			this.filter = FILTER_MODES[(FILTER_MODES.indexOf(this.filter) + 1) % FILTER_MODES.length];
			this.rebuild(this.rows[this.selected]?.node?.entry.id);
			d.tui.requestRender();
		} else if (matchesKey(data, Key.enter)) {
			const row = this.rows[this.selected];
			if (row?.node) void d.onJump(row.node.entry.id);
		} else if (data === "g") {
			const row = this.rows[this.selected];
			let restore = row?.node ? describeEntry(row.node).restore : undefined;
			if (!restore && row?.badges?.length) restore = row.badges[row.badges.length - 1]; // 吸收的快照：恢复最新
			if (restore) void d.onRestore(restore);
		} else if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) {
			d.onClose();
		}
	}

	invalidate(): void {
		// 每次 render 重建，无缓存，无需处理
	}
}

// ---------- 命令注册 ----------

export default function (pi: ExtensionAPI) {
	let activeSession = false;
	pi.on("session_start", (_event, ctx) => {
		activeSession = false;
		try { execGit(["-C", ctx.cwd, "rev-parse", "--show-toplevel"]); activeSession = true; }
		catch { activeSession = false; }
	});
	pi.on("session_shutdown", () => { activeSession = false; });
	const openTree = async (_args: string, ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) return;
			if (!activeSession) { ctx.ui.notify("Tree graph is inactive outside Git sessions.", "info"); return; }
			const sm = ctx.sessionManager;
			const tree = sm.getTree();
			const leafId = sm.getLeafId();
			const entries = sm.getEntries();

			let sessionName = "";
			for (const e of entries) {
				if (e.type === "session_info" && e.name) sessionName = e.name;
			}

			let branch = "";
			try {
				const b = execGit(["-C", ctx.cwd, "rev-parse", "--abbrev-ref", "HEAD"] ).trim();
				if (b && b !== "HEAD") branch = b;
			} catch {
				branch = "";
			}

			await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
				const view = new TreeGraphView({
					tree,
					leafId,
					sessionName,
					branch,
					// SAFETY: Pi supplies the theme interface expected by the view; ThemeLike narrows only its used methods.
					theme: theme as unknown as ThemeLike,
					tui,
					onJump: async (entryId) => {
						done(null); // 先关闭视图
						try {
							await ctx.navigateTree(entryId);
							ctx.ui.notify("已跳转到所选节点", "info");
						} catch (err) {
							ctx.ui.notify(`跳转失败: ${err instanceof Error ? err.message : String(err)}`, "error");
						}
					},
					onRestore: async (data) => {
						if (!checkpointRefIsSafe(data)) {
							ctx.ui.notify("Refusing restore: this is not a verified shadow checkpoint.", "warning");
							return;
						}
						const ok = await ctx.ui.confirm(
							"恢复代码快照",
							`将 ${data.label} 恢复到 ${data.hash}（${oneLine(data.message ?? "", 40)}）？\n覆盖已跟踪文件的当前内容；快照后新建的文件不会被删除。`,
						);
						if (!ok) return;
						try {
							execGit(["--git-dir", data.gitDir!, "--work-tree", data.worktree, "-c", "core.hooksPath=/dev/null", "checkout", data.hash, "--", "."], 20000);
							ctx.ui.notify(`✅ ${data.label} 已恢复到 ${data.hash}`, "info");
						} catch (err) {
							ctx.ui.notify(`恢复失败: ${err instanceof Error ? err.message : String(err)}`, "error");
						}
					},
					onClose: () => done(null),
				});
				return view;
			});
		};
		pi.registerCommand("tree-graph", {
			description: "可视化会话树（分叉连线 + git-checkpoint 快照恢复）",
			handler: openTree,
		});
		pi.registerCommand("tg", {
			description: "别名 /tree-graph",
			handler: openTree,
		});
}