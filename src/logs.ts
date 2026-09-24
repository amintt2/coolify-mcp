interface LogEntry {
  output?: string;
  command?: string | null;
  type?: string;
  hidden?: boolean;
  timestamp?: string;
}

/**
 * Coolify stores deployment logs as a JSON-encoded array of entries
 * (`{command, output, type, hidden, timestamp, batch, order}`). Return the visible
 * output as plain lines. Falls back to splitting raw text.
 */
export function deploymentLogLines(logs: unknown): string[] {
  if (logs === null || logs === undefined || logs === "") return [];
  let entries: unknown = logs;
  if (typeof logs === "string") {
    try {
      entries = JSON.parse(logs);
    } catch {
      return splitLines(logs);
    }
  }
  if (!Array.isArray(entries)) return typeof logs === "string" ? splitLines(logs) : [];
  const lines: string[] = [];
  for (const raw of entries as LogEntry[]) {
    if (!raw || raw.hidden) continue;
    const prefix = raw.type === "stderr" ? "[stderr] " : "";
    for (const line of splitLines(raw.output ?? "")) lines.push(prefix + line);
  }
  return lines;
}

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

export function tail(lines: string[], n: number): { text: string; total: number; shown: number } {
  const slice = lines.slice(Math.max(0, lines.length - n));
  return { text: slice.join("\n"), total: lines.length, shown: slice.length };
}
