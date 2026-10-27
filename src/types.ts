export type Status = "active" | "rejected" | "retired" | "draft";
export type ResolvedStatus = Status | "superseded";

export interface Guard {
  deny: string;
  instead: string;
  check?: string;
}

export interface Decision {
  id: string;
  topic: string;
  scope: string;
  status: Status;
  created: string;
  applies_to: string[];
  decision: string;
  why?: string[];
  rejected?: string[];
  guards?: Guard[];
  enforced_by?: string;
  verified_by?: string;
  supersedes?: string[];
  by: "agent" | "human";
}

export interface Invariant {
  id: string;
  rule: string;
  applies_to?: string[];
  enforced_by?: string;
}

export interface Budgets {
  context_tokens: number;
  decision_tokens: number;
  brief_tokens: number;
  finding_tokens: number;
  invariants: number;
  guards: number;
}

export interface Config {
  version: 1;
  budgets: Budgets;
  advisory_ttl_days: number;
  findings_ttl_days: number;
  retired_docs: string[];
}

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
  id?: string;
  fix?: string;
}

export type FindingStatus = "active" | "retracted" | "retired";
export type ResolvedFindingStatus = FindingStatus | "superseded";
export type Confidence = "high" | "medium" | "low";

export interface Finding {
  id: string;
  topic: string;
  scope: string;
  status: FindingStatus;
  target: string;
  claim: string;
  evidence: string;
  confidence: Confidence;
  observed_at: string;
  applies_to: string[];
  why?: string[];
  supersedes?: string[];
  by: "agent" | "human";
}

export interface Loaded {
  root: string;
  config: Config;
  invariants: Invariant[];
  decisions: Decision[];
  findings: Finding[];
  files: Map<string, string>;
  findingFiles: Map<string, string>;
  issues: Issue[];
}

export type StepStatus = "todo" | "current" | "blocked" | "done" | "dropped";

export interface Step {
  id: string;
  goal: string;
  why: string;
  paths: string[];
  acceptance: string;
  status: StepStatus;
  evidence?: string;
  blocked_by?: string;
  decisions?: string[];
  findings?: string[];
}

export interface Roadmap {
  version: 1;
  updated?: string;
  steps: Step[];
}
