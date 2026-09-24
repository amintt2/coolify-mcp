import { CoolifyError } from "./client.js";

export type ResourceKind = "application" | "service";

export interface Named {
  uuid: string;
  name: string;
  fqdn?: string | null;
}

export interface Resolved<T> {
  kind: ResourceKind;
  item: T;
}

function domains(fqdn: string | null | undefined): string[] {
  if (!fqdn) return [];
  return fqdn
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((d) => [d, d.replace(/^https?:\/\//, "").replace(/\/+$/, "")]);
}

function describe(kind: string, item: Named): string {
  return `${kind} "${item.name}" (uuid ${item.uuid}${item.fqdn ? `, ${item.fqdn}` : ""})`;
}

/**
 * Resolve a user-supplied reference (uuid, exact name, or a substring of the name / domain)
 * to exactly one resource. Throws a clear error when nothing or several things match.
 */
export function resolveAmong<T extends Named>(
  candidates: Array<{ kind: ResourceKind; item: T }>,
  query: string,
  label: string,
): Resolved<T> {
  const q = query.trim();
  const ql = q.toLowerCase();
  if (!q) throw new CoolifyError(`Empty ${label} reference: pass a uuid, a name, or part of its domain.`);

  const byUuid = candidates.filter((c) => c.item.uuid === q);
  if (byUuid.length === 1) return byUuid[0];

  const byName = candidates.filter((c) => (c.item.name ?? "").toLowerCase() === ql);
  if (byName.length === 1) return byName[0];

  const byDomain = candidates.filter((c) => domains(c.item.fqdn).includes(ql.replace(/\/+$/, "")));
  if (byName.length === 0 && byDomain.length === 1) return byDomain[0];

  // Coolify names git apps "<repo>:<branch>", so "mailbase" means "mailbase:main".
  const byBase = candidates.filter((c) => (c.item.name ?? "").toLowerCase().split(":")[0] === ql);
  if (byName.length === 0 && byBase.length === 1) return byBase[0];

  // A name match beats a domain match: "mailbase" should not also pick up
  // another app that merely serves mailbase.example.com.
  const nameHits = candidates.filter((c) => (c.item.name ?? "").toLowerCase().includes(ql));
  const pool = byName.length > 1
    ? byName
    : byBase.length > 1
      ? byBase
      : nameHits.length > 0
        ? nameHits
        : candidates.filter((c) => domains(c.item.fqdn).some((d) => d.includes(ql)));

  if (pool.length === 1) return pool[0];
  if (pool.length === 0) {
    const known = candidates.slice(0, 25).map((c) => `- ${describe(c.kind, c.item)}`).join("\n");
    throw new CoolifyError(
      `No ${label} matches "${q}".` + (known ? ` Known:\n${known}` : ` There are no ${label}s visible to this token.`),
      404,
    );
  }
  const list = pool.map((c) => `- ${describe(c.kind, c.item)}`).join("\n");
  throw new CoolifyError(`"${q}" is ambiguous — it matches ${pool.length} ${label}s:\n${list}\nPass the uuid instead.`);
}
