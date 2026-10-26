import assert from "node:assert/strict";
import test from "node:test";
import { buildPack } from "../src/core/pack.js";
import type { Decision, Invariant, ResolvedStatus } from "../src/types.js";

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

const invariants: Invariant[] = [
  { id: "INV-001", rule: "Outbound calls are idempotent." },
  { id: "INV-002", rule: "Other subsystem only.", applies_to: ["src/other/**"] },
];

const decisions: Decision[] = [
  decision("ADR-0001", {
    guards: [
      { deny: "src/billing/** fetch|axios", instead: "src/api/client.ts", check: "eslint" },
    ],
    enforced_by: "test/client.test.ts",
  }),
  decision("ADR-0002", { scope: "global", applies_to: ["**"], decision: "No new runtime deps." }),
  decision("ADR-0003", { status: "active" }),
  decision("ADR-0004", {
    status: "rejected",
    decision: "Use p-retry for backoff.",
    why: ["adds a dependency for 20 lines"],
    verified_by: undefined,
  }),
  decision("ADR-0005", {
    topic: "retry",
    enforced_by: "test/retry.test.ts",
  }),
];

const resolved = new Map<string, ResolvedStatus>([
  ["ADR-0001", "active"],
  ["ADR-0002", "active"],
  ["ADR-0003", "superseded"],
  ["ADR-0004", "rejected"],
  ["ADR-0005", "active"],
]);

test("packs contain only decisions that match the target paths", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: ["src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 30,
  });

  assert.match(pack.text, /ADR-0001/);
  assert.match(pack.text, /ADR-0002/);
  assert.match(pack.text, /ADR-0004/);
  assert.match(pack.text, /ADR-0005/);
  assert.doesNotMatch(pack.text, /ADR-0003/);
  assert.match(pack.text, /INV-001/);
  assert.doesNotMatch(pack.text, /INV-002/);
});

test("match paths let a directory selector reach a file rule", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: ["src/billing"],
    matchPaths: ["src/billing", "src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 30,
  });

  assert.match(pack.text, /ADR-0001/);
  assert.match(pack.text, /paths: src\/billing/);
});

test("pack warnings are rendered and reported", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: ["src/unknown.ts"],
    warnings: ['no decision matches "src/unknown.ts"'],
    budget: 1500,
    maxGuards: 30,
  });

  assert.match(pack.text, /# warning: no decision matches "src\/unknown\.ts"/);
  assert.ok(pack.issues.some((issue) => issue.code === "context/no-rule"));
});

test("guards and tests are included", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: ["src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 30,
  });
  assert.match(pack.text, /deny: "src\/billing\/\*\* fetch\|axios"/);
  assert.match(pack.text, /instead: "src\/api\/client.ts"/);
  assert.match(pack.text, /tests:/);
  assert.match(pack.text, /test\/client.test.ts/);
});

test("executable checks are rendered without the ! prefix", () => {
  const executable = decision("ADR-0001", { enforced_by: "!npm test" });
  const localResolved = new Map<string, ResolvedStatus>([["ADR-0001", "active"]]);

  const pack = buildPack([executable], [], localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 30,
  });

  assert.match(pack.text, /verify:/);
  assert.match(pack.text, /- "npm test"/);
  assert.doesNotMatch(pack.text, /"!npm test"/);
});

test("active decisions keep their rejected alternatives", () => {
  const withRejected = decision("ADR-0001", {
    rejected: ["Direct fetch: retries drift per call site."],
  });
  const localResolved = new Map<string, ResolvedStatus>([["ADR-0001", "active"]]);

  const pack = buildPack([withRejected], [], localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 30,
  });

  assert.match(pack.text, /rejected: \["Direct fetch: retries drift per call site\."\]/);
});

test("rejected proposals are surfaced as do-not-revisit", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: ["src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 30,
  });
  assert.match(pack.text, /do_not_revisit:/);
  assert.match(pack.text, /proposal: "Use p-retry for backoff\."/);
  assert.match(pack.text, /because: "adds a dependency for 20 lines"/);
});

test("a different path yields a different pack", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: ["src/other/thing.ts"],
    budget: 1500,
    maxGuards: 30,
  });
  assert.doesNotMatch(pack.text, /ADR-0001/);
  assert.match(pack.text, /ADR-0002/);
  assert.match(pack.text, /INV-002/);
});

test("scope selection includes global rules", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: [],
    scope: "billing",
    budget: 1500,
    maxGuards: 30,
  });
  assert.match(pack.text, /ADR-0001/);
  assert.match(pack.text, /ADR-0002/);
  assert.match(pack.text, /ADR-0005/);
  assert.doesNotMatch(pack.text, /ADR-0003/);
});

