/**
 * The right Sidebar's DSH backend inside the Web server.
 *
 * Web owns the listener, authentication, the same-origin gate, and the
 * WebSocket mux. This class forwards the Remote namespaces the embedded DSH
 * gateway claims and leaves every other `/api` request with the Web server's
 * own registries.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createDshWebBackend,
  type DshWebBackend,
  type WebAccessExtensionHost,
  type WebPluginRuntime,
  type WebPluginRuntimeOptions,
} from "@codexhost/dsh-web-backend";
export type { WebPluginRuntime } from "@codexhost/dsh-web-backend";

import type { RequestAuth } from "./auth.ts";
import { RpcError, type StreamSink } from "./transport.ts";

export interface DshWebServicesOptions {
  /** Release-only Office engine preparation, independent of request cancellation. */
  readonly ensureOfficeEngine?: () => boolean;
  /** Absolute workspace root the DSH sandbox policy reports. */
  readonly workspaceRoot: string;
  /** Terminal cwd for a known local Session: saved directory or Web user's home. */
  readonly threadWorkspace: (sessionId: string) => string | undefined;
  /** File access root for a local Thread or a workspace-bound draft. */
  readonly fileWorkspace?: (sessionId: string) => string | undefined;
  /** Optional CodexHost access-policy extension port exposed to trusted Web plugins. */
  readonly codexhostAccess?: WebAccessExtensionHost;
}

export class DshWebServices {
  private constructor(private readonly backend: DshWebBackend) {}

  /**
   * Mount the DSH services used by the right Sidebar.
   * @param options - workspace root and the local Session directory seam.
   * @returns the forwarding facade.
   */
  static async open(options: DshWebServicesOptions): Promise<DshWebServices> {
    return new DshWebServices(await createDshWebBackend(options));
  }

  /**
   * Forward one unary DSH Remote request.
   * @param request - the authenticated Web request.
   * @param body - its complete JSON envelope.
   * @param response - the response owned when the gateway claims the endpoint.
   * @returns true when DSH answered; false when the endpoint belongs to Web.
   */
  async handleApiRequest(
    request: IncomingMessage,
    body: string,
    response: ServerResponse,
    auth?: RequestAuth,
    authorize?: (
      method: string,
      args: Record<string, unknown>,
      auth: RequestAuth | undefined,
    ) => Promise<void> | void,
  ): Promise<boolean> {
    let envelope: { rpcId?: unknown; method?: unknown; payload?: { args?: unknown } };
    try {
      envelope = JSON.parse(body) as typeof envelope;
    } catch {
      return false;
    }
    const method = envelope.method;
    if (typeof method !== "string" || !this.backend.handles(method)) return false;
    if (authorize !== undefined) {
      const rawArgs = envelope.payload?.args;
      const args =
        typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      try {
        await authorize(method, args, auth);
      } catch (error) {
        const failure =
          error instanceof RpcError
            ? { code: error.code, message: error.message, details: error.details }
            : {
                code: "auth/forbidden",
                message: error instanceof Error ? error.message : "Access denied",
                details: {},
              };
        const reply = JSON.stringify({
          type: "server-response",
          rpcId: typeof envelope.rpcId === "string" ? envelope.rpcId : "",
          result: { ok: false, error: failure },
        });
        response
          .writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          })
          .end(reply);
        return true;
      }
    }
    // A browser that navigates away must cancel the DSH read or conversion it
    // started instead of leaving it running to completion.
    const lifetime = new AbortController();
    const abort = (): void => {
      lifetime.abort(new Error("Web request closed"));
    };
    request.once("close", abort);
    response.once("close", abort);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const answered = await this.backend.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            "content-type":
              typeof request.headers["content-type"] === "string"
                ? request.headers["content-type"]
                : "application/json",
          },
          body,
          signal: lifetime.signal,
        }),
      );
      const bytes = Buffer.from(await answered.arrayBuffer());
      if (lifetime.signal.aborted || response.destroyed) return true;
      const headers: Record<string, string> = { "cache-control": "no-store" };
      answered.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "cache-control") headers[name] = value;
      });
      headers["content-length"] = String(bytes.length);
      response.writeHead(answered.status, headers).end(bytes);
      return true;
    } finally {
      request.off("close", abort);
      response.off("close", abort);
    }
  }

  /**
   * Forward one DSH Remote stream into the Web mux.
   * @param endpoint - canonical `<namespace>/<method>` endpoint.
   * @param args - named wire arguments.
   * @param sink - the mux stream to fill.
   * @returns true when DSH owns the endpoint and the stream was opened.
   */
  stream(endpoint: string, args: Record<string, unknown>, sink: StreamSink): boolean {
    if (!this.backend.handles(endpoint)) return false;
    const lifetime = new AbortController();
    sink.onClose(() => lifetime.abort(new Error("Remote stream closed")));
    void (async () => {
      try {
        const source = await this.backend.openStream(endpoint, args, lifetime.signal, sink.input);
        for await (const value of source) {
          if (sink.closed || lifetime.signal.aborted) break;
          sink.push(value);
        }
        if (!sink.closed) sink.end();
      } catch (error) {
        if (sink.closed || lifetime.signal.aborted) return;
        const failure = this.backend.failure(error);
        sink.fail(failure.code, failure.message, failure.details);
      }
    })();
    return true;
  }

  loadPlugins(options: WebPluginRuntimeOptions): Promise<WebPluginRuntime> {
    return this.backend.loadPlugins(options);
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}
