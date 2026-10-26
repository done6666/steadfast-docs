const enabled =
  Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

function wrap(code: string, text: string): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const paint = {
  red: (text: string) => wrap("31", text),
  yellow: (text: string) => wrap("33", text),
  green: (text: string) => wrap("32", text),
  cyan: (text: string) => wrap("36", text),
  dim: (text: string) => wrap("2", text),
  bold: (text: string) => wrap("1", text),
};

export function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeError(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function usageError(message: string): never {
  writeError(`${paint.red("error")} ${message}`);
  process.exit(2);
}
