import { resolve } from "node:path";
import { findProjectRoot } from "../core/store.js";

export function resolveExistingRoot(input?: string): string | undefined {
  return findProjectRoot(input === undefined ? process.cwd() : resolve(input));
}
