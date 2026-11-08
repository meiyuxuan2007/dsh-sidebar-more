# dsh-sidebar-more

把左侧栏的面板入口收进「更多」菜单，给下方的工作区与会话列表腾出高度。

## 功能

- 除平台硬锁的「插件」外，所有面板入口都能收起，包括技能、归档会话、自动化任务；
- 首次安装默认收起：任务看板、QQ 机器人、上下文洞察、SSH，其余保持可见；
- 「更多」菜单里可以打开或收起任一面板，「全部放回侧栏」一键还原；
- 「新插件自动收进更多」控制以后新装的插件是否默认收起（默认开）；
- 选择存在 `localStorage`，刷新页面、重启客户端都保留。

## 安装

```bash
dsh plugin add dsh-sidebar-more
```

插件页「安装」输入框填包名同样可以，也接受 Git 地址、tgz 与本地绝对路径。

要求：dsh Web 客户端；Node.js ≥ 22。

## 它改了什么、没改什么

只隐藏导航栏里的入口行（对该行所在的 `nav` 直接子节点设 `display: none`）。面板本身、注册项、当前选中态、快捷键都不动，被收起的面板仍能通过「更多 → 打开『X』」进入；卸载时行会被还原。

## 为什么「插件」不能收

`dsh-client-ui-sidebar` 里三处写死：原生 Pin 回调不认它、渲染时无条件画它、「更多」菜单的 `entries` 也不带它。宿主这么设计是因为插件页是插件管理的唯一入口，它自己消失会让用户无法禁用出问题的插件。本插件在 DOM 层理论上能绕过，但故意不绕。

## 数据与诊断

`localStorage["dsh.sidebar-more.v1"]`：

```json
{
  "folded": ["dsh-taskboard", "im-qqbot", "dsh-context", "ssh"],
  "unfolded": [],
  "autoFoldNew": true,
  "seen": ["plugins", "skills-manager", "archived-sessions", "dsh-taskboard", "…"]
}
```

- `folded`：显式收起的面板 id（生效依据）；
- `unfolded`：显式放回过的 id，用于首次播种时不要把它又收回去；
- `seen`：本插件见过的全部面板 id，用来区分「新装的插件」与「老面板」；
- `autoFoldNew`：新出现的面板是否自动进 `folded`。

首轮（`seen` 为空）只播种一次默认名单，之后完全以 `folded` 为准，不覆盖老用户的选择；`plugins` 永不收起。清空这个键即恢复默认。

另有一条诊断记录 `localStorage["dsh.sidebar-more.lastpass"]`：`{at, panels, rows, navFound, applied, hidden[], visibility}`。排查「看着没生效」时直接读它。

## 卸载

插件页卸载，或还原安装前的 profile `package.json`；行上的内联 `style` 会被清掉。

## 开发

- 客户端半边 `lib/client.js` 手写 `window.__ModuleLoader__.load({ id, factory })`，只依赖平台冻结模块 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`；
- 面板清单来自 `ctx.slots.entriesOfSlot("sidebar.panellist")`（与侧栏同步逻辑同构：按 `order` 升序），label 走 `resolveSlotLabel` 语义；
- 折叠同步的触发点：启动（80/300/900/2400 ms 四次重试）、`ctx.slots.subscribe("sidebar.panellist")`、`body` 的 `childList` MutationObserver（rAF 合并）、`visibilitychange`、`focus` / `pageshow`；
- 全链路 fail-open：行数与面板数不一致，或任一 `aria-label` 对不上，就整轮放弃，绝不隐藏错行。

## 变更记录

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

Fold third-party plugin entries on the left sidebar into a "More" menu and give the workspace and session list their height back.

### Features

- Every panel entry except the hard-locked "Plugins" one can be folded, including Skills, Archived sessions and Automation;
- First install folds Taskboard, QQ Bot, Context Insights and SSH by default;
- Open or fold any panel from the More menu, or restore everything with one click;
- "Auto-fold new plugins" controls whether plugins installed later are folded by default;
- The choice lives in `localStorage` and survives reloads and restarts.

### Install

```bash
dsh plugin add dsh-sidebar-more
```

The install field in the dsh plugin page accepts the same value, plus a Git address, a tarball, or an absolute local path.

Requires a dsh client with the Web UI and Node.js ≥ 22.

### What it changes

It only hides the entry rows in the navigation bar. Panels, registrations, the active panel and keyboard shortcuts stay untouched; a folded panel is still reachable through "More → Open 'X'", and the rows are restored on uninstall.

### License

MIT
