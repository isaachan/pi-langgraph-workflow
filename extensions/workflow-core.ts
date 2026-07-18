import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export interface WorkflowRunner {
	type: "command";
	/** Command argv with placeholders: {node}, {template}, {item}, {runDir}, {cwd}. First element is executable. */
	command: string[];
	/** Extra argv appended only when {item} is present. */
	itemArgs?: string[];
	/** Optional working directory. Defaults to project cwd. Supports placeholders. */
	cwd?: string;
}

export interface WorkflowNode {
	description?: string;
	allowedTools: string[];
	next: string[];
	/** Optional node-level runner override. Falls back to workflow.runner. */
	runner?: WorkflowRunner;
	/** Static join requirement: target node can be entered only after all listed nodes are completed. */
	waitFor?: string[];
	pathAllowlist?: string[];
	pathDenylist?: string[];
	readAllowlist?: string[];
	writeAllowlist?: string[];
	editAllowlist?: string[];
	bashAllowlist?: string[];
	bashDenylist?: string[];
}

export interface WorkflowConfig {
	entry: string;
	finish?: string[];
	/** Optional default runner used by workflow_run_node. */
	runner?: WorkflowRunner;
	nodes: Record<string, WorkflowNode>;
}

export interface DynamicGroup {
	template: string;
	items: string[];
	join: string;
	nodes: string[];
}

export interface WorkflowState {
	active: boolean;
	workflow: string;
	currentNode: string;
	/** Nodes that can be entered even if they are not in currentNode.next. Used for fork/fan-out branches. */
	available?: string[];
	/** Nodes already completed. A transition out of a node marks it complete. */
	completed?: string[];
	/** Runtime-created fan-out groups, e.g. write_mr_section:<MR id>. */
	dynamicGroups?: Record<string, DynamicGroup>;
}

export const CONFIG_DIR = ".pi/workflows";
export const STATE_FILE_PREFIX = ".state";
export const TRANSITION_TOOL = "workflow_transition";
export const FANOUT_TOOL = "workflow_fanout";
export const WORKFLOW_RUN_NODE_TOOL = "workflow_run_node";

export function uniq(values: string[]): string[] {
	return [...new Set(values)];
}

export function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "§§DOUBLE_STAR§§")
		.replace(/\*/g, "[^/]*")
		.replace(/§§DOUBLE_STAR§§/g, ".*");
	return new RegExp(`^${escaped}$`);
}

export function matchesAny(value: string, patterns?: string[]): boolean {
	if (!patterns || patterns.length === 0) return false;
	return patterns.some((p) => patternToRegExp(p).test(value));
}

export function normalizeProjectPath(ctx: ExtensionContext, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string") return undefined;
	const rel = relative(ctx.cwd, inputPath.startsWith("/") ? inputPath : join(ctx.cwd, inputPath));
	return rel.startsWith("..") ? inputPath : rel || ".";
}

export function getToolPath(toolName: string, input: Record<string, unknown>): unknown {
	if (["read", "write", "edit", "ls"].includes(toolName)) return input.path;
	if (["grep", "find"].includes(toolName)) return input.path ?? input.cwd ?? input.directory;
	return undefined;
}

export function isVirtualNode(nodeName: string): boolean {
	return nodeName.includes(":");
}

export function virtualTemplate(nodeName: string): string {
	return nodeName.split(":", 1)[0];
}

export function resolveNode(workflow: WorkflowConfig, nodeName: string): WorkflowNode | undefined {
	return workflow.nodes[nodeName] ?? (isVirtualNode(nodeName) ? workflow.nodes[virtualTemplate(nodeName)] : undefined);
}

export function loadWorkflow(ctx: ExtensionContext, name: string): WorkflowConfig {
	const path = join(ctx.cwd, CONFIG_DIR, `${name}.workflow.json`);
	if (!existsSync(path)) throw new Error(`Workflow not found: ${path}`);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkflowConfig;
	validateWorkflow(parsed, name);
	return parsed;
}

