# dsh-sidebar-more

把左侧栏的面板入口按需收进「更多」菜单，给下方的工作区与会话列表腾出高度。安装后不预设折叠，现有布局一行不动。

## 功能

- 除平台硬锁的「插件」外，所有面板入口都能收起，包括宿主自带的技能、归档会话、自动化任务；
- 首次安装不预设折叠：现有入口原样留在侧栏，在「更多」里点「收起『X』」才收；
- 「更多」菜单里可以打开或收起任一面板，「全部放回侧栏」一键还原；
- 「新插件自动收进更多」控制之后新出现的入口是否自动收起（默认开）；
- 选择存在 `localStorage`，刷新页面、重启客户端都保留。

## 安装

```bash
dsh plugin add dsh-sidebar-more
```

插件页「安装」输入框填包名同样可以，也接受 Git 地址、tgz 与本地绝对路径。

要求：dsh 客户端 ≥ 0.2.1-rc.3 且 < 0.3.0（带 Web 界面）；Node.js ≥ 22。

## 它改了什么、没改什么

只隐藏导航栏里的入口行（对该行所在的 `nav` 直接子节点设 `display: none`）。面板本身、注册项、当前选中态、快捷键都不动，被收起的面板仍能通过「更多 → 打开『X』」进入；卸载时行会被还原。

## 为什么「插件」不能收

`dsh-client-ui-sidebar` 里三处写死：原生 Pin 回调不认它、渲染时无条件画它、「更多」菜单的 `entries` 也不带它。宿主这么设计是因为插件页是插件管理的唯一入口，它自己消失会让用户无法禁用出问题的插件。本插件在 DOM 层理论上能绕过，但故意不绕。

## 数据与诊断

`localStorage["dsh.sidebar-more.v1"]`：

```json
{
  "folded": ["some-panel-id"],
  "unfolded": [],
  "autoFoldNew": true,
  "seen": ["plugins", "some-panel-id", "…"],
  "seededAt": 1763200000000
}
```

- `folded`：显式收起的面板 id（生效依据）；
- `unfolded`：显式放回过的 id，记下用户的明确选择；
- `seen`：本插件见过的全部面板 id，用来区分「之后新出现的入口」与「老面板」；
- `autoFoldNew`：之后新出现的入口是否自动进 `folded`；
- `seededAt`：首轮播种时间戳，用于下面的宽限窗口。

首轮（`seen` 为空）只记录面板集合与时间戳，**不折叠任何入口**；此后完全以 `folded` 为准，不覆盖老用户的选择。客户端插件是按需加载的，首轮 15 秒内晚到注册的入口只记进 `seen`、不自动收起，避免把启动时的批次差异当成新插件。`plugins` 永不收起。清空这个键即恢复默认。

另有一条诊断记录 `localStorage["dsh.sidebar-more.lastpass"]`：`{at, panels, rows, navFound, applied, hidden[], visibility}`。排查「看着没生效」时直接读它。

## 卸载

插件页卸载，或还原安装前的 profile `package.json`；行上的内联 `style` 会被清掉。

## 开发

- 客户端半边 `lib/client.js` 手写 `window.__ModuleLoader__.load({ id, factory })`，只依赖平台冻结模块 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`；
- 面板清单来自 `ctx.slots.entriesOfSlot("sidebar.panellist")`（与侧栏同步逻辑同构：按 `order` 升序），label 走 `resolveSlotLabel` 语义；
- 折叠同步的触发点：启动（80/300/900/2400 ms 四次重试）、`ctx.slots.subscribe("sidebar.panellist")`、`body` 的 `childList` MutationObserver（rAF 合并）、`visibilitychange`、`focus` / `pageshow`；
- 按行识别，不按按钮计数：每行只取「主按钮」（带 `aria-label`、不带 `aria-haspopup`），新增的「取消固定」等次要按钮不会干扰；面板与 DOM 行按 `aria-label` 匹配，不依赖行序；
- 全链路 fail-open：一行都对不上面板清单时整轮放弃；个别行缺失时其余行照常处理，绝不隐藏错行。

## 变更记录

### 0.2.2

- 适配 dsh 0.2.2 的侧栏结构：面板行在展开态会多渲染一个「取消固定」按钮，旧版「按钮数必须等于面板数」的校验因此恒失败、收起完全失效；
- 改为按行取主按钮识别、按 aria-label 匹配面板，不再依赖按钮数量与行序；个别行缺失时其余行照常收起；
- 诊断记录新增 matched（匹配到几行）与 navLabel（选中的导航栏 aria-label），便于排查 DOM 变化。

### 0.2.1

- 去掉写死的首轮默认折叠名单：首次安装不再预设收起任何入口，现有侧栏布局一行不动；
- 新增 `seededAt` 与 15 秒宽限窗口：客户端插件按需加载，首轮晚到注册的入口只记进 `seen`，不会被误判成「新装插件」自动收起；
- 老用户的 `folded` / `unfolded` / `autoFoldNew` 逐字段保持不变；
- 新增 `engines.dsh`（`>=0.2.1-rc.3 <0.3.0`），插件市场不再标记「未声明宿主版本要求」。

### 0.2.0

首个公开发布版本：功能与 0.1.1 一致，补齐 LICENSE、仓库元数据、中英 README 与自动 Release 工作流。

### 0.1.1

- 只锁 `plugins`，技能 / 归档会话 / 自动化任务可自由收起；
- 加 `seen` 与默认名单播种；
- 去掉 `document.hidden` 早退，加前台 / 聚焦补跑与启动重试；
- 新增 `lastpass` 诊断记录。

### 0.1.0

首版。

## License

MIT

---

## English

Fold left-sidebar panel entries into a "More" menu on demand and give the workspace and session list their height back. Nothing is folded on install, so your current layout stays as it is.

### Features

- Every panel entry except the hard-locked "Plugins" one can be folded, including the built-in Skills, Archived sessions and Automation;
- First install folds nothing: existing entries stay where they are until you pick "Hide 'X' from sidebar" in the More menu;
- Open or fold any panel from the More menu, or restore everything with one click;
- "Auto-hide new plugin entries" controls whether entries that show up later are folded automatically;
- The choice lives in `localStorage` and survives reloads and restarts.

### Install

```bash
dsh plugin add dsh-sidebar-more
```

The install field in the dsh plugin page accepts the same value, plus a Git address, a tarball, or an absolute local path.

Requires dsh client ≥ 0.2.1-rc.3 and < 0.3.0 with the Web UI, and Node.js ≥ 22.

### What it changes

It only hides the entry rows in the navigation bar. Panels, registrations, the active panel and keyboard shortcuts stay untouched; a folded panel is still reachable through "More → Open 'X'", and the rows are restored on uninstall.

### License

MIT
