import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

interface WorkflowRunner {
	type: "command";
	/** Command argv with placeholders: {node}, {template}, {item}, {runDir}, {cwd}. First element is executable. */
	command: string[];
	/** Extra argv appended only when {item} is present. */
	itemArgs?: string[];
	/** Optional working directory. Defaults to project cwd. Supports placeholders. */
	cwd?: string;
}

interface WorkflowNode {
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

interface WorkflowConfig {
	entry: string;
	finish?: string[];
	/** Optional default runner used by workflow_run_node. */
	runner?: WorkflowRunner;
	nodes: Record<string, WorkflowNode>;
}

interface DynamicGroup {
	template: string;
	items: string[];
	join: string;
	nodes: string[];
}

interface WorkflowState {
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

const CONFIG_DIR = ".pi/workflows";
const STATE_FILE_PREFIX = ".state";
const TRANSITION_TOOL = "workflow_transition";
const FANOUT_TOOL = "workflow_fanout";
const WORKFLOW_RUN_NODE_TOOL = "workflow_run_node";

function uniq(values: string[]): string[] {
	return [...new Set(values)];
}

function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "§§DOUBLE_STAR§§")
		.replace(/\*/g, "[^/]*")
		.replace(/§§DOUBLE_STAR§§/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function matchesAny(value: string, patterns?: string[]): boolean {
	if (!patterns || patterns.length === 0) return false;
	return patterns.some((p) => patternToRegExp(p).test(value));
}

function normalizeProjectPath(ctx: ExtensionContext, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string") return undefined;
	const rel = relative(ctx.cwd, inputPath.startsWith("/") ? inputPath : join(ctx.cwd, inputPath));
	return rel.startsWith("..") ? inputPath : rel || ".";
}

function getToolPath(toolName: string, input: Record<string, unknown>): unknown {
	if (["read", "write", "edit", "ls"].includes(toolName)) return input.path;
	if (["grep", "find"].includes(toolName)) return input.path ?? input.cwd ?? input.directory;
	return undefined;
}

function isVirtualNode(nodeName: string): boolean {
	return nodeName.includes(":");
}

function virtualTemplate(nodeName: string): string {
	return nodeName.split(":", 1)[0];
}

function resolveNode(workflow: WorkflowConfig, nodeName: string): WorkflowNode | undefined {
	return workflow.nodes[nodeName] ?? (isVirtualNode(nodeName) ? workflow.nodes[virtualTemplate(nodeName)] : undefined);
}

function loadWorkflow(ctx: ExtensionContext, name: string): WorkflowConfig {
	const path = join(ctx.cwd, CONFIG_DIR, `${name}.workflow.json`);
	if (!existsSync(path)) throw new Error(`Workflow not found: ${path}`);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkflowConfig;
	validateWorkflow(parsed, name);
	return parsed;
}

function validateRunner(runner: WorkflowRunner | undefined, label: string): void {
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

function validateWorkflow(workflow: WorkflowConfig, name = "workflow"): void {
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

function normalizeState(state: WorkflowState): WorkflowState {
	state.available = uniq(state.available ?? []);
	state.completed = uniq(state.completed ?? []);
	state.dynamicGroups = state.dynamicGroups ?? {};
	return state;
}

function statePath(ctx: ExtensionContext): string {
	const rawSessionId = ctx.sessionManager.getSessionId() || "default";
	const sessionId = rawSessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return join(ctx.cwd, CONFIG_DIR, `${STATE_FILE_PREFIX}.${sessionId}.json`);
}

function loadState(ctx: ExtensionContext): WorkflowState | undefined {
	const path = statePath(ctx);
	if (!existsSync(path)) return undefined;
	try {
		return normalizeState(JSON.parse(readFileSync(path, "utf8")) as WorkflowState);
	} catch {
		return undefined;
	}
}

function saveState(ctx: ExtensionContext, state: WorkflowState): void {
	mkdirSync(join(ctx.cwd, CONFIG_DIR), { recursive: true });
	writeFileSync(statePath(ctx), JSON.stringify(normalizeState(state), null, 2));
}

function pendingForGroup(state: WorkflowState, group: DynamicGroup): string[] {
	const completed = new Set(state.completed ?? []);
	return group.nodes.filter((n) => !completed.has(n));
}

function refreshJoinAvailability(state: WorkflowState): void {
	const available = new Set(state.available ?? []);
	for (const group of Object.values(state.dynamicGroups ?? {})) {
		if (pendingForGroup(state, group).length === 0) available.add(group.join);
	}
	state.available = [...available];
}

function markCompleted(state: WorkflowState, nodeName: string): void {
	if (!nodeName) return;
	state.completed = uniq([...(state.completed ?? []), nodeName]);
	state.available = (state.available ?? []).filter((n) => n !== nodeName);
	refreshJoinAvailability(state);
}

function nodeSummary(workflow: WorkflowConfig, nodeName: string, state?: WorkflowState): string {
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

function canTransition(workflow: WorkflowConfig, state: WorkflowState, target: string): { ok: true } | { ok: false; reason: string } {
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

function splitRuntimeNode(nodeName: string): { template: string; item: string } {
	const [template, item = ""] = nodeName.split(":", 2);
	return { template, item };
}

function renderTemplate(value: string, vars: Record<string, string>): string {
	return value.replace(/\{(node|template|item|runDir|cwd)\}/g, (_match, key: string) => vars[key] ?? "");
}

function resolveRunner(workflow: WorkflowConfig, node: WorkflowNode): WorkflowRunner | undefined {
	return node.runner ?? workflow.runner;
}

function buildRunnerCommand(runner: WorkflowRunner, vars: Record<string, string>): { command: string; args: string[]; cwd?: string } {
	const renderedCommand = runner.command.map((part) => renderTemplate(part, vars));
	if (vars.item && runner.itemArgs?.length) renderedCommand.push(...runner.itemArgs.map((part) => renderTemplate(part, vars)));
	const command = renderedCommand[0];
	if (!command) throw new Error("runner.command must not be empty");
	const args = renderedCommand.slice(1);
	return { command, args, cwd: runner.cwd ? renderTemplate(runner.cwd, vars) : undefined };
}

export default function workflowGuard(pi: ExtensionAPI) {
	let state: WorkflowState | undefined;
	let workflow: WorkflowConfig | undefined;

	function setStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("workflow", state?.active ? `wf:${state.workflow}/${state.currentNode}` : "wf:off");
	}

	function refresh(ctx: ExtensionContext) {
		state = loadState(ctx);
		if (state?.active) {
			workflow = loadWorkflow(ctx, state.workflow);
			if (!resolveNode(workflow, state.currentNode)) {
				state.currentNode = workflow.entry;
				saveState(ctx, state);
			}
			refreshJoinAvailability(state);
		} else {
			workflow = undefined;
		}
		setStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => refresh(ctx));

	pi.registerCommand("workflow", {
		description: "Manage strict workflow guard: start/status/goto/reset/graph",
		getArgumentCompletions: (prefix) => {
			const values = ["start", "status", "goto", "reset", "graph"];
			return values.filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const [cmd = "status", arg = "default"] = args.trim().split(/\s+/).filter(Boolean);

			if (cmd === "start") {
				workflow = loadWorkflow(ctx, arg);
				state = { active: true, workflow: arg, currentNode: workflow.entry, available: [], completed: [], dynamicGroups: {} };
				saveState(ctx, state);
				setStatus(ctx);
				ctx.ui.notify(`Started workflow '${arg}' at node '${state.currentNode}'`, "info");
				return;
			}

			if (cmd === "reset") {
				state = { active: false, workflow: state?.workflow ?? "default", currentNode: "", available: [], completed: [], dynamicGroups: {} };
				workflow = undefined;
				saveState(ctx, state);
				setStatus(ctx);
				ctx.ui.notify("Workflow guard disabled", "info");
				return;
			}

			refresh(ctx);
			if (!state?.active || !workflow) {
				ctx.ui.notify("No active workflow. Use /workflow start default", "info");
				return;
			}

			if (cmd === "goto") {
				const target = arg;
				if (!resolveNode(workflow, target)) {
					ctx.ui.notify(`Unknown workflow node '${target}'`, "error");
					return;
				}
				state.currentNode = target;
				saveState(ctx, state);
				setStatus(ctx);
				ctx.ui.notify(`Workflow node set to '${target}'`, "info");
				return;
			}

			if (cmd === "graph") {
				const staticGraph = Object.entries(workflow.nodes).map(([name, node]) => `${name} -> ${node.next.join(", ") || "∅"}`);
				const dynamicGraph = Object.entries(state.dynamicGroups ?? {}).map(([name, group]) => `${name}: ${group.nodes.join(", ")} -> ${group.join}`);
				ctx.ui.notify([...staticGraph, ...dynamicGraph].join("\n"), "info");
				return;
			}

			ctx.ui.notify(`Workflow '${state.workflow}' active\n${nodeSummary(workflow, state.currentNode, state)}`, "info");
		},
	});

	pi.registerTool({
		name: TRANSITION_TOOL,
		label: "Workflow Transition",
		description: "Move to an allowed next workflow node. Supports runtime fan-out branch nodes created by workflow_fanout.",
		promptSnippet: "Move between strict workflow nodes using only configured graph edges",
		promptGuidelines: [
			"Use workflow_transition to move to another workflow node before using tools that are not allowed in the current node.",
			"A transition out of a node marks that node completed.",
			"Runtime fan-out branches may be entered in any order from the available list; their join becomes available only after all branches complete.",
			"Never claim the workflow node changed unless workflow_transition succeeded.",
		],
		parameters: Type.Object({
			target: Type.String({ description: "Target workflow node. Dynamic branch format is template:item, e.g. write_mr_section:MR_A" }),
			reason: Type.String({ description: "Why this transition is needed" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			refresh(ctx);
			if (!state?.active || !workflow) {
				return { content: [{ type: "text", text: "No active workflow. Ask the user to run /workflow start default." }], isError: true };
			}

			const check = canTransition(workflow, state, params.target);
			if (!check.ok) {
				return { content: [{ type: "text", text: check.reason }], isError: true, details: { from: state.currentNode, target: params.target } };
			}

			markCompleted(state, state.currentNode);
			state.currentNode = params.target;
			state.available = (state.available ?? []).filter((n) => n !== params.target);
			saveState(ctx, state);
			setStatus(ctx);
			return {
				content: [{ type: "text", text: `Transitioned to '${params.target}'.\n${nodeSummary(workflow, params.target, state)}` }],
				details: { target: params.target, reason: params.reason },
			};
		},
	});

	pi.registerTool({
		name: WORKFLOW_RUN_NODE_TOOL,
		label: "Workflow Run Node",
		description: "Run the configured business implementation for the current workflow node.",
		promptSnippet: "Run the current workflow node with the workflow-configured runner",
		promptGuidelines: [
			"Use workflow_run_node only when the current workflow node allows it.",
			"The node parameter must exactly equal the current workflow node, including dynamic branch suffixes such as write_mr_section:MR_A.",
			"The command is configured by the active .workflow.json runner; this tool is business-domain agnostic.",
		],
		parameters: Type.Object({
			node: Type.String({ description: "Workflow node to run. Must equal current node, e.g. load_minutes or write_mr_section:MR_A" }),
			runDir: Type.String({ description: "Run/workspace directory passed to the runner as {runDir}" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			refresh(ctx);
			if (!state?.active || !workflow) {
				return { content: [{ type: "text", text: "No active workflow. Ask the user to run /workflow start <name>." }], isError: true };
			}
			const current = resolveNode(workflow, state.currentNode);
			if (!current?.allowedTools.includes(WORKFLOW_RUN_NODE_TOOL)) {
				return { content: [{ type: "text", text: `Node '${state.currentNode}' does not allow ${WORKFLOW_RUN_NODE_TOOL}.` }], isError: true };
			}
			if (params.node !== state.currentNode) {
				return { content: [{ type: "text", text: `Refusing to run '${params.node}' while current workflow node is '${state.currentNode}'.` }], isError: true };
			}

			const { template, item } = splitRuntimeNode(params.node);
			if (!workflow.nodes[template]) {
				return { content: [{ type: "text", text: `Unknown workflow node template '${template}'.` }], isError: true };
			}
			const runner = resolveRunner(workflow, current);
			if (!runner) {
				return { content: [{ type: "text", text: `No runner configured for workflow '${state.workflow}' node '${state.currentNode}'.` }], isError: true };
			}

			const vars = { node: params.node, template, item, runDir: params.runDir, cwd: ctx.cwd };
			const commandSpec = buildRunnerCommand(runner, vars);
			const result = spawnSync(commandSpec.command, commandSpec.args, {
				cwd: commandSpec.cwd || ctx.cwd,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			});

			const command = [commandSpec.command, ...commandSpec.args].map((a) => JSON.stringify(a)).join(" ");
			const stdout = result.stdout?.trim() ? `\nstdout:\n${result.stdout.trim()}` : "";
			const stderr = result.stderr?.trim() ? `\nstderr:\n${result.stderr.trim()}` : "";
			if (result.error) {
				return { content: [{ type: "text", text: `Failed to run workflow node.\ncommand: ${command}\nerror: ${result.error.message}${stdout}${stderr}` }], isError: true };
			}
			if (result.status !== 0) {
				return { content: [{ type: "text", text: `Workflow node exited with code ${result.status}.\ncommand: ${command}${stdout}${stderr}` }], isError: true, details: { status: result.status, signal: result.signal } };
			}

			return {
				content: [{ type: "text", text: `Workflow node '${params.node}' completed.\ncommand: ${command}${stdout}${stderr}` }],
				details: { node: params.node, template, item, runDir: params.runDir, status: result.status },
			};
		},
	});

	pi.registerTool({
		name: FANOUT_TOOL,
		label: "Workflow Fan-out",
		description: "Create runtime parallel branch nodes from data discovered during the workflow, such as MR ids returned by fetch_nsdp.",
		promptSnippet: "Create dynamic workflow branches for a runtime fan-out",
		promptGuidelines: [
			"Use workflow_fanout only in nodes whose allowedTools include workflow_fanout.",
			"Use stable, concise item ids because branch node names are template:item.",
			"After fan-out, enter available branch nodes with workflow_transition; the join node is blocked until all branch nodes are completed.",
		],
		parameters: Type.Object({
			group: Type.String({ description: "Fan-out group name, e.g. mrs" }),
			template: Type.String({ description: "Template workflow node to clone, e.g. write_mr_section" }),
			items: Type.Array(Type.String(), { description: "Runtime items. Creates one branch node per item: template:item" }),
			join: Type.String({ description: "Join node to unlock after all generated branches complete" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			refresh(ctx);
			if (!state?.active || !workflow) {
				return { content: [{ type: "text", text: "No active workflow. Ask the user to run /workflow start default." }], isError: true };
			}
			const current = resolveNode(workflow, state.currentNode);
			if (!current?.allowedTools.includes(FANOUT_TOOL)) {
				return { content: [{ type: "text", text: `Node '${state.currentNode}' does not allow ${FANOUT_TOOL}.` }], isError: true };
			}
			if (!workflow.nodes[params.template]) {
				return { content: [{ type: "text", text: `Unknown fan-out template node '${params.template}'.` }], isError: true };
			}
			if (!workflow.nodes[params.join]) {
				return { content: [{ type: "text", text: `Unknown fan-out join node '${params.join}'.` }], isError: true };
			}
			const items = uniq(params.items).filter(Boolean);
			if (items.length === 0) {
				return { content: [{ type: "text", text: "Fan-out items must not be empty." }], isError: true };
			}

			const nodes = items.map((item) => `${params.template}:${item}`);
			state.dynamicGroups = state.dynamicGroups ?? {};
			state.dynamicGroups[params.group] = { template: params.template, items, join: params.join, nodes };
			state.available = uniq([...(state.available ?? []), ...nodes]);
			state.available = state.available.filter((n) => n !== params.join);
			saveState(ctx, state);
			setStatus(ctx);
			return {
				content: [{ type: "text", text: `Created fan-out group '${params.group}':\n${nodes.join("\n")}\nJoin: ${params.join}` }],
				details: { group: params.group, nodes, join: params.join },
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refresh(ctx);
		if (!state?.active || !workflow) return;
		const current = resolveNode(workflow, state.currentNode);
		if (!current) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n# Strict Workflow Guard\n` +
				`An extension enforces a LangGraph-like workflow. Current workflow: ${state.workflow}.\n` +
				`${nodeSummary(workflow, state.currentNode, state)}\n` +
				`You may only call tools in allowedTools for the current node. To move nodes, call ${TRANSITION_TOOL}. ` +
				`Only these static transitions are currently legal: ${current.next.join(", ") || "none"}. ` +
				`Runtime available nodes: ${(state.available ?? []).join(", ") || "none"}. ` +
				`If a needed tool is blocked, transition to a node where that tool is allowed instead of retrying illegally.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		refresh(ctx);
		if (!state?.active || !workflow) return;
		const node = resolveNode(workflow, state.currentNode);
		if (!node) return { block: true, reason: `Unknown workflow node '${state.currentNode}'` };

		if (!node.allowedTools.includes(event.toolName)) {
			return { block: true, reason: `Workflow node '${state.currentNode}' allows only: ${node.allowedTools.join(", ") || "none"}` };
		}

		const input = event.input as Record<string, unknown>;
		if (event.toolName === "bash") {
			const command = typeof input.command === "string" ? input.command : "";
			if (matchesAny(command, node.bashDenylist)) return { block: true, reason: `Command denied in node '${state.currentNode}': ${command}` };
			if (node.bashAllowlist?.length && !matchesAny(command, node.bashAllowlist)) {
				return { block: true, reason: `Command not in bashAllowlist for node '${state.currentNode}': ${command}` };
			}
		}

		const relPath = normalizeProjectPath(ctx, getToolPath(event.toolName, input));
		if (relPath) {
			const allowlist = event.toolName === "read" ? node.readAllowlist : event.toolName === "write" ? node.writeAllowlist : event.toolName === "edit" ? node.editAllowlist : node.pathAllowlist;
			if (matchesAny(relPath, node.pathDenylist)) return { block: true, reason: `Path denied in node '${state.currentNode}': ${relPath}` };
			if (allowlist?.length && !matchesAny(relPath, allowlist)) return { block: true, reason: `Path not allowed in node '${state.currentNode}': ${relPath}` };
		}
	});
}
