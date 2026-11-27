# Biground 个人分叉续接说明

本分支为 `fork/codex-biground-ver`，原名 `fork/agy-background-wake`，保存在个人远端 `https://github.com/biground/codex-host.git`。本地 worktree 目录仍叫 `agy-background-wake`，以保留已有构建脚本的目录约定。

## 源码与规则范围

上游基线为 `v0.28.1`（对应提交 `9d2151d12`），并预合入上游 `origin/main` 已合入的虚拟滚动防回弹修复 PR [#1288](https://github.com/BytePioneer-AI/codex-host/pull/1288)。原 PR [#1227](https://github.com/BytePioneer-AI/codex-host/pull/1227)（用量统计提速）等已由上游 `v0.28.0`/`v0.28.1` 原生合入，不再重复重放。分叉包含以下已提交实现：

| 提交说明 | 内容 |
| --- | --- |
| `fix(ui-chat)`（PR #1288） | 预合入上游 `origin/main` 修复长虚拟列表向下滚轮回弹与列表宽度重测（聊天虚拟滚动采用 `v0.28.1` 原生实现）。 |
| `feat(antigravity)` | Antigravity 脱离后台任务跟踪、日志追加、自唤醒与恢复（兼容 `v0.28.1` 原生标题与冷读）。 |
| `feat(watch)` | 防止后台任务未结清就结束委派；Web、Desktop 展示《监听中》。 |
| `perf(ui-conversation)` | 缓存 `threadReferenceOf()` 标题归一化。 |
| `feat(web)`（scoped-access） | 新增 `codexhostAccess` 次级远程访问权限策略扩展点与 `plugins/web-scoped-access` 插件，适配 `v0.28.1` WebRTC 侧栏浏览器、下载票据与远程 Peer 拦截。 |

换机维护所需的规则随本分支保存：

- [仓库协作规则](../../AGENTS.md)及仓库原有的 `.agents/skills/`：代码目录、包边界、验证与贡献要求。
- [工作区规则](workspace-AGENTS.md)：主分支保持纯净、活跃分叉注册表、升级重放步骤、验证命令与上游替代判定条件。这里保存的是父级工作区规则，表内路径以父级工作区为基准。
- [用户全局规则快照](global-AGENTS.md)：用户级协作、模型路由、备份和 Git 约定。该快照含旧机项目路径与工具路径，新机器按实际目录调整；放在本目录不会自动替换新机器的用户级配置。
- 仓库 `.agents/skills/` 中补存 `ponytail`、`grill-me`、`codexhost-delegation`、`test-driven-development`、`systematic-debugging`、`verification-before-completion`、`humanizer-zh` 及现存支持文件。它们用于保持上述规则引用的流程可读取。
- [构建与应用脚本](build-and-apply-agy-background-wake.mjs)：恢复到父级 `.work/` 后使用，安装记录中的分支名已同步为 `fork/codex-biground-ver`。
- [规则文件校验清单](rules-manifest.json)：记录上述规则、技能与脚本共 15 份文件的大小、保存文件 SHA-256 与原始源文件 SHA-256。为符合仓库约定，仅统一 UTF-8、LF 换行及文件末尾空行；规则正文已逐份核对一致。

本次只推送这条主分叉。其他工作树和独立扩展没有合并进来。认证文件、私钥、真实会话、依赖目录、运行日志、安装目录和本机备份未打包；新机器需自行登录与安装依赖。

## 在另一台机器恢复

以下 PowerShell 命令在一个新建的空工作区中执行。保留 `agy-background-wake` 目录名，脚本便能沿用现有目录约定：

```powershell
git clone --branch fork/codex-biground-ver --single-branch https://github.com/biground/codex-host.git agy-background-wake
git -C agy-background-wake remote rename origin fork
git -C agy-background-wake remote add origin https://github.com/BytePioneer-AI/codex-host.git
git -C agy-background-wake fetch origin --tags

New-Item -ItemType Directory -Path .work -Force | Out-Null
Copy-Item -LiteralPath agy-background-wake/docs/local-fork/workspace-AGENTS.md -Destination AGENTS.md
Copy-Item -LiteralPath agy-background-wake/docs/local-fork/build-and-apply-agy-background-wake.mjs -Destination .work/build-and-apply-agy-background-wake.mjs
```

恢复后的布局为：

```text
<工作区>/
  AGENTS.md
  .work/
    build-and-apply-agy-background-wake.mjs
  agy-background-wake/
    AGENTS.md
    .agents/skills/
    docs/local-fork/
    packages/
    apps/
```

父级规则中 `codex-host/` 指的是原先独立的上游 checkout；仅维护本分叉时，直接使用 `agy-background-wake/AGENTS.md` 阅读同一套仓库约束即可。需要独立检查上游源码时，可另建 `codex-host/` checkout；不要将定制提交写入其 `main`。

新会话从 `agy-background-wake/` 开始，先读取根 `AGENTS.md` 和本说明。用户全局规则需要成为新机器的全局默认时，先备份并合并新机器已有的 `~/.codex/AGENTS.md`，再按实际路径迁移快照内容。

## 构建、检查与应用

使用 `package.json` 声明支持的 Node.js 版本及 `packageManager` 中的 npm 版本。安装锁定依赖并构建：

```powershell
Set-Location agy-background-wake
npm.cmd ci
npm.cmd run build:typescript
npm.cmd run build:renderer
npm.cmd run typecheck
npm.cmd run lint
node --import tsx --test packages/web-server/test/ch-watching.test.ts apps/web-ui/packages/client/ui-workspace/test/thread-tree.test.ts apps/web-ui/packages/client/ui-workspace/test/sidebar-window.test.ts
npx.cmd vitest run --config tests/vitest.config.js packages/adapters/antigravity/test/background-tasks.test.ts packages/host-runtime/test/app-server-host.watching.test.ts packages/renderer-extension/test/renderer-watching.test.ts apps/web-ui/packages/client/ui-codexhost/test/session-watching.test.ts
Set-Location ..
node .work/build-and-apply-agy-background-wake.mjs --stage-only
```

脚本目前构建 Windows x64 发布资源。默认安装路径来自旧机器；应用前必须将 `CODEXHOST_LIVE_APP_DIR` 设置为新机器核对过的 CodexHost `app` 绝对路径。先按工作区规则备份原始安装目录并记录 SHA-256，再在 Host 没有在途任务时应用：

```powershell
# 将下列示例替换为已经核对的真实安装目录。
$env:CODEXHOST_LIVE_APP_DIR = 'D:/actual/codexhost/app'
node .work/build-and-apply-agy-background-wake.mjs --apply-only
```

`--stage-only` 只准备产物；`--apply-only` 会替换安装资源并校验 SHA-256，不创建原版备份，也不会自动重启 Host。应用后按需重启 Host 并重开 Desktop、刷新 Web。macOS、Linux 或非 x64 目标需先适配脚本的平台与资源检查，不能直接沿用此安装步骤。

后续升级遵循[工作区规则](workspace-AGENTS.md)：先检查上游是否同时覆盖后台任务跟踪、防委派早退、双端监听提示和侧栏优化；仍有缺项时在独立分叉重放，并完成注册表要求的构建、检查和定向测试后再应用。相同基线仅改分支名和续接文档时无需重放源码。
