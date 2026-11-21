/**
 * Fail-closed policy enforcement for scoped Web access keys across HTTP, RPC, DSH,
 * WebSocket streams, live broadcasts, and Web Push notifications.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebAccessPolicy } from "@codexhost/dsh-web-backend";

import {
  filterModelCatalog,
  isModelAllowed,
  isPathWithinRoots,
  resolveContainedFilePath,
  SCOPED_CREDENTIAL_PREFIX,
  type ModelCatalogShape,
  type WebAccessPolicyRegistry,
} from "./access-policy.ts";
import type { RequestAuth } from "./auth.ts";
import type { ChSessions } from "./ch-sessions.ts";
import { requestOf } from "./store.ts";
import { RpcError, type RpcContext, type StreamSink } from "./transport.ts";
import type { Workspaces, WorkspaceView } from "./workspaces.ts";

const READONLY_SCOPED_RPCS = new Set([
  "settings/describe",
  "credentials/describe",
  "skills/list",
  "llm/listProviders",
  "llm/listConfigurableProviders",
  "permissionPresets/catalog",
  "commands/list",
  "session/workspacePathApplications",
  "codexhost/display-settings/get",
  "codexhost/display-settings/capabilities",
  "codexhost/preferences/get",
  "codexhost/pushConfig",
]);

const PROJECT_SCOPED_SESSION_RPCS = new Set([
  "session/projections",
  "session/page",
  "session/toolOutput",
  "session/attachment",
  "codexhost/turnDiffs",
  "codexhost/threadCommands",
  "codexhost/skills/list",
  "session/cancel",
  "session/rename",
  "session/archive",
  "session/unarchive",
  "workspace/archiveSession",
  "workspace/unarchiveSession",
  "workspace/pinSession",
  "workspace/unpinSession",
  "commands/execute",
]);

const MODEL_EXECUTION_RPCS = new Set([
  "session/prompt",
  "session/fork",
  "codexhost/editMessage",
  "codexhost/executeThreadCommand",
]);

const FILE_SESSION_RPCS = new Set(["fileReferences/list", "fileUploads/upload"]);

function extractSessionId(args: Record<string, unknown>): string | undefined {
  const req = requestOf<{
    sessionId?: unknown;
    address?: { sessionId?: unknown };
    agentId?: unknown;
  }>(args);
  const candidate =
    req.sessionId ?? req.address?.sessionId ?? req.agentId ?? args.sessionId ?? args.agentId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

export class WebAccessEnforcer {
  constructor(
    private readonly policies: WebAccessPolicyRegistry,
    private readonly sessions: ChSessions,
    private readonly workspaces: Workspaces,
  ) {}

  /** Resolve live policy for a scoped request; throws if the key was revoked or disabled. */
  requirePolicy(auth: RequestAuth | undefined): WebAccessPolicy | undefined {
    if (auth?.scope !== "scoped") return undefined;
    const live = this.policies.policyFor(auth.credential);
    if (live === undefined) {
      throw new RpcError("auth/revoked", "This access key is no longer active.");
    }
    return live;
  }

  /** Non-throwing live policy lookup for synchronous broadcast filtering. */
  livePolicy(auth: RequestAuth | undefined): WebAccessPolicy | undefined {
    if (auth?.scope !== "scoped") return undefined;
    return this.policies.policyFor(auth.credential);
  }

  rejectScopedHttp(
    auth: RequestAuth | undefined,
    response: ServerResponse,
    message = "This endpoint is not permitted for a scoped access key.",
  ): boolean {
    if (auth?.scope !== "scoped") return false;
    response
      .writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
      .end(message);
    return true;
  }

  async authorizeWorkspaceDownload(
    auth: RequestAuth | undefined,
    sessionId: string,
  ): Promise<{ allowed: true; allowedRoots?: readonly string[] } | { allowed: false }> {
    if (auth?.scope !== "scoped") return { allowed: true };
    const policy = this.livePolicy(auth);
    if (!policy || !policy.allowWorkspaceFiles) return { allowed: false };
    const resolved = await this.sessions.resolveSessionAccess(sessionId);
    if (!resolved?.cwd || !isPathWithinRoots(resolved.cwd, policy.allowedProjectPaths))
      return { allowed: false };
    return { allowed: true, allowedRoots: policy.allowedProjectPaths };
  }

  authorizeLocalImageFile(auth: RequestAuth | undefined, filePath: string): boolean {
    if (auth?.scope !== "scoped") return true;
    const policy = this.livePolicy(auth);
    if (!policy || !policy.allowWorkspaceFiles) return false;
    return isPathWithinRoots(filePath, policy.allowedProjectPaths);
  }

  async authorizeBinaryUpload(auth: RequestAuth | undefined, sessionId: string): Promise<boolean> {
    if (auth?.scope !== "scoped") return true;
    const policy = this.livePolicy(auth);
    if (!policy || !policy.allowWorkspaceFiles) return false;
    const resolved = await this.sessions.resolveSessionAccess(sessionId);
    return Boolean(resolved?.cwd && isPathWithinRoots(resolved.cwd, policy.allowedProjectPaths));
  }

  async authorizeDsh(
    method: string,
    args: Record<string, unknown>,
    auth: RequestAuth | undefined,
  ): Promise<void> {
    const policy = this.requirePolicy(auth);
    if (policy === undefined) return;
    if (method.startsWith("terminal/")) {
      if (!policy.allowTerminal) {
        throw new RpcError(
          "auth/forbidden",
          "Terminal access is not permitted for this access key.",
        );
      }
      if (typeof args.agentId === "string") {
        await this.assertSessionAllowed(args.agentId, policy);
      }
      return;
    }
    if (method === "officeToPdf/generation") {
      if (!policy.allowWorkspaceFiles) {
        throw new RpcError("auth/forbidden", "File access is not permitted for this access key.");
      }
      return;
    }
    if (method.startsWith("workspaceFiles/") || method.startsWith("officeToPdf/")) {
      if (!policy.allowWorkspaceFiles) {
        throw new RpcError("auth/forbidden", "File access is not permitted for this access key.");
      }
      const sessionId =
        typeof args.workspaceFileScopeId === "string" ? args.workspaceFileScopeId : undefined;
      const requestedPath = typeof args.path === "string" ? args.path : undefined;
      if (!sessionId || requestedPath === undefined) {
        throw new RpcError(
          "auth/forbidden",
          "A permitted session and workspace path are required.",
        );
      }
      await this.assertSessionAllowed(sessionId, policy);
      const workspaceRoot = this.sessions.fileWorkspaceRoot(sessionId);
      const contained = resolveContainedFilePath(
        workspaceRoot,
        requestedPath,
        policy.allowedProjectPaths,
      );
      if (contained === undefined) {
        throw new RpcError(
          "auth/forbidden",
          "Requested path is outside the permitted project directory.",
        );
      }
      return;
    }
    throw new RpcError("auth/forbidden", `Method ${method} is not permitted for this access key.`);
  }

  private async assertSessionAllowed(sessionId: string, policy: WebAccessPolicy) {
    if (!sessionId || sessionId.startsWith("web-remote:")) {
      throw new RpcError(
        "auth/forbidden",
        "Access to this session is not permitted for this access key.",
      );
    }
    const resolved = await this.sessions.resolveSessionAccess(sessionId);
    if (!resolved?.cwd || !isPathWithinRoots(resolved.cwd, policy.allowedProjectPaths)) {
      throw new RpcError(
        "auth/forbidden",
        "Access to this project is not permitted for this access key.",
      );
    }
    return resolved;
  }

  private assertModelPermitted(
    policy: WebAccessPolicy,
    provider: string | undefined,
    model: string | undefined,
  ): void {
    if (!provider || !model || !isModelAllowed(policy, provider, model)) {
      throw new RpcError(
        "auth/model-forbidden",
        "This model is not permitted for this access key. Select a permitted model first.",
      );
    }
  }

  async guardRpc(
    method: string,
    args: Record<string, unknown>,
    context: RpcContext,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const policy = this.requirePolicy(context.auth);
    if (policy === undefined) return next();

    if (READONLY_SCOPED_RPCS.has(method)) return next();

    if (method === "codexhost/voice/status") {
      return { available: false };
    }

    if (method === "codexhost/pushSubscribe" || method === "codexhost/pushUnsubscribe") {
      return next();
    }

    if (method === "$events/result") {
      return next();
    }

    if (method === "workspace/initializeDefault") {
      const visible = this.workspaces.listFor(context.auth);
      return visible[0] !== undefined ? { workspace: visible[0] } : undefined;
    }

    if (method === "session/modelCatalog") {
      const catalog = (await next()) as ModelCatalogShape;
      return filterModelCatalog(catalog, policy);
    }

    if (method === "session/list") {
      const req = requestOf<{ sessionId?: unknown }>(args);
      if (typeof req.sessionId === "string" && req.sessionId.length > 0) {
        await this.assertSessionAllowed(req.sessionId, policy);
      }
      const reply = (await next()) as {
        items?: Array<{ sessionId?: string; cwd?: string }>;
        archivedSessionIds?: string[];
        nextCursor?: string | null;
      };
      const items = (reply.items ?? []).filter(
        (item) =>
          typeof item.sessionId === "string" &&
          !item.sessionId.startsWith("web-remote:") &&
          isPathWithinRoots(item.cwd, policy.allowedProjectPaths),
      );
      const archivedSessionIds = (reply.archivedSessionIds ?? []).filter((id) =>
        this.isSessionAllowedSync(context.auth, id),
      );
      return { ...reply, items, archivedSessionIds };
    }

    if (method === "session/search") {
      const reply = (await next()) as { items?: Array<{ sessionId?: string }>; hasMore?: boolean };
      return {
        ...reply,
        items: (reply.items ?? []).filter(
          (item) =>
            typeof item.sessionId === "string" &&
            this.isSessionAllowedSync(context.auth, item.sessionId),
        ),
      };
    }

    if (method === "session/create") {
      const req = requestOf<{ cwd?: unknown; workspaceId?: unknown }>(args);
      let cwd: string | undefined;
      if (typeof req.cwd === "string" && req.cwd.length > 0) {
        cwd = req.cwd;
      } else if (typeof req.workspaceId === "string" && req.workspaceId.length > 0) {
        const workspace = this.workspaces
          .listFor(context.auth)
          .find((item) => item.workspaceId === req.workspaceId);
        cwd = workspace?.path;
      }
      if (!cwd || !isPathWithinRoots(cwd, policy.allowedProjectPaths)) {
        throw new RpcError(
          "auth/forbidden",
          "Creating sessions outside permitted projects is not allowed for this access key.",
        );
      }
      return next();
    }

    if (method === "session/selectModel") {
      const req = requestOf<{ sessionId?: unknown; provider?: unknown; model?: unknown }>(args);
      if (typeof req.sessionId !== "string") {
        throw new RpcError("auth/forbidden", "A permitted session is required.");
      }
      await this.assertSessionAllowed(req.sessionId, policy);
      this.assertModelPermitted(
        policy,
        typeof req.provider === "string" ? req.provider : undefined,
        typeof req.model === "string" ? req.model : undefined,
      );
      return next();
    }

    if (MODEL_EXECUTION_RPCS.has(method)) {
      const sessionId = extractSessionId(args);
      if (!sessionId) throw new RpcError("auth/forbidden", "A permitted session is required.");
      const resolved = await this.assertSessionAllowed(sessionId, policy);
      this.assertModelPermitted(policy, resolved.provider, resolved.model);
      return next();
    }

    if (method === "session/updateQueue") {
      const req = requestOf<{ sessionId?: unknown; action?: { kind?: unknown } }>(args);
      if (typeof req.sessionId !== "string") {
        throw new RpcError("auth/forbidden", "A permitted session is required.");
      }
      const resolved = await this.assertSessionAllowed(req.sessionId, policy);
      if (req.action?.kind !== "remove") {
        this.assertModelPermitted(policy, resolved.provider, resolved.model);
      }
      return next();
    }

    if (FILE_SESSION_RPCS.has(method)) {
      if (!policy.allowWorkspaceFiles) {
        throw new RpcError("auth/forbidden", "File access is not permitted for this access key.");
      }
      const sessionId = extractSessionId(args);
      if (!sessionId) throw new RpcError("auth/forbidden", "A permitted session is required.");
      await this.assertSessionAllowed(sessionId, policy);
      return next();
    }

    if (PROJECT_SCOPED_SESSION_RPCS.has(method)) {
      const sessionId = extractSessionId(args);
      if (!sessionId) throw new RpcError("auth/forbidden", "A permitted session is required.");
      await this.assertSessionAllowed(sessionId, policy);
      const reply = await next();
      if (
        (method === "workspace/archiveSession" || method === "workspace/unarchiveSession") &&
        reply &&
        typeof reply === "object" &&
        "archivedSessionIds" in reply &&
        Array.isArray((reply as { archivedSessionIds: unknown }).archivedSessionIds)
      ) {
        return {
          ...reply,
          archivedSessionIds: (reply as { archivedSessionIds: string[] }).archivedSessionIds.filter(
            (id) => this.isSessionAllowedSync(context.auth, id),
          ),
        };
      }
      if (
        (method === "workspace/pinSession" || method === "workspace/unpinSession") &&
        reply &&
        typeof reply === "object" &&
        "pinnedSessionIds" in reply &&
        Array.isArray((reply as { pinnedSessionIds: unknown }).pinnedSessionIds)
      ) {
        return {
          ...reply,
          pinnedSessionIds: (reply as { pinnedSessionIds: string[] }).pinnedSessionIds.filter(
            (id) => this.isSessionAllowedSync(context.auth, id),
          ),
        };
      }
      return reply;
    }

    throw new RpcError("auth/forbidden", `Method ${method} is not permitted for this access key.`);
  }

  async guardStream(
    endpoint: string,
    args: Record<string, unknown>,
    sink: StreamSink,
    next: () => Promise<void>,
  ): Promise<void> {
    const policy = this.requirePolicy(sink.auth);
    if (policy === undefined) return next();

    if (
      endpoint === "$events" ||
      endpoint === "workspace/follow" ||
      endpoint === "session/control"
    ) {
      return next();
    }

    if (endpoint === "session/follow") {
      const sessionId = extractSessionId(args);
      if (!sessionId) throw new RpcError("auth/forbidden", "A permitted session is required.");
      await this.assertSessionAllowed(sessionId, policy);
      return next();
    }

    if (
      endpoint.startsWith("workspaceFiles/") ||
      endpoint.startsWith("officeToPdf/") ||
      endpoint.startsWith("terminal/")
    ) {
      await this.authorizeDsh(endpoint, args, sink.auth);
      return next();
    }

    throw new RpcError(
      "auth/forbidden",
      `Stream ${endpoint} is not permitted for this access key.`,
    );
  }

  isWorkspaceAllowed(auth: RequestAuth | undefined, workspace: WorkspaceView): boolean {
    if (auth?.scope !== "scoped") return true;
    if (workspace.remote) return false;
    const policy = this.livePolicy(auth);
    if (!policy) return false;
    return isPathWithinRoots(workspace.path, policy.allowedProjectPaths);
  }

  isSessionAllowedSync(auth: RequestAuth | undefined, sessionId: string): boolean {
    if (auth?.scope !== "scoped") return true;
    if (!sessionId || sessionId.startsWith("web-remote:")) return false;
    const policy = this.livePolicy(auth);
    if (!policy) return false;
    const cwd = this.sessions.sessionCwdSync(sessionId);
    return isPathWithinRoots(cwd, policy.allowedProjectPaths);
  }

  canDeliverEvent(auth: RequestAuth | undefined, event: string, args: readonly unknown[]): boolean {
    if (auth?.scope !== "scoped") return true;
    const policy = this.livePolicy(auth);
    if (!policy) return false;
    if (event === "codexhost/harness-inspection-changed") return true;
    if (event === "api-session/added") {
      const summary = args[0] as { sessionId?: unknown; cwd?: unknown } | undefined;
      if (typeof summary?.sessionId !== "string" || summary.sessionId.startsWith("web-remote:"))
        return false;
      return isPathWithinRoots(
        typeof summary.cwd === "string" ? summary.cwd : undefined,
        policy.allowedProjectPaths,
      );
    }
    if (event === "api-session/removed" || event === "api-session/status") {
      return typeof args[0] === "string" && this.isSessionAllowedSync(auth, args[0]);
    }
    if (event === "codexhost/session-bound") {
      return (
        (typeof args[1] === "string" && this.isSessionAllowedSync(auth, args[1])) ||
        (typeof args[0] === "string" && this.isSessionAllowedSync(auth, args[0]))
      );
    }
    return false;
  }

  canDeliverWaterfall(auth: RequestAuth | undefined, agentId: string): boolean {
    if (auth?.scope !== "scoped") return true;
    return this.isSessionAllowedSync(auth, agentId);
  }

  canDeliverPush(owner: string | undefined, cwd: string | undefined): boolean {
    if (!owner || !owner.startsWith(SCOPED_CREDENTIAL_PREFIX)) return true;
    const policy = this.policies.policyFor(owner);
    if (!policy) return false;
    return isPathWithinRoots(cwd, policy.allowedProjectPaths);
  }

  isPrimaryHttpRequest(request: IncomingMessage): boolean {
    const auth = this.policies.getRequestAuth(request);
    return auth !== undefined && auth.scope === "full";
  }
}