export function validateRunner(runner: WorkflowRunner | undefined, label: string): void {
	if (runner === undefined) return;
	if (runner.type !== "command") throw new Error(`${label}: runner.type must be 'command'`);
	if (!Array.isArray(runner.command) || runner.command.length === 0 || runner.command.some((v) => typeof v !== "string")) {
		throw new Error(`${label}: runner.command must be a non-empty string array`);
	}
	if (runner.itemArgs !== undefined && (!Array.isArray(runner.itemArgs) || runner.itemArgs.some((v) => typeof v !== "string"))) {
		throw new Error(`${label}: runner.itemArgs must be a string array`);
	}
	if (runner.cwd !== undefined && typeof runner.cwd !== "string") throw new Error(`${label}: runner.cwd must be a string`);
}

export function validateWorkflow(workflow: WorkflowConfig, name = "workflow"): void {
	if (!workflow || typeof workflow !== "object") throw new Error(`${name}: invalid workflow JSON`);
	if (!workflow.entry || typeof workflow.entry !== "string") throw new Error(`${name}: entry must be a string`);
	if (!workflow.nodes || typeof workflow.nodes !== "object") throw new Error(`${name}: nodes must be an object`);
	if (!workflow.nodes[workflow.entry]) throw new Error(`${name}: entry node '${workflow.entry}' is missing`);
	validateRunner(workflow.runner, `${name}`);

	for (const [nodeName, node] of Object.entries(workflow.nodes)) {
		if (!Array.isArray(node.allowedTools)) throw new Error(`${name}: node '${nodeName}' allowedTools must be an array`);
		if (!Array.isArray(node.next)) throw new Error(`${name}: node '${nodeName}' next must be an array`);
		validateRunner(node.runner, `${name}: node '${nodeName}'`);
		if (node.waitFor !== undefined && !Array.isArray(node.waitFor)) throw new Error(`${name}: node '${nodeName}' waitFor must be an array`);
		for (const waitNode of node.waitFor ?? []) {
			if (!workflow.nodes[waitNode] && !isVirtualNode(waitNode)) throw new Error(`${name}: node '${nodeName}' waits for missing node '${waitNode}'`);
		}
		for (const target of node.next) {
			if (!workflow.nodes[target]) throw new Error(`${name}: node '${nodeName}' points to missing node '${target}'`);
		}
	}
}

export function normalizeState(state: WorkflowState): WorkflowState {
	state.available = uniq(state.available ?? []);
	state.completed = uniq(state.completed ?? []);
	state.dynamicGroups = state.dynamicGroups ?? {};
	return state;
}

export function statePath(ctx: ExtensionContext): string {
	const rawSessionId = ctx.sessionManager.getSessionId() || "default";
	const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return join(ctx.cwd, CONFIG_DIR, `${STATE_FILE_PREFIX}.${sessionId}.json`);
}

export function loadState(ctx: ExtensionContext): WorkflowState | undefined {
	const path = statePath(ctx);
	if (!existsSync(path)) return undefined;
	try {
		return normalizeState(JSON.parse(readFileSync(path, "utf8")) as WorkflowState);
	} catch {
		return undefined;
	}
}

export function saveState(ctx: ExtensionContext, state: WorkflowState): void {
	mkdirSync(join(ctx.cwd, CONFIG_DIR), { recursive: true });
	writeFileSync(statePath(ctx), JSON.stringify(normalizeState(state), null, 2));
}

export function pendingForGroup(state: WorkflowState, group: DynamicGroup): string[] {
	const completed = new Set(state.completed ?? []);
	return group.nodes.filter((n) => !completed.has(n));
}

export function refreshJoinAvailability(state: WorkflowState): void {
	const available = new Set(state.available ?? []);
	for (const group of Object.values(state.dynamicGroups ?? {})) {
		if (pendingForGroup(state, group).length === 0) available.add(group.join);
	}
	state.available = [...available];
}

