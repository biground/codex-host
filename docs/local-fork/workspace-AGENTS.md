# CodexHost 本地工作区与定制 Fork 分支协作规则

## 工作区定位

本目录承载 [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) 的本地上游仓库（`codex-host/`）、独立定制 Fork 分支工作树（worktrees）以及配套界面扩展与远程接入配置。

`codex-host/` 内部的代码结构、包边界（如 Adapter 与 `host-runtime` 解耦）及测试命令以仓库自带的 [codex-host/AGENTS.md](./codex-host/AGENTS.md) 为准；**分支管理、上游修复 PR 隔离与随上游更新重放定制内容的规则以本文件为最高准则**。

---

## 核心分支管理与更新重放规则（必守）

1. **三层分支优先级（最高裁决原则）：`上游 > 修复 PR > 个人定制 Fork`**
   - 本工作区涉及三类代码线，遇到任何设计分歧、代码冲突、回归适配或合并顺序决策时，严格按以下优先级裁决：
     1. **上游（`origin/main` / 官方 Release Tag）**：最高权威。
     2. **上游修复 PR 分支（准备提交给 `BytePioneer-AI/codex-host` 的 `fix/*` / `pr/*` 等分支）**：次高优先级，仅面向纯净上游负责。
     3. **个人定制 Fork 分支（`fork/*`）**：最低优先级，必须主动向下兼容上游与修复 PR 的改动，绝不允许反向约束或污染前两者。

2. **主分支保持纯净，且分叉仅保留单一主干**
   - 上游 `main` 分支及官方发布标签（如 `v0.28.1`）仅同步上游代码，**禁止将个人定制功能或私有补丁直接合入本地 `main`**。
   - 个人定制修改统一归拢到唯一活跃分叉主干 `fork/codex-biground-ver`（worktree：`agy-background-wake/`），并在下方「活跃定制 Fork 分支注册表」登记；**分叉不允许长期残留独立分支**，任何在独立分支上完成并验证的个人定制必须合回 `fork/codex-biground-ver` 后清理本地分支与冗余 worktree（仅在途未合入上游 PR 的远端分支按需保留至 PR 闭环）。

3. **向上游提交修复 PR 分支的隔离与兼容规范**
   当用户要针对 `BytePioneer-AI/codex-host` 准备或提交修复 PR（上游修复分叉）时，必须严格遵守以下要求：
   - **纯净基线与物理隔离（严禁受个人 Fork 代码影响）**：
     - 必须直接从最新纯净上游 `origin/main`（或指定的纯净上游提交）切出独立修复分支及专属同级 Git worktree，**严禁从任何 `fork/*` 分支（如 `fork/codex-biground-ver` / `agy-background-wake/`）派生**。
     - 问题复现、方案设计、代码实现、类型/Lint 校验与测试验证都必须在纯净上游基线上独立完成；**禁止引用、依赖或夹带任何个人定制 Fork 分支的提交、契约、字段、接口假设或本地运行补丁**。
     - 复现与验证时必须与本机已部署个人 Fork 产物的共享运行环境隔离，避免把个人 Fork 的行为误判为上游现状。
     - 推送与提 PR 前，必须通过 `git log origin/main..HEAD` 与 `git diff origin/main...HEAD` 核查，确保提交历史与改动范围仅包含该上游修复本身的最小纯净变更。
   - **个人定制 Fork 必须兼容修复 PR**：
     - 修复 PR 分支始终保持面向纯净上游的独立状态，绝不为了迁就个人定制 Fork 而修改、妥协或添加兼容代码。
     - 相反，个人定制 Fork 分支（如 `fork/codex-biground-ver`）**必须主动兼容修复 PR 的内容**：当修复 PR 与个人 Fork 存在交集或需要本机同时生效时，在个人 Fork 侧合入/重放修复 PR 的改动并由个人 Fork 负责解决冲突与适配，冲突裁决一律以修复 PR（及上游）实现为准，并完整跑通个人 Fork 的必跑验证命令。
     - 当修复 PR 被上游合入（或上游以等价方案修复）后，按第 4 条流程升级个人 Fork 至新上游基线并去除重复补丁，同时归档或清理已合入的 PR 临时 worktree。

