/**
 * Host-side access policy registry and path/model containment rules for scoped Web keys.
 *
 * Trusted Web plugins register a `WebAccessPolicyProvider` through the `codexhostAccess`
 * Cordis service. The Web server owns all enforcement and fails closed when no provider
 * is loaded or a credential is no longer valid.
 */
import { existsSync, realpathSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  WebAccessPolicy,
  WebAccessPolicyProvider,
  WebAccessRequestIdentity,
  WebAccessResolvedToken,
} from "@codexhost/dsh-web-backend";

import type { ModelGroup } from "./harnesses.ts";
import { RpcError } from "./transport.ts";

export const SCOPED_CREDENTIAL_PREFIX = "scoped:";

export interface ModelCatalogShape {
  default: { provider: string; model: string; reasoningEffort?: string };
  routableProviders: string[];
  groups: ModelGroup[];
  failures: Array<{ id: string; name: string; message: string }>;
  harnessOrder?: string[];
  rememberedSelections?: Record<
    string,
    { provider: string; model: string; reasoningEffort?: string }
  >;
  modelFavorites?: Record<string, string[]>;
  preferencesAvailable?: boolean;
}

function stripWindowsDrivePrefix(targetPath: string): string {
  return process.platform === "win32"
    ? targetPath.replace(/^\/(?=[A-Za-z]:[/\\])/u, "")
    : targetPath;
}

/**
 * Canonicalize an absolute filesystem path for containment checks.
 * Resolves symlinks on the target or nearest existing ancestor and normalizes case on Windows.
 */
