import { CoolifyError } from "./client.js";
import { maskValue } from "./mask.js";
import type { ResourceKind } from "./resolve.js";

export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Env var as returned by Coolify. `value` is absent when the token lacks `read:sensitive`. */
export interface RawEnv {
  uuid: string;
  key: string;
  value?: string | null;
  real_value?: string | null;
  is_preview?: boolean | null;
  is_literal?: boolean | null;
  is_multiline?: boolean | null;
  is_shown_once?: boolean | null;
  /** Coolify >= 4.0.0-beta.43x */
  is_buildtime?: boolean | null;
  /** Older Coolify */
  is_build_time?: boolean | null;
  is_runtime?: boolean | null;
  is_shared?: boolean | null;
  comment?: string | null;
}

export interface EnvInput {
  key: string;
  value: string;
  is_build_time?: boolean;
  is_runtime?: boolean;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
}

export type FlagName = "is_build_time" | "is_runtime" | "is_preview" | "is_literal" | "is_multiline";
const FLAGS: FlagName[] = ["is_build_time", "is_runtime", "is_preview", "is_literal", "is_multiline"];
const SERVICE_UNSUPPORTED: FlagName[] = ["is_build_time", "is_runtime", "is_preview"];

export function flagOf(env: RawEnv, flag: FlagName): boolean | null {
  const v = flag === "is_build_time" ? env.is_buildtime ?? env.is_build_time : env[flag];
  return v === undefined || v === null ? null : Boolean(v);
}

export function valueReadable(env: RawEnv): boolean {
  return Object.prototype.hasOwnProperty.call(env, "value") && !env.is_shown_once;
}

/** Coolify trims values on write and returns null for empty ones. */
export function normalizeValue(v: string | null | undefined): string {
  return (v ?? "").trim();
}

export interface EnvView {
  key: string;
  uuid: string;
  value: string;
  is_build_time: boolean | null;
  is_runtime: boolean | null;
  is_preview: boolean;
  is_literal: boolean;
  is_multiline: boolean;
  is_shown_once: boolean;
  is_shared?: boolean;
  comment?: string;
}

export function viewEnv(env: RawEnv, reveal: boolean): EnvView {
  let value: string;
  if (env.is_shown_once) value = "(hidden: marked 'shown once' in Coolify)";
  else if (!Object.prototype.hasOwnProperty.call(env, "value")) {
    value = "(not returned by Coolify: token lacks read:sensitive)";
  } else if (reveal) value = env.value ?? "";
  else value = maskValue(env.value);

  const out: EnvView = {
    key: env.key,
    uuid: env.uuid,
    value,
    is_build_time: flagOf(env, "is_build_time"),
    is_runtime: flagOf(env, "is_runtime"),
    is_preview: Boolean(env.is_preview),
    is_literal: Boolean(env.is_literal),
    is_multiline: Boolean(env.is_multiline),
    is_shown_once: Boolean(env.is_shown_once),
  };
  if (env.is_shared) out.is_shared = true;
  if (env.comment) out.comment = env.comment;
  return out;
}

export type PlanStatus = "created" | "updated" | "unchanged";

export interface PlanEntry {
  key: string;
  is_preview: boolean;
  status: PlanStatus;
  /** What differs (field names only — never values). */
  changes: string[];
  notes?: string[];
}

export interface SetPlan {
  entries: PlanEntry[];
  /** Items for PATCH /{type}s/{uuid}/envs/bulk (empty when nothing changes). */
  payload: Array<Record<string, unknown>>;
}

function findExisting(existing: RawEnv[], key: string, isPreview: boolean, kind: ResourceKind): RawEnv | undefined {
  return existing.find((e) => e.key === key && (kind === "service" || Boolean(e.is_preview) === isPreview));
}

export function validateInputs(inputs: EnvInput[]): void {
  if (inputs.length === 0) throw new CoolifyError("No variables given: pass at least one {key, value}.");
  const seen = new Set<string>();
  for (const input of inputs) {
    if (!ENV_KEY_RE.test(input.key)) {
      throw new CoolifyError(
        `Invalid key "${input.key}": keys must match ^[A-Za-z_][A-Za-z0-9_]*$ (letters, digits, underscore; not starting with a digit).`,
      );
    }
    const id = `${input.key}|${input.is_preview ? "preview" : "main"}`;
    if (seen.has(id)) throw new CoolifyError(`Key "${input.key}" is given twice in the same call.`);
    seen.add(id);
  }
}

