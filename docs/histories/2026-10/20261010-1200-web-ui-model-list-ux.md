## [2026-10-10 12:00] | Task: 优化 Web UI 模型列表交互（异步开关 / 启用筛选 / 复制模型 ID）

### 🤖 Execution Context
* **Agent ID**: `codebuddy (Space-Bunny)`
* **Base Model**: `space-bunny`
* **Runtime**: `CodeBuddy IDE (macOS)`
* **Git User**: `liutao <liutaotao@mytijian.com>`
* **Branch**: `main`

### 📥 User Query
> web端有几个问题：
> 1. 模型列表启用禁用开关点击时，没有反应，要等接口调用完了，页面刷新了才更新状态，延迟感太强了，希望异步调用，有loading状态
> 2. 模型列表添加一个 只显示启用的模型 的功能
> 3. 每个模型后添加一个复制模型ID的功能（用一个图标按钮操作）

### 🛠 Changes Overview
**Scope:** `src/ui/`（Web UI 前端，纯前端改动，未触碰 `src/webui.ts` 与 `/ui/api/*` 契约）

**Key Actions:**
- **修复模型开关回跳**: 移除 `queueSave` 成功回调里的 `setPendingEnabled(null)`。原先响应一返回就清掉乐观白名单，而此刻本地 `config` 仍是服务端旧值，开关会先跳到新状态、再闪回旧状态、直到 `loadConfig()` 拿到新配置才第三次跳回来——这就是「要等接口调完页面刷新才更新」的根因。改为在 `loadConfig()` 里用 `sameModelList()` 比对，服务端确认后才撤销乐观值。
- **行级 loading**: 新增 `pendingSlugs` 状态与 `pendingCallbacksRef`，`toggleModel` 点击即把该行标记为 pending，提交期间在行内渲染旋转图标（`aria-busy`），提交成功或失败后清除；debounce 合并的多次点击共用同一次收尾。保存失败时回滚乐观值，界面回到服务端真值而不是停在假状态。
- **重启期可见禁用**: 模型行的 checkbox 补上 `disabled` 与 `.switch.disabled`，替换原先 `if (phase === "restarting") return;` 的静默丢弃。
- **只显示启用的模型**: 卡片头部新增 inline checkbox 筛选，只影响展示不改变白名单语义；筛选后为空时显示「没有启用的模型」而非「暂无模型」；选择写入 `localStorage`。provider 侧模型数徽标改为统计未筛选前的总数。
- **复制模型 ID**: 复用已有的 `CopyButton` 组件，在每行操作区加入图标按钮（复制后短暂显示「已复制」）；顺手修掉 `navigator.clipboard` 缺失时 `.then` 抛 TypeError 的隐患。
- **样式与文案**: `styles.css` 新增 `.card-header-actions` / `.inline-check` / `.model-row` / `.model-row-actions` / `.model-row-pending` / `@keyframes ui-spin`；`i18n.tsx` 新增 `modelsNoneEnabled` / `showOnlyEnabled` / `copyModelId` 中英双份。

### 🧠 Design Intent (Why)
* 用户看到的是「点了没反应」，但代码里其实已有乐观更新——真正的观感问题是乐观值被过早撤销造成的两次闪回，以及重启窗口内点击被无声吞掉。因此本次不重写保存链路（debounce 合并 + 单次重启的设计要保留），只修正乐观值的生命周期：点击即翻转、提交期间有 loading、失败才回滚、服务端确认才交还控制权。
* 筛选与复制都是纯展示层能力，不改后端契约、不改 `enabledModels` 语义，避免为了 UI 便利而扩大配置面的风险。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD）。注意：这 3 个文件在本次任务前已有其它未提交改动，下表行数因此含那些改动的量。

- **Files changed（本任务）:** 3
- **Insertions:** +276
- **Deletions:** -223

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/ui/ConfigPage.tsx` | +222 | -158 |
| `src/ui/styles.css` | +46 | -53 |
| `src/ui/i18n.tsx` | +8 | -12 |

### 📁 Files Modified
- `src/ui/ConfigPage.tsx`
- `src/ui/i18n.tsx`
- `src/ui/styles.css`

### ✅ Verification
- `bun run check`（typecheck + 318 项测试 + build）全绿；`dist/ui/` 已重新构建。