import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canTransition } from "../extensions/workflow-core.ts";

const workflow = JSON.parse(await readFile(new URL("../examples/simple.workflow.json", import.meta.url), "utf8"));

test("example workflow has a valid entry node", () => {
  assert.equal(typeof workflow.entry, "string");
  assert.ok(workflow.nodes[workflow.entry], `missing entry node ${workflow.entry}`);
});

test("example workflow edges point to declared static nodes", () => {
  for (const [nodeName, node] of Object.entries(workflow.nodes)) {
    assert.ok(Array.isArray(node.allowedTools), `${nodeName}.allowedTools must be an array`);
    assert.ok(Array.isArray(node.next), `${nodeName}.next must be an array`);
    for (const target of node.next) {
      assert.ok(workflow.nodes[target], `${nodeName} points to missing node ${target}`);
    }
  }
});

test("example workflow runner declares a non-empty command", () => {
  assert.equal(workflow.runner.type, "command");
  assert.ok(Array.isArray(workflow.runner.command));
  assert.ok(workflow.runner.command.length > 0);
});

test("example workflow finish nodes are declared", () => {
  assert.ok(Array.isArray(workflow.finish));
  for (const nodeName of workflow.finish) {
    assert.ok(workflow.nodes[nodeName], `missing finish node ${nodeName}`);
  }
});

test("dynamic join rejects an early transition even when the template has a static edge to the join", () => {
  const state = {
    active: true,
    workflow: "simple",
    currentNode: "process_item:alpha",
    available: ["process_item:beta", "process_item:gamma"],
    completed: ["fanout_items"],
    dynamicGroups: {
      items: {
        template: "process_item",
        items: ["alpha", "beta", "gamma"],
        join: "join_items",
        nodes: ["process_item:alpha", "process_item:beta", "process_item:gamma"]
      }
    }
  };

  const result = canTransition(workflow, state, "join_items");

  assert.equal(result.ok, false);
  assert.match(result.reason, /Pending dynamic join nodes: process_item:beta, process_item:gamma/);
});

test("dynamic join allows the final branch to transition to the join", () => {
  const state = {
    active: true,
    workflow: "simple",
    currentNode: "process_item:gamma",
    available: [],
    completed: ["fanout_items", "process_item:alpha", "process_item:beta"],
    dynamicGroups: {
      items: {
        template: "process_item",
        items: ["alpha", "beta", "gamma"],
        join: "join_items",
        nodes: ["process_item:alpha", "process_item:beta", "process_item:gamma"]
      }
    }
  };

  assert.deepEqual(canTransition(workflow, state, "join_items"), { ok: true });
});
