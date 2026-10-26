import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function canonicalSkillPath(): string {
  return fileURLToPath(new URL("../../../skills/steadfast/SKILL.md", import.meta.url));
}

export function readCanonicalSkill(): string {
  return readFileSync(canonicalSkillPath(), "utf8");
}

export interface SkillTarget {
  platform: "opencode" | "claude";
  path: string;
}

export function skillTarget(
  platform: "opencode" | "claude",
  base: string,
  global = false,
): SkillTarget {
  const directory =
    platform === "opencode"
      ? global
        ? ".config/opencode/skills/steadfast"
        : ".opencode/skills/steadfast"
      : ".claude/skills/steadfast";
  return { platform, path: join(base, directory, "SKILL.md") };
}

export function installedSkillTargets(root: string): SkillTarget[] {
  return (["opencode", "claude"] as const)
    .map((platform) => skillTarget(platform, root))
    .filter((target) => existsSync(target.path));
}
