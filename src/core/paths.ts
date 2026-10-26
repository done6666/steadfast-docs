import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** True when `candidate` resolves to `root` or a path inside it. */
export function insideRoot(root: string, candidate: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

/**
 * Resolves a repo-relative path, rejects absolute/UNC/drive forms and `..`,
 * and requires a regular file whose real path stays inside the project.
 */
export function safeFile(root: string, relativePath: string): string | undefined {
  if (
    relativePath.length === 0 ||
    relativePath.includes("..") ||
    /^[\\/]/.test(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  const candidate = resolve(root, relativePath);
  try {
    if (!statSync(candidate).isFile()) return undefined;
  } catch {
    return undefined;
  }

  return insideRoot(root, candidate) ? candidate : undefined;
}

export function relativeInside(root: string, candidate: string): string | undefined {
  const value = relative(root, candidate).replace(/\\/g, "/");
  if (value.length === 0 || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    return undefined;
  }
  return value;
}
