/** Carrier-facing Web plugin contracts; no framework implementation types escape the backend. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ClientAssets, ClientSource } from "./client-assets.ts";

export interface WebAccessAllowedModel {
  readonly provider: string;
  readonly model: string;
}

/** Enforcement policy returned by an auth/policy plugin for a scoped remote credential. */
export interface WebAccessPolicy {
  readonly credentialId: string;
  readonly label?: string;
  readonly allowedProjectPaths: readonly string[];
  readonly allowedModels: readonly WebAccessAllowedModel[];
  readonly allowWorkspaceFiles: boolean;
  readonly allowTerminal: boolean;
}

export interface WebAccessResolvedToken {
  readonly credentialId: string;
  readonly policy: WebAccessPolicy;
}

export interface WebAccessPolicyProvider {
  readonly id: string;
  resolveToken(candidate: string): WebAccessResolvedToken | undefined;
  getPolicy(credentialId: string): WebAccessPolicy | undefined;
  hasCredential(credentialId: string): boolean;
  listCredentialIds?(): readonly string[];
}

export interface WebAccessRequestIdentity {
  readonly credential: string;
  readonly local: boolean;
  readonly scope: "full" | "scoped";
  readonly policy?: WebAccessPolicy;
}

export interface WebAccessProjectSummary {
  readonly workspaceId?: string;
  readonly title: string;
  readonly path: string;
}

export interface WebAccessModelSummary {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly fastModel?: string;
  readonly ultrafastModel?: string;
}

export interface WebAccessModelGroupSummary {
  readonly id: string;
  readonly name: string;
  readonly models: readonly WebAccessModelSummary[];
}

export interface WebAccessNetworkUrl {
  readonly kind: string;
  readonly url: string;
}

/** Minimal Host service injected into trusted Web plugins as Cordis service `codexhostAccess`. */
export interface WebAccessExtensionHost {
  readonly authEnabled: boolean;
  readonly dataDirectory: string;
  registerProvider(provider: WebAccessPolicyProvider): () => void;
  revokeCredential(credentialId: string): void;
  getRequestAuth(request: IncomingMessage): WebAccessRequestIdentity | undefined;
  listProjects(): Promise<readonly WebAccessProjectSummary[]>;
  listModels(): Promise<readonly WebAccessModelGroupSummary[]>;
  getNetworkUrls(): Promise<readonly WebAccessNetworkUrl[]>;
}

export interface WebPluginPackage {
  readonly id: string;
  readonly directory: string;
}
export interface BundleEntry {
  id: string;
  name: string;
  config?: unknown;
  group?: boolean | null;
  disabled?: boolean | null;
  inject?: string[] | Record<string, unknown> | null;
}
export interface WebPluginRuntimeOptions {
  packages: readonly WebPluginPackage[];
  builtins: readonly ClientSource[];
  address(): { host: string; port: number };
  reserved?: readonly { kind: "exact" | "prefix"; path: string }[];
}
export interface WebPluginResult {
  loadedIds: string[];
  loadErrors: Record<string, string>;
}
export interface WebPluginRuntime {
  readonly clients: ClientAssets;
  /** Called by the carrier's existing serialized management queue. */
  update(packages: readonly WebPluginPackage[], changedId?: string): Promise<WebPluginResult>;
  /** Built-in SSE endpoint; the carrier authenticates before dispatch. */
  events(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
  renderIndex(html: string): string;
  close(): Promise<void>;
}