test("a selector is mandatory", () => {
  const pack = buildPack(decisions, invariants, resolved, {
    paths: [],
    budget: 1500,
    maxGuards: 30,
  });
  assert.ok(pack.issues.some((issue) => issue.code === "context/no-selector"));
});

test("budgets are hard caps and truncation is reported", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    decision(`ADR-${String(index + 10).padStart(4, "0")}`, {
      topic: `topic-${index}`,
      decision: `A deliberately wordy rule number ${index} that still has to fit the budget.`,
      why: ["Because the budget must be enforced even when the rule is long."],
    }),
  );
  const localResolved = new Map<string, ResolvedStatus>(many.map((d) => [d.id, "active"]));

  const pack = buildPack(many, invariants.slice(0, 1), localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: 260,
    maxGuards: 30,
  });

  assert.ok(pack.tokens <= 260, `tokens ${pack.tokens} exceeded budget`);
  assert.ok(pack.omitted > 0);
  assert.ok(pack.omittedByBudget > 0);
  assert.ok(pack.requiredTokens > 260);
  assert.match(pack.text, /omitted: [1-9]/);
  assert.match(pack.text, /INV-001/);

  const complete = buildPack(many, invariants.slice(0, 1), localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: pack.requiredTokens,
    maxGuards: 30,
  });
  assert.equal(complete.omitted, 0);
});

test("global scope does not bypass applies_to in path mode", () => {
  const local = [
    ...decisions,
    decision("ADR-0006", {
      scope: "global",
      applies_to: ["package.json"],
      decision: "Dependency changes need a decision.",
    }),
  ];
  const localResolved = new Map(resolved);
  localResolved.set("ADR-0006", "active");

  const pack = buildPack(local, invariants, localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 30,
  });

  assert.doesNotMatch(pack.text, /ADR-0006/);
});

test("a pack that cannot fit its invariants fails closed", () => {
  const large: Invariant[] = Array.from({ length: 25 }, (_, index) => ({
    id: `INV-${String(index + 1).padStart(3, "0")}`,
    rule: "x".repeat(160),
  }));

  const pack = buildPack([], large, new Map(), {
    paths: ["src/a.ts"],
    budget: 200,
    maxGuards: 30,
  });

  assert.ok(pack.issues.some((issue) => issue.code === "context/over-budget"));
  assert.ok(pack.tokens > 200);
});

test("dropping a decision drops its guards too", () => {
  const broad = decision("ADR-0009", {
    applies_to: ["**"],
    decision: "Broad rule with a deliberately long sentence so it costs more tokens than the other one.",
    guards: [{ deny: "broad deny", instead: "broad instead" }],
  });
  const specific = decision("ADR-0010", {
    applies_to: ["src/billing/charge.ts"],
    decision: "Specific rule.",
    guards: [{ deny: "specific deny", instead: "specific instead" }],
  });
  const localResolved = new Map<string, ResolvedStatus>([
    ["ADR-0009", "active"],
    ["ADR-0010", "active"],
  ]);

  const pack = buildPack([broad, specific], [], localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: 220,
    maxGuards: 30,
  });

  const parents = new Set(pack.included.decisions);
  for (const guard of pack.included.guards) {
    assert.ok(parents.has(guard.split("#")[0]!), `orphan guard ${guard}`);
  }
  if (pack.included.decisions.length > 0) {
    assert.ok(pack.included.decisions.includes("ADR-0010"));
  }
});

test("the guard cap is enforced and counted", () => {
  const guarded = [
    decision("ADR-0001", {
      guards: [
        { deny: "a", instead: "b" },
        { deny: "c", instead: "d" },
        { deny: "e", instead: "f" },
      ],
    }),
  ];
  const localResolved = new Map<string, ResolvedStatus>([["ADR-0001", "active"]]);
  const pack = buildPack(guarded, [], localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: 1500,
    maxGuards: 1,
  });
  assert.equal(pack.included.guards.length, 1);
  assert.ok(pack.omitted >= 2);
  assert.equal(pack.omittedGuards, 2);
  assert.equal(pack.requiredGuards, 3);
  assert.equal(pack.guardLimit, 1);

  const complete = buildPack(guarded, [], localResolved, {
    paths: ["src/billing/charge.ts"],
    budget: pack.requiredTokens,
    maxGuards: 3,
  });
  assert.equal(complete.omitted, 0);
});
