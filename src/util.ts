export function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function stripDotSlash(path: string): string {
  return path.replace(/^\.\//, "");
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function shortHash(hash: string): string {
  const value = hash.startsWith("h1:") ? hash.slice(3) : hash;
  return value.slice(0, 8);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}~`;
}
