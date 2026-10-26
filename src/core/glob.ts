import { stripDotSlash, toPosix } from "../util.js";

export function normalizePath(path: string): string {
  return stripDotSlash(toPosix(path));
}

/** Single-segment match with a linear two-pointer scan (`*`, `?`). */
function segmentMatch(pattern: string, segment: string): boolean {
  let patternIndex = 0;
  let segmentIndex = 0;
  let star = -1;
  let mark = 0;

  while (segmentIndex < segment.length) {
    if (
      patternIndex < pattern.length &&
      (pattern[patternIndex] === "?" || pattern[patternIndex] === segment[segmentIndex])
    ) {
      patternIndex += 1;
      segmentIndex += 1;
      continue;
    }
    if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      star = patternIndex;
      patternIndex += 1;
      mark = segmentIndex;
      continue;
    }
    if (star !== -1) {
      patternIndex = star + 1;
      mark += 1;
      segmentIndex = mark;
      continue;
    }
    return false;
  }

  while (patternIndex < pattern.length && pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function segments(path: string): string[] {
  return stripDotSlash(toPosix(path))
    .split("/")
    .filter((part) => part.length > 0);
}

/**
 * Segment-based glob matcher. `**` spans directories, `*` and `?` stay inside
 * one segment. Linear in the number of segments and characters: no regex, no
 * catastrophic backtracking.
 */
export function matchGlob(path: string, glob: string): boolean {
  const target = segments(path);
  const pattern = segments(glob);
  if (pattern.length === 0) return target.length === 0;

  const memo = new Map<string, boolean>();

  const walk = (patternIndex: number, targetIndex: number): boolean => {
    const key = `${patternIndex}:${targetIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result = false;
    const part = pattern[patternIndex];

    if (patternIndex === pattern.length) {
      result = targetIndex === target.length;
    } else if (part === "**") {
      if (patternIndex === pattern.length - 1) {
        // A trailing ** matches everything below, but not the directory itself.
        result = targetIndex < target.length;
      } else {
        result = walk(patternIndex + 1, targetIndex) || (targetIndex < target.length && walk(patternIndex, targetIndex + 1));
      }
    } else if (targetIndex < target.length && segmentMatch(part!, target[targetIndex]!)) {
      result = walk(patternIndex + 1, targetIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return walk(0, 0);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchGlob(path, glob));
}

/**
 * Higher means more specific. Literal characters count, wildcards cost, and an
 * exact path wins outright. A suffix glob outranks a broad subtree glob.
 */
export function specificity(glob: string): number {
  const wildcards = (glob.match(/[*?]/g) ?? []).length;
  const literal = glob.replace(/[*?]/g, "").length;
  return literal - wildcards + (wildcards === 0 ? 1000 : 0);
}
