# pi-langgraph-workflow

A generic workflow guard extension for [Pi](https://pi.dev) that implements **LangGraph-like workflows** for coding-agent sessions.

It lets teams define project-local workflow graphs in JSON and then constrain the agent to move through those graphs with explicit transitions, joins, dynamic fan-out branches, and configurable node runners.

## What it adds

Commands:

- `/workflow start <name>` — start `.pi/workflows/<name>.workflow.json`
- `/workflow status` — show the current session's workflow state
- `/workflow graph` — show static and runtime graph edges
- `/workflow goto <node>` — manually set the current node
- `/workflow reset` — disable the workflow guard for the current session

Tools:

- `workflow_transition` — move to an allowed next node
- `workflow_fanout` — create runtime branch nodes, similar to LangGraph `Send`
- `workflow_run_node` — run the current node with the command configured in the workflow file

## Install

Global:

```bash
pi install npm:pi-langgraph-workflow
```

Project-local:

```bash
pi install -l npm:pi-langgraph-workflow
```

Then restart Pi or run:

```text
/reload
```

## Workflow files

Put workflows in your project:

```text
.pi/workflows/<name>.workflow.json
```

Start one:

```text
/workflow start <name>
```

Runtime state is session-scoped and stored under:

```text
.pi/workflows/.state.<sessionId>.json
```

Add this to your project `.gitignore`:

```gitignore
.pi/workflows/.state*.json
```

## Minimal workflow

```json
{
  "entry": "build",
  "finish": ["done"],
  "runner": {
    "type": "command",
    "command": ["npm", "run", "workflow", "--", "{template}", "--run-dir", "{runDir}"],
    "itemArgs": ["--item", "{item}"]
  },
  "nodes": {
    "build": {
      "description": "Build the project",
      "allowedTools": ["workflow_run_node", "workflow_transition"],
      "next": ["done"]
    },
    "done": {
      "description": "Workflow complete",
      "allowedTools": ["workflow_transition"],
      "next": []
    }
  }
}
```

## Example workflow

This package includes a safe example at:

```text
examples/simple.workflow.json
```

Copy it into your project:

```bash
mkdir -p .pi/workflows
cp path/to/pi-langgraph-workflow/examples/simple.workflow.json .pi/workflows/simple.workflow.json
```

Start it:

```text
/workflow start simple
```

Run the first node with `workflow_run_node`:

```json
{
  "node": "discover",
  "runDir": "runs/simple-demo"
}
```

Then transition:

```json
{
  "target": "plan",
  "reason": "discovery completed"
}
```

At `fanout_items`, create dynamic branches:

```json
{
  "group": "items",
  "template": "process_item",
  "items": ["alpha", "beta", "gamma"],
  "join": "join_items"
}
```

This creates runtime nodes:

```text
process_item:alpha
process_item:beta
process_item:gamma
```

After all branch nodes complete, `join_items` becomes available.

The example runner writes a log to:

```text
runs/simple-demo/workflow.log
```

## Runner placeholders

`workflow_run_node` expands these placeholders in `runner.command`, `runner.itemArgs`, and `runner.cwd`:

- `{node}` — full current node, e.g. `process_item:alpha`
- `{template}` — template part before `:`, e.g. `process_item`
- `{item}` — dynamic item part after `:`, e.g. `alpha`
- `{runDir}` — `runDir` passed to `workflow_run_node`
- `{cwd}` — current project directory

Node-level `runner` overrides workflow-level `runner`.

## Notes

This is a workflow guard, not a distributed executor. It enforces LangGraph-like control-flow semantics for a Pi session. Dynamic branches can be completed in any order, but Pi does not automatically spawn multiple workers for them.
