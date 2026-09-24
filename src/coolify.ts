import { CoolifyClient } from "./client.js";
import type { RawEnv } from "./envs.js";
import { resolveAmong, type Named, type ResourceKind, type Resolved } from "./resolve.js";

export interface Application extends Named {
  description?: string | null;
  status?: string | null;
  git_repository?: string | null;
  git_branch?: string | null;
  git_commit_sha?: string | null;
  build_pack?: string | null;
  environment_id?: number | null;
  [k: string]: unknown;
}

export interface Service extends Named {
  description?: string | null;
  service_type?: string | null;
  status?: string | null;
  environment_id?: number | null;
  [k: string]: unknown;
}

export interface Database {
  uuid: string;
  name: string;
  database_type?: string | null;
  type?: string | null;
  status?: string | null;
  environment_id?: number | null;
  is_public?: boolean | null;
  public_port?: number | null;
  [k: string]: unknown;
}

export interface Project {
  uuid: string;
  name: string;
  description?: string | null;
  environments?: Array<{ id: number; uuid?: string; name: string; description?: string | null }>;
}

export interface EnvLocation {
  project: string;
  project_uuid: string;
  environment: string;
}

const PLURAL: Record<ResourceKind, string> = { application: "applications", service: "services" };

export function kindPath(kind: ResourceKind, uuid: string): string {
  return `/${PLURAL[kind]}/${encodeURIComponent(uuid)}`;
}

/** Thin domain layer over the REST client: listing, name resolution, project/environment lookup. */
export class Coolify {
  private envIndex?: { at: number; map: Map<number, EnvLocation> };

  constructor(readonly client: CoolifyClient) {}

  listApplications() {
    return this.client.get<Application[]>("/applications");
  }
  listServices() {
    return this.client.get<Service[]>("/services");
  }
  listDatabases() {
    return this.client.get<Database[]>("/databases");
  }
  listProjects() {
    return this.client.get<Project[]>("/projects");
  }

  /** Map environment_id -> project/environment names. Cached for 60 s. */
  async environmentIndex(): Promise<Map<number, EnvLocation>> {
    if (this.envIndex && Date.now() - this.envIndex.at < 60_000) return this.envIndex.map;
    const projects = await this.listProjects();
    const detailed = await Promise.all(
      projects.map((p) =>
        this.client.get<Project>(`/projects/${encodeURIComponent(p.uuid)}`).catch(() => ({ ...p, environments: [] })),
      ),
    );
    const map = new Map<number, EnvLocation>();
    for (const p of detailed) {
      for (const e of p.environments ?? []) map.set(e.id, { project: p.name, project_uuid: p.uuid, environment: e.name });
    }
    this.envIndex = { at: Date.now(), map };
    return map;
  }

  async locate(environmentId: number | null | undefined): Promise<Partial<EnvLocation>> {
    if (environmentId === null || environmentId === undefined) return {};
    try {
      return (await this.environmentIndex()).get(environmentId) ?? {};
    } catch {
      return {};
    }
  }

  async resolveApplication(ref: string): Promise<Application> {
    const apps = await this.listApplications();
    return resolveAmong(apps.map((item) => ({ kind: "application" as const, item })), ref, "application").item;
  }

  async resolveService(ref: string): Promise<Service> {
    const services = await this.listServices();
    return resolveAmong(services.map((item) => ({ kind: "service" as const, item })), ref, "service").item;
  }

  /** Resolve among applications and/or services. */
  async resolveResource(ref: string, kind?: ResourceKind): Promise<Resolved<Application | Service>> {
    if (kind === "application") return { kind, item: await this.resolveApplication(ref) };
    if (kind === "service") return { kind, item: await this.resolveService(ref) };
    const [apps, services] = await Promise.all([this.listApplications(), this.listServices()]);
    return resolveAmong<Application | Service>(
      [
        ...apps.map((item) => ({ kind: "application" as const, item })),
        ...services.map((item) => ({ kind: "service" as const, item })),
      ],
      ref,
      "application or service",
    );
  }

  listEnvs(kind: ResourceKind, uuid: string, label: string) {
    return this.client.get<RawEnv[]>(`${kindPath(kind, uuid)}/envs`, { resource: `${kind} ${label} (uuid ${uuid})` });
  }
}