/**
 * Decide, per key, whether it will be created, updated or left unchanged, and build the
 * bulk payload. Values are compared locally and never echoed back.
 */
export function planSetEnvs(existing: RawEnv[], inputs: EnvInput[], kind: ResourceKind): SetPlan {
  validateInputs(inputs);
  const entries: PlanEntry[] = [];
  const payload: Array<Record<string, unknown>> = [];

  for (const input of inputs) {
    const notes: string[] = [];
    const isPreview = kind === "application" ? Boolean(input.is_preview) : false;
    if (kind === "service") {
      const dropped = SERVICE_UNSUPPORTED.filter((f) => input[f] !== undefined);
      if (dropped.length) notes.push(`${dropped.join(", ")} ignored: not supported for service env vars`);
    }
    if (input.value !== input.value.trim()) notes.push("leading/trailing whitespace will be trimmed by Coolify");

    const current = findExisting(existing, input.key, isPreview, kind);
    const wanted: Partial<Record<FlagName, boolean>> = {};
    for (const f of FLAGS) {
      if (input[f] === undefined) continue;
      if (kind === "service" && SERVICE_UNSUPPORTED.includes(f)) continue;
      wanted[f] = input[f];
    }

    if (!current) {
      entries.push({ key: input.key, is_preview: isPreview, status: "created", changes: ["new key"], notes: notes.length ? notes : undefined });
      payload.push(toPayload(kind, input.key, input.value, isPreview, wanted));
      continue;
    }

    const changes: string[] = [];
    if (valueReadable(current)) {
      if (normalizeValue(current.value) !== normalizeValue(input.value)) changes.push("value");
    } else {
      changes.push("value (not comparable: Coolify did not return the current value)");
    }
    for (const [f, v] of Object.entries(wanted) as Array<[FlagName, boolean]>) {
      if (f === "is_preview") continue; // part of the identity
      const cur = flagOf(current, f);
      if (cur === null || cur !== v) changes.push(f);
    }

    if (changes.length === 0) {
      entries.push({ key: input.key, is_preview: isPreview, status: "unchanged", changes: [], notes: notes.length ? notes : undefined });
      continue;
    }

    // Coolify's bulk update resets is_literal / is_multiline / is_shown_once when they are omitted,
    // so carry the current flags over unless the caller changes them.
    const merged: Partial<Record<FlagName, boolean>> = {};
    for (const f of FLAGS) {
      if (kind === "service" && SERVICE_UNSUPPORTED.includes(f)) continue;
      const cur = flagOf(current, f);
      if (wanted[f] !== undefined) merged[f] = wanted[f];
      else if (cur !== null) merged[f] = cur;
    }
    const item = toPayload(kind, input.key, input.value, isPreview, merged);
    if (current.is_shown_once) item.is_shown_once = true;
    entries.push({ key: input.key, is_preview: isPreview, status: "updated", changes, notes: notes.length ? notes : undefined });
    payload.push(item);
  }
  return { entries, payload };
}

function toPayload(
  kind: ResourceKind,
  key: string,
  value: string,
  isPreview: boolean,
  flags: Partial<Record<FlagName, boolean>>,
): Record<string, unknown> {
  const item: Record<string, unknown> = { key, value };
  if (kind === "application") {
    item.is_preview = isPreview;
    if (flags.is_build_time !== undefined) {
      // Newer Coolify reads `is_buildtime`, older releases `is_build_time`; the bulk endpoint
      // whitelists fields, so sending both is safe on either.
      item.is_buildtime = flags.is_build_time;
      item.is_build_time = flags.is_build_time;
    }
    if (flags.is_runtime !== undefined) item.is_runtime = flags.is_runtime;
  }
  if (flags.is_literal !== undefined) item.is_literal = flags.is_literal;
  if (flags.is_multiline !== undefined) item.is_multiline = flags.is_multiline;
  return item;
}