export function markCompleted(state: WorkflowState, nodeName: string): void {
	if (!nodeName) return;
	state.completed = uniq([...(state.completed ?? []), nodeName]);
	state.available = (state.available ?? []).filter((n) => n !== nodeName);
	refreshJoinAvailability(state);
}

export function nodeSummary(workflow: WorkflowConfig, nodeName: string, state?: WorkflowState): string {
	const node = resolveNode(workflow, nodeName);
	if (!node) return `node: ${nodeName}\ndescription: unknown node`;
	const virtual = isVirtualNode(nodeName) ? `template: ${virtualTemplate(nodeName)}` : undefined;
	const runtime = state ? [
		(state.available?.length ? `available: ${state.available.join(", ")}` : undefined),
		(state.completed?.length ? `completed: ${state.completed.join(", ")}` : undefined),
	].filter(Boolean).join("\n") : undefined;
	return [
		`node: ${nodeName}`,
		virtual,
		node.description ? `description: ${node.description}` : undefined,
		`allowedTools: ${node.allowedTools.join(", ") || "(none)"}`,
		`next: ${node.next.join(", ") || "(none)"}`,
		node.waitFor?.length ? `waitFor: ${node.waitFor.join(", ")}` : undefined,
		runtime || undefined,
	].filter(Boolean).join("\n");
}

export function canTransition(workflow: WorkflowConfig, state: WorkflowState, target: string): { ok: true } | { ok: false; reason: string } {
	const current = resolveNode(workflow, state.currentNode);
	if (!current) return { ok: false, reason: `Unknown current node '${state.currentNode}'` };
	const targetNode = resolveNode(workflow, target);
	if (!targetNode) return { ok: false, reason: `Unknown target node '${target}'` };

	const hypotheticalCompleted = new Set([...(state.completed ?? []), state.currentNode]);
	const staticPending = (targetNode.waitFor ?? []).filter((n) => !hypotheticalCompleted.has(n));
	if (staticPending.length > 0) {
		return { ok: false, reason: `Cannot enter '${target}'. Pending static join nodes: ${staticPending.join(", ")}` };
	}

	refreshJoinAvailability(state);
	const available = new Set(state.available ?? []);
	const dynamicJoinReady = Object.values(state.dynamicGroups ?? {}).some((group) => {
		return group.join === target && group.nodes.every((n) => hypotheticalCompleted.has(n));
	});
	if (current.next.includes(target) || available.has(target) || dynamicJoinReady) return { ok: true };

	return {
		ok: false,
		reason: `Illegal transition: ${state.currentNode} -> ${target}. Allowed next: ${current.next.join(", ") || "none"}. Available runtime nodes: ${[...available].join(", ") || "none"}`,
	};
}

export function splitRuntimeNode(nodeName: string): { template: string; item: string } {
	const [template, item = ""] = nodeName.split(":", 2);
	return { template, item };
}

export function renderTemplate(value: string, vars: Record<string, string>): string {
	return value.replace(/\{(node|template|item|runDir|cwd)\}/g, (_match, key: string) => vars[key] ?? "");
}

export function resolveRunner(workflow: WorkflowConfig, node: WorkflowNode): WorkflowRunner | undefined {
	return node.runner ?? workflow.runner;
}

export function buildRunnerCommand(runner: WorkflowRunner, vars: Record<string, string>): { command: string; args: string[]; cwd?: string } {
	const renderedCommand = runner.command.map((part) => renderTemplate(part, vars));
	if (vars.item && runner.itemArgs?.length) renderedCommand.push(...runner.itemArgs.map((part) => renderTemplate(part, vars)));
	const command = renderedCommand[0];
	if (!command) throw new Error("runner.command must not be empty");
	const args = renderedCommand.slice(1);
	return { command, args, cwd: runner.cwd ? renderTemplate(runner.cwd, vars) : undefined };
}
