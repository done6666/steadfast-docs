import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph } from "../src/core/graph.js";
import type { Decision } from "../src/types.js";

const HASH = `h1:${"a".repeat(64)}`;

function decision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    topic: `topic-${id.toLowerCase()}`,
    scope: "billing",
    status: "active",
    created: "2026-10-26",
    applies_to: ["src/billing/**"],
    decision: `rule ${id}`,
    verified_by: HASH,
    by: "agent",
    ...overrides,
  };
}

function files(decisions: Decision[]): Map<string, string> {
  return new Map(decisions.map((d) => [d.id, `.steadfast/decisions/${d.id}.yaml`]));
}

test("supersede chains resolve to the newest rule", () => {
  const decisions = [
    decision("ADR-0001", { topic: "http-client" }),
    decision("ADR-0002", { topic: "http-client", supersedes: ["ADR-0001"] }),
    decision("ADR-0003", { topic: "http-client", supersedes: ["ADR-0002"] }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.equal(graph.resolved.get("ADR-0001"), "superseded");
  assert.equal(graph.resolved.get("ADR-0002"), "superseded");
  assert.equal(graph.resolved.get("ADR-0003"), "active");
  assert.deepEqual(graph.issues, []);
});

test("a record has exactly one successor", () => {
  const decisions = [
    decision("ADR-0001", { topic: "http-client" }),
    decision("ADR-0002", { topic: "http-client", supersedes: ["ADR-0001"] }),
    decision("ADR-0003", { topic: "http-client", supersedes: ["ADR-0001"] }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.ok(graph.issues.some((issue) => issue.code === "graph/double-supersede"));
});

test("cycles are rejected", () => {
  const decisions = [
    decision("ADR-0001", { topic: "http-client", supersedes: ["ADR-0002"] }),
    decision("ADR-0002", { topic: "http-client", supersedes: ["ADR-0001"] }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.ok(graph.issues.some((issue) => issue.code === "graph/cycle"));
});

test("only active records can be superseded", () => {
  const decisions = [
    decision("ADR-0001", {
      topic: "http-client",
      status: "rejected",
      why: ["no"],
      verified_by: undefined,
    }),
    decision("ADR-0002", { topic: "http-client", supersedes: ["ADR-0001"] }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.ok(graph.issues.some((issue) => issue.code === "graph/inactive-target"));
});

test("drafts cannot supersede", () => {
  const decisions = [
    decision("ADR-0001", { topic: "http-client" }),
    decision("ADR-0002", {
      topic: "http-client",
      status: "draft",
      verified_by: undefined,
      supersedes: ["ADR-0001"],
    }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.ok(graph.issues.some((issue) => issue.code === "graph/inactive-supersede"));
});

test("missing supersede targets are reported", () => {
  const decisions = [decision("ADR-0001", { supersedes: ["ADR-9999"] })];
  const graph = buildGraph(decisions, files(decisions));
  assert.ok(graph.issues.some((issue) => issue.code === "graph/missing-target"));
});

test("one active decision per scope and topic", () => {
  const decisions = [
    decision("ADR-0001", { topic: "http-client" }),
    decision("ADR-0002", { topic: "http-client" }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.ok(graph.issues.some((issue) => issue.code === "graph/duplicate-topic"));
});

test("a superseded record frees its topic", () => {
  const decisions = [
    decision("ADR-0001", { topic: "http-client" }),
    decision("ADR-0002", { topic: "http-client", supersedes: ["ADR-0001"] }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.equal(graph.issues.length, 0);
  assert.equal(graph.resolved.get("ADR-0002"), "active");
});

test("a successor must replace the same scope and topic", () => {
  const decisions = [
    decision("ADR-0001", { topic: "http-client" }),
    decision("ADR-0002", { topic: "logging", supersedes: ["ADR-0001"] }),
  ];
  const graph = buildGraph(decisions, files(decisions));
  assert.ok(graph.issues.some((issue) => issue.code === "graph/supersede-mismatch"));
  assert.equal(graph.resolved.get("ADR-0001"), "active");
});
