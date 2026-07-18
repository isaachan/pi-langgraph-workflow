import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