export function canonicalizePath(targetPath: string): string | undefined {
  if (!targetPath || /[\u0000-\u001f\u007f]/u.test(targetPath)) return undefined;
  const nativePath = stripWindowsDrivePrefix(targetPath.trim());
  if (!isAbsolute(nativePath)) return undefined;
  const resolved = resolve(nativePath);
  let cursor = resolved;
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(relative(parent, cursor));
    cursor = parent;
  }
  let canonical = resolved;
  try {
    const realAncestor = existsSync(cursor) ? realpathSync(cursor) : cursor;
    canonical = missing.length > 0 ? join(realAncestor, ...missing) : realAncestor;
  } catch {
    canonical = resolved;
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function isCanonicalChild(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Whether an absolute filesystem path is equal to or inside one of the allowed roots. */
export function isPathWithinRoots(
  candidatePath: string | undefined,
  allowedRoots: readonly string[],
): boolean {
  if (!candidatePath || allowedRoots.length === 0) return false;
  const candidate = canonicalizePath(candidatePath);
  if (candidate === undefined) return false;
  for (const allowedRoot of allowedRoots) {
    const root = canonicalizePath(allowedRoot);
    if (root !== undefined && isCanonicalChild(root, candidate)) return true;
  }
  return false;
}

/**
 * Resolve a user-supplied file path relative to a session's workspace root and verify
 * that the real target stays inside both the session root and the policy's allowed roots.
 */
export function resolveContainedFilePath(
  workspaceRoot: string | undefined,
  requestedPath: string | undefined,
  allowedRoots: readonly string[],
): string | undefined {
  if (
    !workspaceRoot ||
    !requestedPath ||
    /[\u0000-\u001f\u007f]/u.test(requestedPath) ||
    allowedRoots.length === 0
  )
    return undefined;
  const normalizedRequest = stripWindowsDrivePrefix(requestedPath);
  const resolvedTarget = resolve(workspaceRoot, normalizedRequest);
  if (!isPathWithinRoots(resolvedTarget, [workspaceRoot])) return undefined;
  if (!isPathWithinRoots(resolvedTarget, allowedRoots)) return undefined;
  return resolvedTarget;
}

export function isModelAllowed(
  policy: WebAccessPolicy,
  provider: string,
  modelId: string,
): boolean {
  return policy.allowedModels.some(
    (entry) => entry.provider === provider && entry.model === modelId,
  );
}

/** Filter a Web model catalog to only the (provider, model) pairs permitted by a scoped policy. */
export function filterModelCatalog<T extends ModelCatalogShape>(
  catalog: T,
  policy: WebAccessPolicy,
): T {
  const allowedProviders = new Set(policy.allowedModels.map((entry) => entry.provider));
  const groups: ModelGroup[] = [];
  for (const group of catalog.groups) {
    const models: ModelGroup["models"] = [];
    for (const model of group.models) {
      const baseAllowed = isModelAllowed(policy, group.id, model.id);
      const fastAllowed =
        model.fastModel !== undefined && isModelAllowed(policy, group.id, model.fastModel);
      const ultrafastAllowed =
        model.ultrafastModel !== undefined &&
        isModelAllowed(policy, group.id, model.ultrafastModel);
      if (baseAllowed) {
        const next: ModelGroup["models"][number] = {
          id: model.id,
          name: model.name,
          ...(model.description !== undefined ? { description: model.description } : {}),
          ...(fastAllowed && model.fastModel !== undefined ? { fastModel: model.fastModel } : {}),
          ...(ultrafastAllowed && model.ultrafastModel !== undefined
            ? { ultrafastModel: model.ultrafastModel }
            : {}),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        };
        models.push(next);
      } else {
        if (fastAllowed && model.fastModel !== undefined) {
          models.push({
            id: model.fastModel,
            name: `${model.name} (Fast)`,
            ...(model.description !== undefined ? { description: model.description } : {}),
            ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          });
        }
        if (ultrafastAllowed && model.ultrafastModel !== undefined) {
          models.push({
            id: model.ultrafastModel,
            name: `${model.name} (Ultrafast)`,
            ...(model.description !== undefined ? { description: model.description } : {}),
            ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          });
        }
      }
    }
    if (models.length > 0) groups.push({ id: group.id, name: group.name, models });
  }
  const firstGroup = groups[0];
  const firstModel = firstGroup?.models[0];
  if (!firstGroup || !firstModel) {
    throw new RpcError(
      "auth/no-allowed-models",
      "No permitted models are available for this access key.",
    );
  }
  const routableProviders = groups.map((group) => group.id);
  const routableSet = new Set(routableProviders);
  const defaultAllowed =
    routableSet.has(catalog.default.provider) &&
    isModelAllowed(policy, catalog.default.provider, catalog.default.model);
  const nextDefault = defaultAllowed
    ? catalog.default
    : {
        provider: firstGroup.id,
        model: firstModel.id,
        ...(firstModel.reasoning?.defaultEffort !== undefined
          ? { reasoningEffort: firstModel.reasoning.defaultEffort }
          : {}),
      };
  const filteredRemembered: Record<
    string,
    { provider: string; model: string; reasoningEffort?: string }
  > = {};
  if (catalog.rememberedSelections) {
    for (const [key, selection] of Object.entries(catalog.rememberedSelections)) {
      if (routableSet.has(selection.provider) && isModelAllowed(policy, selection.provider, selection.model)) {
        filteredRemembered[key] = selection;
      }
    }
  }
  const filteredFavorites: Record<string, string[]> = {};
  if (catalog.modelFavorites) {
    for (const [provider, ids] of Object.entries(catalog.modelFavorites)) {
      if (!routableSet.has(provider)) continue;
      const kept = ids.filter((id) => isModelAllowed(policy, provider, id));
      if (kept.length > 0) filteredFavorites[provider] = kept;
    }
  }
  return {
    ...catalog,
    default: nextDefault,
    groups,
    routableProviders,
    failures: catalog.failures.filter((failure) => allowedProviders.has(failure.id)),
    ...(catalog.harnessOrder !== undefined
      ? { harnessOrder: catalog.harnessOrder.filter((id) => routableSet.has(id)) }
      : {}),
    ...(catalog.rememberedSelections !== undefined
      ? { rememberedSelections: filteredRemembered }
      : {}),
    ...(catalog.modelFavorites !== undefined ? { modelFavorites: filteredFavorites } : {}),
    preferencesAvailable: false,
  };
}

function isValidScopedCredentialId(id: string): boolean {
  return id.startsWith(SCOPED_CREDENTIAL_PREFIX) && id.length > SCOPED_CREDENTIAL_PREFIX.length;
}

function normalizePolicy(credentialId: string, policy: WebAccessPolicy): WebAccessPolicy {
  return {
    credentialId,
    ...(policy.label !== undefined ? { label: policy.label } : {}),
    allowedProjectPaths: [...policy.allowedProjectPaths],
    allowedModels: policy.allowedModels.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
    })),
    allowWorkspaceFiles: policy.allowWorkspaceFiles === true,
    allowTerminal: policy.allowTerminal === true,
  };
}

