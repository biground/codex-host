import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  filterModelCatalog,
  isModelAllowed,
  isPathWithinRoots,
  resolveContainedFilePath,
  WebAccessPolicyRegistry,
  type ModelCatalogShape,
} from "../src/access-policy.ts";
import type { WebAccessPolicy } from "@codexhost/dsh-web-backend";

it("enforces path containment including sibling prefixes, traversal, and symlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexhost-access-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectA = join(root, "project-a");
  const projectASecret = join(root, "project-a-secret");
  const nested = join(projectA, "src");
  mkdirSync(nested, { recursive: true });
  mkdirSync(projectASecret, { recursive: true });
  writeFileSync(join(nested, "app.ts"), "export const ok = true;\n");
  writeFileSync(join(projectASecret, "secret.txt"), "top-secret\n");

  assert.equal(isPathWithinRoots(projectA, [projectA]), true);
  assert.equal(isPathWithinRoots(nested, [projectA]), true);
  assert.equal(isPathWithinRoots(join(nested, "future-file.ts"), [projectA]), true);
  assert.equal(isPathWithinRoots(projectASecret, [projectA]), false);
  assert.equal(isPathWithinRoots(join(projectA, "..", "project-a-secret"), [projectA]), false);
  assert.equal(isPathWithinRoots("relative/path", [projectA]), false);
  assert.equal(isPathWithinRoots(projectA, []), false);

  assert.ok(resolveContainedFilePath(projectA, "src/app.ts", [projectA]));
  assert.equal(
    resolveContainedFilePath(projectA, "../project-a-secret/secret.txt", [projectA]),
    undefined,
  );
  assert.equal(
    resolveContainedFilePath(projectA, join(projectASecret, "secret.txt"), [projectA]),
    undefined,
  );
  if (process.platform === "win32") {
    const posixDrivePath = `/${join(projectASecret, "secret.txt").replace(/\\/gu, "/")}`;
    assert.equal(resolveContainedFilePath(projectA, posixDrivePath, [projectA]), undefined);
  }

  // Symlink inside projectA pointing outside must be rejected when platform permits symlink creation.
  const linkPath = join(projectA, "escape-link");
  let symlinkCreated = false;
  try {
    symlinkSync(projectASecret, linkPath, process.platform === "win32" ? "junction" : "dir");
    symlinkCreated = true;
  } catch {
    // Unprivileged Windows environments may reject symlink creation.
  }
  if (symlinkCreated) {
    assert.equal(isPathWithinRoots(join(linkPath, "secret.txt"), [projectA]), false);
    assert.equal(
      resolveContainedFilePath(projectA, "escape-link/secret.txt", [projectA]),
      undefined,
    );
  }
});

it("filters model catalogs strictly by allowed (provider, model) pairs", () => {
  const catalog: ModelCatalogShape = {
    default: { provider: "codex", model: "gpt-5.4" },
    routableProviders: ["codex", "claude-code"],
    harnessOrder: ["codex", "claude-code"],
    rememberedSelections: {
      codex: { provider: "codex", model: "gpt-5.4" },
      "claude-code": { provider: "claude-code", model: "claude-sonnet" },
    },
    modelFavorites: {
      codex: ["gpt-5.4", "gpt-5.4-mini"],
      "claude-code": ["claude-sonnet", "claude-opus"],
    },
    preferencesAvailable: true,
    failures: [
      { id: "codex", name: "Codex", message: "codex err" },
      { id: "pi", name: "Pi", message: "pi err" },
    ],
    groups: [
      {
        id: "codex",
        name: "Codex",
        models: [
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            fastModel: "gpt-5.4-fast",
            ultrafastModel: "gpt-5.4-ultra",
          },
          { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
        ],
      },
      {
        id: "claude-code",
        name: "Claude Code",
        models: [
          { id: "claude-sonnet", name: "Sonnet" },
          { id: "claude-opus", name: "Opus" },
        ],
      },
    ],
  };

  const policy: WebAccessPolicy = {
    credentialId: "scoped:test:1",
    allowedProjectPaths: ["/workspace/a"],
    allowedModels: [
      { provider: "codex", model: "gpt-5.4-fast" },
      { provider: "claude-code", model: "claude-sonnet" },
    ],
    allowWorkspaceFiles: true,
    allowTerminal: false,
  };

  assert.equal(isModelAllowed(policy, "codex", "gpt-5.4"), false);
  assert.equal(isModelAllowed(policy, "codex", "gpt-5.4-fast"), true);

  const filtered = filterModelCatalog(catalog, policy);
  assert.deepEqual(filtered.routableProviders, ["codex", "claude-code"]);
  assert.deepEqual(filtered.default, { provider: "codex", model: "gpt-5.4-fast" });
  assert.equal(filtered.preferencesAvailable, false);
  assert.deepEqual(
    filtered.groups.map((group) => ({ id: group.id, models: group.models.map((m) => m.id) })),
    [
      { id: "codex", models: ["gpt-5.4-fast"] },
      { id: "claude-code", models: ["claude-sonnet"] },
    ],
  );
  assert.deepEqual(filtered.rememberedSelections, {
    "claude-code": { provider: "claude-code", model: "claude-sonnet" },
  });
  assert.deepEqual(filtered.modelFavorites, { "claude-code": ["claude-sonnet"] });
  assert.deepEqual(filtered.failures, [{ id: "codex", name: "Codex", message: "codex err" }]);

  assert.throws(
    () =>
      filterModelCatalog(catalog, {
        ...policy,
        allowedModels: [{ provider: "unknown", model: "none" }],
      }),
    /No permitted models/,
  );
});

it("enforces scoped credential namespacing and revokes active credentials on provider unload", () => {
  const registry = new WebAccessPolicyRegistry();
  const revoked: string[] = [];
  registry.onRevoked((id) => revoked.push(id));

  const dispose = registry.registerProvider({
    id: "test-provider",
    resolveToken: (candidate) => {
      if (candidate === "spoof-local") {
        return {
          credentialId: "local",
          policy: {
            credentialId: "local",
            allowedProjectPaths: [],
            allowedModels: [],
            allowWorkspaceFiles: false,
            allowTerminal: false,
          },
        };
      }
      if (candidate === "valid-key") {
        return {
          credentialId: "scoped:test:abc",
          policy: {
            credentialId: "scoped:test:abc",
            allowedProjectPaths: ["/proj"],
            allowedModels: [{ provider: "codex", model: "gpt-5.4" }],
            allowWorkspaceFiles: true,
            allowTerminal: false,
          },
        };
      }
      return undefined;
    },
    getPolicy: (id) =>
      id === "scoped:test:abc"
        ? {
            credentialId: "scoped:test:abc",
            allowedProjectPaths: ["/proj"],
            allowedModels: [{ provider: "codex", model: "gpt-5.4" }],
            allowWorkspaceFiles: true,
            allowTerminal: false,
          }
        : undefined,
    hasCredential: (id) => id === "scoped:test:abc",
    listCredentialIds: () => ["scoped:test:abc"],
  });

  // Spoofing non-scoped credential IDs must be rejected.
  assert.equal(registry.resolveToken("spoof-local"), undefined);
  assert.equal(registry.resolveToken("valid-key")?.credentialId, "scoped:test:abc");
  assert.equal(registry.has("scoped:test:abc"), true);

  dispose();
  assert.deepEqual(revoked, ["scoped:test:abc"]);
  assert.equal(registry.resolveToken("valid-key"), undefined);
  assert.equal(registry.policyFor("scoped:test:abc"), undefined);
});
