/**
 * Mask a secret for display: a short prefix plus the length, never the whole value.
 * The prefix is at most 4 characters and at most a third of the value, so short
 * secrets are never shown in full.
 */
export function maskValue(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  const len = [...value].length;
  const shown = Math.min(4, Math.floor(len / 3));
  const prefix = [...value].slice(0, shown).join("");
  return `${prefix}${"*".repeat(3)} (${len} chars)`;
}