4. **更新 / 升级 CodexHost 时的标准处理流程**
   每当用户通过会话更新 `codexhost`（包括拉取上游最新 `main`/Release Tag，或升级本机 `@codexhost/cli` / Desktop / Web 运行环境）时，执行代理必须按 **`上游 → 在途修复 PR → 个人定制 Fork`** 的顺序，逐一核查在途修复 PR 及下方**「活跃定制 Fork 分支注册表」**中的全部分支，严格按以下三步闭环：

   - **第一步：核查上游主分支是否已原生修复同一问题**
     - 拉取最新 `origin`（`git -C codex-host fetch origin --tags`），对照注册表中该分支的「上游替代判定条件」（以及在途修复 PR 的合入状态），检查新主分支/新版本源码是否已经原生解决了相同问题（含关键边界条件）。
     - **若主分支已修复相同问题**：**不再重放**该分支；若是个人定制 Fork，将其从「活跃定制 Fork 分支注册表」移入「已由上游覆盖归档」，在 [README.md](./README.md) 记录覆盖该问题的上游版本或提交号，直接使用上游原生实现。

   - **第二步：按优先级重放分支到新基线（上游未修复时）**
     - **先处理在途修复 PR 分支**（如有）：在纯净 PR worktree 中将其 `rebase` 到最新 `origin/main` 并验证，保持与个人 Fork 零耦合。
     - **再重放个人定制 Fork 分支**：在对应独立 worktree 中，将其 `rebase`（或基于新目标 tag / `origin/main` 重新 cherry-pick 对齐）到最新上游基线上，并确保完全兼容仍在途的上游修复 PR 内容（冲突时服从 `上游 > 修复 PR > 个人定制 Fork`）。
     - 解决潜在冲突后，必须完整跑通该分支登记的构建、类型检查、边界 Lint 与定向测试，严禁未经编译测试直接替换产物。

   - **第三步：备份原版产物并同步应用到本机运行环境**
     - 将本机新版本原始产物备份至 `.work/backups/<日期-版本-分支名>/` 并记录 SHA-256。
     - 将定制分支重放构建出的产物（例如 `packages/host-runtime/dist/plugins/antigravity/plugin.mjs` 等）应用到本机安装路径；若当前共享 Host 有在途任务运行，先准备好构建产物与切换脚本并提示用户在空闲时重启 Host 生效，最后同步更新 [README.md](./README.md) 中的当前基线版本与校验哈希。

---

## 活跃定制 Fork 分支注册表