/**
 * Registry coordinating access-policy providers registered by trusted Web plugins.
 */
export class WebAccessPolicyRegistry {
  private readonly providers = new Map<string, WebAccessPolicyProvider>();
  private readonly seenCredentials = new Map<string, Set<string>>();
  private readonly revocationListeners = new Set<(credentialId: string) => void>();
  private readonly requestAuthMap = new WeakMap<IncomingMessage, WebAccessRequestIdentity>();

  onRevoked(listener: (credentialId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => {
      this.revocationListeners.delete(listener);
    };
  }

  registerProvider(provider: WebAccessPolicyProvider): () => void {
    if (!provider.id || this.providers.has(provider.id)) {
      throw new Error(`Duplicate or invalid Web access policy provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    this.seenCredentials.set(provider.id, new Set());
    return () => {
      if (this.providers.get(provider.id) !== provider) return;
      this.providers.delete(provider.id);
      const toRevoke = new Set<string>(this.seenCredentials.get(provider.id) ?? []);
      this.seenCredentials.delete(provider.id);
      try {
        for (const id of provider.listCredentialIds?.() ?? []) {
          if (isValidScopedCredentialId(id)) toRevoke.add(id);
        }
      } catch {
        // Provider disposal must still revoke previously observed credentials.
      }
      for (const id of toRevoke) this.revokeCredential(id);
    };
  }

  resolveToken(candidate: string): WebAccessResolvedToken | undefined {
    for (const [providerId, provider] of this.providers) {
      let resolved: WebAccessResolvedToken | undefined;
      try {
        resolved = provider.resolveToken(candidate);
      } catch (error) {
        console.error(`[access-policy] provider ${providerId} resolveToken failed`, error);
        continue;
      }
      if (!resolved) continue;
      if (!isValidScopedCredentialId(resolved.credentialId)) {
        console.error(
          `[access-policy] provider ${providerId} returned invalid scoped credential id`,
        );
        continue;
      }
      this.seenCredentials.get(providerId)?.add(resolved.credentialId);
      return {
        credentialId: resolved.credentialId,
        policy: normalizePolicy(resolved.credentialId, resolved.policy),
      };
    }
    return undefined;
  }

  policyFor(credentialId: string): WebAccessPolicy | undefined {
    if (!isValidScopedCredentialId(credentialId)) return undefined;
    for (const [providerId, provider] of this.providers) {
      try {
        const policy = provider.getPolicy(credentialId);
        if (policy !== undefined) {
          this.seenCredentials.get(providerId)?.add(credentialId);
          return normalizePolicy(credentialId, policy);
        }
      } catch (error) {
        console.error(`[access-policy] provider ${providerId} getPolicy failed`, error);
      }
    }
    return undefined;
  }

  has(credentialId: string): boolean {
    if (!isValidScopedCredentialId(credentialId)) return false;
    for (const [providerId, provider] of this.providers) {
      try {
        if (provider.hasCredential(credentialId)) return true;
      } catch (error) {
        console.error(`[access-policy] provider ${providerId} hasCredential failed`, error);
      }
    }
    return false;
  }

  revokeCredential(credentialId: string): void {
    if (!isValidScopedCredentialId(credentialId)) return;
    for (const listener of this.revocationListeners) {
      try {
        listener(credentialId);
      } catch (error) {
        console.error("[access-policy] revocation listener failed", error);
      }
    }
  }

  trackRequest(request: IncomingMessage, auth: WebAccessRequestIdentity): void {
    this.requestAuthMap.set(request, auth);
  }

  getRequestAuth(request: IncomingMessage): WebAccessRequestIdentity | undefined {
    return this.requestAuthMap.get(request);
  }
}