| 分支名 | Worktree 目录 | 当前上游基线 | 解决的问题与核心机制 | 涉及包与产物路径 | 必跑验证命令 | 上游替代判定条件（满足即退役本分支） |
| --- | --- | --- | --- | --- | --- | --- |
| `fork/codex-biground-ver` | [./agy-background-wake/](./agy-background-wake/) | `v0.28.1`（`9d2151d12`；附上游 `origin/main` 已合入的 PR [#1288](https://github.com/BytePioneer-AI/codex-host/pull/1288) 虚拟滚动防回弹修复 `acc1a8e26`/`a987fe4fb`；关联上游 [#1120](https://github.com/BytePioneer-AI/codex-host/issues/1120)） | 1) 跟踪 Antigravity (`agy`) 超 10s 自动脱离后台 `task-*` 与一次性 `schedule`，流式追加日志、`hasBackgroundWork()` 防 30 分钟 `idleRelease` 误杀、动态唤醒续租及悬空结果幂等唤醒恢复（兼容 `v0.28.1` 原生标题与冷读）；<br/>2) 保持前景发消息不阻塞，但令委派子会话在仍有后台脱离任务或自治唤醒时维持 `running`，防 `thread watch` 提前回调；<br/>3) 新增 `codexhost/thread/watching/{read,updated}`，在 Web（侧栏行、悬停卡、会话内状态条，兼容桌面与手机窄屏）及 Desktop（侧栏行与底部 Composer 胶囊，原生 Codex 与外部 Harness 均生效）实时展示《监听中》标识；<br/>4) 为 `threadReferenceOf()` 增加标题归一化缓存；<br/>5) 归拢 `codexhostAccess` 次级远程访问权限策略扩展点与 `plugins/web-scoped-access` 插件（按项目/模型白名单 fail-closed 隔离 HTTP、RPC、DSH、WebSocket、WebRTC 侧栏浏览器、远程 Peer、下载票据与 Web Push）；<br/>6) 预合入上游 `origin/main` PR [#1288](https://github.com/BytePioneer-AI/codex-host/pull/1288)（长虚拟列表向下滚轮防回弹与列表宽度重测；聊天虚拟滚动本身采用 `v0.28.1` 原生 `use-transcript-virtualization`）。 | 源码：`packages/adapters/antigravity`、`packages/shared-contracts`、`packages/harness-adapter`、`packages/harness-broker`、`packages/host-runtime`、`packages/session-runtime`、`packages/web-server`、`apps/web-ui`、`packages/renderer-extension`、`plugins/web-scoped-access`<br/>一键构建与本机替换：`node .work/build-and-apply-agy-background-wake.mjs`（校验记录：`.work/agy-background-wake-install.json`）<br/>原版全量备份：`.work/backups/20261126-v0.27.0-upgrade/npm-v0.27.0-orig/`（升级至 `v0.28.1` 时新建 `npm-v0.28.1-orig/` 备份） | `npm.cmd run build:typescript`<br/>`npm.cmd run build:renderer`<br/>`npx.cmd tsc -b --pretty false`<br/>`node tools/check-boundaries.mjs`<br/>`node --import tsx --test packages/web-server/test/ch-watching.test.ts packages/web-server/test/access-policy.test.ts packages/web-server/test/scoped-access-plugin.test.ts packages/web-server/test/push.test.ts packages/web-server/test/workspace-file-actions.test.ts packages/web-server/test/remote-peer-workspace-files.test.ts packages/web-server/test/relay-authenticated-access.test.ts apps/web-ui/packages/client/ui-workspace/test/thread-tree.test.ts apps/web-ui/packages/client/ui-workspace/test/sidebar-window.test.ts`<br/>`npx.cmd vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/background-tasks.test.ts packages/harness-broker/test/validation-background.test.ts packages/host-runtime/test/app-server-host.watching.test.ts packages/renderer-extension/test/renderer-watching.test.ts apps/web-ui/packages/client/ui-codexhost/test/session-watching.test.ts apps/web-ui/packages/client/ui-chat/test/transcript-virtualization.test.ts apps/web-ui/packages/client/ui-chat/test/chat-scroll.test.ts` | 上游同时原生具备：① `antigravity` 后台 `task-*` 实时增量日志与断联恢复；② 子会话后台脱离任务未结清前不提前将委派标为 `completed` 触发 `thread watch`；③ Web 与 Desktop 双端人工可见的《监听中》状态提示；④ `threadReferenceOf()` 标题归一化缓存；⑤ `codexhostAccess` 次级访问策略扩展点与插件。缺一则继续 rebase 重放本分支。 |

---

## 已由上游覆盖归档

| 原分支名 | 覆盖上游版本 / PR | 处置结果 |
| --- | --- | --- |
| `fix/usage-statistics-performance` | `v0.28.0` / PR [#1227](https://github.com/BytePioneer-AI/codex-host/pull/1227)（`472372b64`） | 上游原生覆盖；已从 `fork/codex-biground-ver` 移除重复补丁并清理本地/远端分支与 `usage-statistics-perf/` worktree。 |
| `fix/native-fork-model-inheritance` | 上游主干 / PR [#794](https://github.com/BytePioneer-AI/codex-host/pull/794)（`05d222137`） | 上游原生覆盖；已清理本地/远端分支与 `fork-model-inheritance/` worktree。 |
| `fix/web-native-async-questions` | 上游主干 / PR [#786](https://github.com/BytePioneer-AI/codex-host/pull/786) | 上游原生覆盖；已清理本地/远端分支，`codex-host/` 切回纯净 `main`。 |
| `feat/native-model-provider-switch` | 上游主干（`b0f9c4def` 已入基线） | 上游原生覆盖；已清理本地分支与 `native-provider-switch/` worktree。 |
| `feat/web-response-annotation-comments` | 上游主干（`06e4be13f` 已入基线） | 上游原生覆盖；已清理远端 `fork` 分支。 |
| `fix/web-mobile-question-scroll` | 上游主干（`c92e377a8` 已入基线） | 上游原生覆盖；已清理远端 `fork` 分支。 |
| `fix/web-harness-subagents` | 已提交部分入基线；未提交 OMP `/goal` 与左侧子会话树草稿按确认弃用 | 未提交改动已备份至 `.work/backups/20261127-v0.28.1-consolidation/web-harness-subagents-wip/`，并清理本地分支与 `web-harness-subagents/` worktree。 |
