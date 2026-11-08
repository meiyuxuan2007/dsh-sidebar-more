/**
 * dsh-sidebar-more — client half.
 *
 * 目的：侧栏（sidebar.panellist）的入口随插件增多不断变长，挤压下方的「工作区」
 * 与会话列表。本插件把面板入口行收进「更多」菜单（只有平台硬锁的「插件」除外）：
 *   - 菜单「打开『X』」→ 直接切到该面板（走 owner 的 onOpen，保留其埋点）；
 *   - 菜单「收起『X』」→ 该行从导航栏消失；
 *   - 「全部放回侧栏」一键还原；
 *   - 「新插件自动收进更多」开关控制默认策略（默认开）。
 * 折叠集合写 localStorage，刷新后仍生效。
 *
 * 实现纪律（与平台契约对齐）：
 *   1. 只用公开 API：entriesOfSlot/subscribe("sidebar.panellist")、注册
 *      sidebar.panellist.actions、owner 的 onOpen/onDismiss。不碰 SlotCore 的
 *      records/abdicated 等私有字段。
 *   2. 原生 pin（onPinnedChange → setPinned）只能在菜单打开时调用，而且是内存态
 *      （插件重载即重置、不读 localStorage），做不到「跨刷新保留」。所以折叠放在
 *      DOM 层：定位导航行按钮，对「nav 的直接子节点」设 inline display:none。
 *      只隐藏导航行，主面板、注册与当前选中态都不动。
 *   3. 全链路 fail-open：抓不到预期结构就放弃本轮，绝不抛错、绝不隐藏错行。
 *   4. 只用平台冻结模块：react / react/jsx-runtime / dsh-client-ui-primitives。
 */
window.__ModuleLoader__.load({
  id: "dsh-sidebar-more",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var jsxRuntime = require("react/jsx-runtime");
    var jsx = jsxRuntime.jsx;
    var Fragment = React.Fragment;

    var primitives = null;
    try {
      primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      primitives = null;
    }
    var MenuItemButton = primitives ? primitives.MenuItemButton : undefined;
    var IconCheck = primitives ? primitives.IconCheckOutlineRegular : undefined;

    var PANELS_SLOT = "sidebar.panellist";
    var ACTIONS_SLOT = "sidebar.panellist.actions";
    var LOCALE_NS = "sidebarMore";
    var STORAGE_KEY = "dsh.sidebar-more.v1";

    /**
     * 平台硬锁：`dsh-client-ui-sidebar` 在源码里写死「插件」入口不可收起
     * （createPanelPins 直接 return、"Plugins is never listed"），这里同样不提供
     * 「收起」项。其余面板（含宿主骨架 技能/归档会话/自动化任务）都可自由收放。
     */
    var PLATFORM_LOCKED = ["plugins"];
    /** 首次运行时的默认收起名单，只为保持默认观感；之后完全以 localStorage 为准。 */
    var DEFAULT_FOLDED = ["dsh-taskboard", "im-qqbot", "dsh-context", "ssh"];
    var HIDDEN_ATTR = "data-dsh-sidebar-more-hidden";
    var DIAG_KEY = "dsh.sidebar-more.lastpass";

    // ---------------------------------------------------------------- 状态

    function stringList(value) {
      var out = [];
      if (!Array.isArray(value)) return out;
      for (var i = 0; i < value.length; i += 1) {
        var item = value[i];
        if (typeof item === "string" && item.length > 0 && out.indexOf(item) < 0) out.push(item);
      }
      return out;
    }

    function readState() {
      var fallback = { folded: [], unfolded: [], autoFoldNew: true, seen: [] };
      try {
        if (typeof localStorage === "undefined") return fallback;
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return fallback;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return fallback;
        return {
          folded: stringList(parsed.folded),
          unfolded: stringList(parsed.unfolded),
          autoFoldNew: parsed.autoFoldNew !== false,
          seen: stringList(parsed.seen)
        };
      } catch (error) {
        return fallback;
      }
    }

    function writeState(state) {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          folded: stringList(state.folded),
          unfolded: stringList(state.unfolded),
          autoFoldNew: state.autoFoldNew !== false,
          seen: stringList(state.seen)
        }));
      } catch (error) {
        /* 配额满 / 隐私模式：本轮照常生效，只是不持久 */
      }
    }

    function withId(list, id) {
      var next = list.slice();
      if (next.indexOf(id) < 0) next.push(id);
      return next;
    }

    function withoutId(list, id) {
      var next = [];
      for (var i = 0; i < list.length; i += 1) if (list[i] !== id) next.push(list[i]);
      return next;
    }

    // ------------------------------------------------------------- 面板清单

    function resolveLabel(value, fallback) {
      var label = value;
      try {
        if (typeof value === "function") label = value();
      } catch (error) {
        label = undefined;
      }
      return typeof label === "string" && label.length > 0 ? label : fallback;
    }

    /**
     * 与侧栏 syncPanels 同构：entriesOfSlot → {id, order, label}，按 order 稳定升序。
     * entriesOfSlot 已按注册顺序返回、按 id 去重并跳过被取代的 entry。
     */
    function listPanels(ctx) {
      try {
        var slots = ctx && ctx.slots;
        if (!slots || typeof slots.entriesOfSlot !== "function") return null;
        var entries = slots.entriesOfSlot(PANELS_SLOT);
        if (!Array.isArray(entries)) return null;
        var panels = [];
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          var options = entry && entry.options ? entry.options : null;
          var id = options ? options.id : undefined;
          if (typeof id !== "string" || id.length === 0) continue;
          panels.push({
            id: id,
            order: typeof options.order === "number" ? options.order : 0,
            label: resolveLabel(options.label, id)
          });
        }
        panels.sort(function (left, right) { return left.order - right.order; });
        return panels;
      } catch (error) {
        return null;
      }
    }

    function isFoldable(id) {
      return PLATFORM_LOCKED.indexOf(id) < 0;
    }

    /**
     * 维护 `seen`（本插件见过的全部面板 id），只在首次运行时播种默认收起名单。
     * 播种规则：沿用已有的 folded；对既没被显式收起、也没被显式放回的面板，
     * 命中 DEFAULT_FOLDED 的才收。此后新出现的面板 id 追加进 seen，由
     * autoFoldNew 决定是否收起，老用户的选择不会被覆盖。
     * @param {Array<{id: string}>} panels
     * @returns {object} 已落盘的状态
     */
    function seedState(panels, persist) {
      var state = readState();
      var ids = [];
      var i;
      for (i = 0; i < panels.length; i += 1) ids.push(panels[i].id);

      if (state.seen.length === 0) {
        // 首轮：铺默认收起名单；seen 记下此刻的全部面板，之后新装的才会被 autoFoldNew 收。
        var folded = state.folded.slice();
        for (i = 0; i < ids.length; i += 1) {
          var seedId = ids[i];
          if (!isFoldable(seedId)) continue;
          if (folded.indexOf(seedId) >= 0) continue;
          if (state.unfolded.indexOf(seedId) >= 0) continue;
          if (DEFAULT_FOLDED.indexOf(seedId) >= 0) folded.push(seedId);
        }
        state.folded = folded;
        state.seen = ids.slice();
        if (persist !== false) writeState(state);
        return { state: state, fresh: [] };
      }

      var fresh = [];
      for (i = 0; i < ids.length; i += 1) {
        if (!isFoldable(ids[i])) continue;
        if (state.seen.indexOf(ids[i]) >= 0) continue;
        fresh.push(ids[i]);
      }
      if (fresh.length > 0) {
        state.seen = state.seen.concat(fresh);
        // autoFoldNew：新冒出来的面板直接写进 folded，避免「这一轮藏、下一轮又冒出来」。
        if (state.autoFoldNew) state.folded = state.folded.concat(fresh);
        if (persist !== false) writeState(state);
      }
      return { state: state, fresh: fresh };
    }

    /** hidden: { [id]: true }，只看 folded（autoFoldNew 在 seedState 里已落进 folded）。 */
    function computeHidden(panels, state) {
      var current = state && Array.isArray(state.folded) ? state : readState();
      var hidden = {};
      for (var i = 0; i < panels.length; i += 1) {
        var id = panels[i].id;
        if (!isFoldable(id)) continue;
        if (current.folded.indexOf(id) >= 0) hidden[id] = true;
      }
      return hidden;
    }

    // ------------------------------------------------------------- DOM 折叠

    function rowButtons(nav) {
      var list = [];
      var buttons = nav.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i += 1) {
        var button = buttons[i];
        // 「更多」按钮带 aria-haspopup="menu"，面板行没有；面板行一定有 aria-label。
        if (button.getAttribute("aria-haspopup") === "menu") continue;
        if (!button.getAttribute("aria-label")) continue;
        list.push(button);
      }
      return list;
    }

    /** 候选导航栏：nav 内 aria-label 集合与面板清单重合最多者，≥max(2, 60%) 才认。 */
    function locateNav(panels) {
      if (typeof document === "undefined") return null;
      var navs = document.querySelectorAll("nav");
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < navs.length; i += 1) {
        var buttons = rowButtons(navs[i]);
        var labels = {};
        for (var j = 0; j < buttons.length; j += 1) labels[buttons[j].getAttribute("aria-label")] = true;
        var score = 0;
        for (var k = 0; k < panels.length; k += 1) if (labels[panels[k].label] === true) score += 1;
        if (score > bestScore) {
          bestScore = score;
          best = navs[i];
        }
      }
      var need = Math.max(2, Math.ceil((panels.length * 6) / 10));
      return bestScore >= need ? best : null;
    }

    /** 行按钮在 nav 下的最外层祖先（Tooltip 包裹层）；只隐藏它，不动 nav 结构。 */
    function rowHost(nav, button) {
      var node = button;
      while (node && node.parentElement && node.parentElement !== nav) node = node.parentElement;
      if (!node || !node.parentElement || node.parentElement !== nav) return null;
      return node;
    }

    function hideHost(host) {
      if (host.getAttribute(HIDDEN_ATTR) === "1") return;
      host.setAttribute(HIDDEN_ATTR, "1");
      host.setAttribute("style", "display:none");
    }

    function showHost(host) {
      if (host.getAttribute(HIDDEN_ATTR) !== "1") return;
      host.removeAttribute(HIDDEN_ATTR);
      host.removeAttribute("style");
    }

    /**
     * 行顺序 == panels 顺序（隐藏不改变按钮集合，数量恒定）。先整体校验每个
     * aria-label 都对得上，再统一动手；任一不匹配就整轮放弃，避免藏错行。
     */
    function applyRows(nav, panels, hidden) {
      var buttons = rowButtons(nav);
      if (buttons.length !== panels.length) return false;
      var hosts = [];
      for (var i = 0; i < panels.length; i += 1) {
        if (buttons[i].getAttribute("aria-label") !== panels[i].label) return false;
        var host = rowHost(nav, buttons[i]);
        if (!host) return false;
        hosts.push(host);
      }
      for (var j = 0; j < hosts.length; j += 1) {
        if (hidden[panels[j].id] === true) hideHost(hosts[j]);
        else showHost(hosts[j]);
      }
      return true;
    }

    function restoreRows() {
      try {
        if (typeof document === "undefined") return;
        var nodes = document.querySelectorAll("[" + HIDDEN_ATTR + "]");
        for (var i = 0; i < nodes.length; i += 1) showHost(nodes[i]);
      } catch (error) {
        /* ignore */
      }
    }

    /**
     * 每轮折叠把结果写进 localStorage["dsh.sidebar-more.lastpass"]，出问题时可以直接
     * 从 Electron 的 LevelDB 里读出上一轮认出了几个面板、几行、有没有真正动手。
     * 纯诊断，失败不影响折叠。
     */
    var diagLastAt = 0;
    var diagLastSig = "";
    function reportDiagnostics(panels, nav, rows, hidden, applied) {
      try {
        if (typeof localStorage === "undefined") return;
        var hiddenIds = [];
        for (var id in hidden) {
          if (Object.prototype.hasOwnProperty.call(hidden, id) && hidden[id] === true) hiddenIds.push(id);
        }
        // MutationObserver 在流式输出时会把 pass 排得很密，诊断值不变且 5s 内就不再写盘。
        var now = Date.now();
        var sig = panels.length + "|" + rows + "|" + applied + "|" + (nav != null) + "|" + hiddenIds.join(",");
        if (sig === diagLastSig && now - diagLastAt < 5000) return;
        diagLastSig = sig;
        diagLastAt = now;
        localStorage.setItem(DIAG_KEY, JSON.stringify({
          at: new Date().toISOString(),
          panels: panels.length,
          rows: rows,
          navFound: nav != null,
          applied: applied === true,
          hidden: hiddenIds,
          visibility: typeof document !== "undefined" && document.visibilityState ? document.visibilityState : "unknown"
        }));
      } catch (error) {
        /* ignore */
      }
    }

    // --------------------------------------------------------------- 调度器

    function createScheduler(ctx) {
      var navRef = null;
      var frame = 0;
      var stopped = false;
      var unsubscribers = [];
      var observer = null;

      function pass() {
        frame = 0;
        if (stopped) return;
        // 不再因 document.hidden 早退：rAF 在后台本就暂停，早退只会让切回前台后
        // 没有任何东西再触发一次（v0.1.0 的「刷新后没生效」就是这么来的）。
        var panels = listPanels(ctx);
        if (!panels || panels.length === 0) return;
        var seeded = seedState(panels);
        var hidden = computeHidden(panels, seeded.state);
        var nav = navRef && navRef.isConnected ? navRef : locateNav(panels);
        var applied = false;
        var rows = 0;
        if (nav) {
          navRef = nav;
          applied = applyRows(nav, panels, hidden) === true;
          rows = rowButtons(nav).length;
        }
        reportDiagnostics(panels, nav, rows, hidden, applied);
      }

      function schedule() {
        if (stopped || frame !== 0) return;
        try {
          if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
            frame = window.requestAnimationFrame(pass);
          } else {
            frame = setTimeout(pass, 16);
          }
        } catch (error) {
          frame = 0;
        }
      }

      try {
        if (ctx.slots && typeof ctx.slots.subscribe === "function") {
          var release = ctx.slots.subscribe(PANELS_SLOT, schedule);
          if (typeof release === "function") unsubscribers.push(release);
        }
      } catch (error) {
        /* ignore */
      }

      try {
        if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body) {
          observer = new MutationObserver(function () { schedule(); });
          observer.observe(document.body, { childList: true, subtree: true });
        }
      } catch (error) {
        observer = null;
      }

      // 前台/重新聚焦时补跑一轮：Electron 窗口最小化或切到别的应用时 rAF 会停，
      // 回来以后必须有人把 pass 重新排上。
      var listenerTargets = [];
      function listen(target, event) {
        try {
          if (!target || typeof target.addEventListener !== "function") return;
          target.addEventListener(event, schedule);
          listenerTargets.push([target, event]);
        } catch (error) {
          /* ignore */
        }
      }
      if (typeof document !== "undefined") listen(document, "visibilitychange");
      if (typeof window !== "undefined") {
        listen(window, "focus");
        listen(window, "pageshow");
      }

      // 启动重试：首屏渲染时侧栏可能还没挂载，隔几个时间点各试一次（幂等）。
      var retries = [];
      var delays = [80, 300, 900, 2400];
      for (var d = 0; d < delays.length; d += 1) {
        try {
          retries.push(setTimeout(schedule, delays[d]));
        } catch (error) {
          /* ignore */
        }
      }

      schedule();

      return {
        schedule: schedule,
        stop: function () {
          stopped = true;
          if (observer) {
            try { observer.disconnect(); } catch (error) { /* ignore */ }
            observer = null;
          }
          for (var i = 0; i < listenerTargets.length; i += 1) {
            try { listenerTargets[i][0].removeEventListener(listenerTargets[i][1], schedule); } catch (error) { /* ignore */ }
          }
          listenerTargets = [];
          for (var r = 0; r < retries.length; r += 1) {
            try { clearTimeout(retries[r]); } catch (error) { /* ignore */ }
          }
          retries = [];
          for (var j = 0; j < unsubscribers.length; j += 1) {
            try { unsubscribers[j](); } catch (error) { /* ignore */ }
          }
          unsubscribers = [];
          navRef = null;
          restoreRows();
        }
      };
    }

    // ------------------------------------------------------------------- API

    function createApi(ctx, schedule) {
      return {
        snapshot: function () {
          var panels = listPanels(ctx);
          if (!panels || panels.length === 0) return null;
          var seeded = seedState(panels, false);
          return {
            panels: panels,
            hidden: computeHidden(panels, seeded.state),
            autoFoldNew: seeded.state.autoFoldNew
          };
        },
        isFoldable: isFoldable,
        fold: function (id) {
          var state = readState();
          state.unfolded = withoutId(state.unfolded, id);
          state.folded = withId(state.folded, id);
          writeState(state);
          schedule();
        },
        unfold: function (id) {
          var state = readState();
          state.folded = withoutId(state.folded, id);
          state.unfolded = withId(state.unfolded, id);
          writeState(state);
          schedule();
        },
        unfoldAll: function () {
          var state = readState();
          var panels = listPanels(ctx);
          state.folded = [];
          if (panels) {
            for (var i = 0; i < panels.length; i += 1) state.unfolded = withId(state.unfolded, panels[i].id);
          }
          writeState(state);
          schedule();
        },
        setAutoFoldNew: function (value) {
          var state = readState();
          state.autoFoldNew = value !== false;
          writeState(state);
          schedule();
        }
      };
    }

    // ------------------------------------------------------------------ 菜单

    /**
     * sidebar.panellist.actions 的菜单内容（只在「更多」展开时挂载）。
     * t 由 register 的 locale 选项提供；api 由 inject 注入；onOpen/onDismiss 来自 owner。
     * 宿主自己的「浏览更多插件 / 创建你的插件」两行仍由 entry-customization 提供。
     */
    function SidebarMoreMenu(props) {
      var api = props && props.api ? props.api : null;
      var t = props && typeof props.t === "function" ? props.t : function (key) { return key; };
      var onDismiss = props && typeof props.onDismiss === "function" ? props.onDismiss : function () {};
      var onOpen = props && typeof props.onOpen === "function" ? props.onOpen : null;

      var bumpState = React.useState(0);
      var bump = bumpState[1];
      function refresh() {
        bump(function (value) { return value + 1; });
      }

      var snap = null;
      try {
        snap = api ? api.snapshot() : null;
      } catch (error) {
        snap = null;
      }
      if (!snap) return null;

      function close(action) {
        return function () {
          onDismiss();
          if (typeof action === "function") action();
        };
      }

      var folded = [];
      var foldable = [];
      for (var i = 0; i < snap.panels.length; i += 1) {
        var panel = snap.panels[i];
        if (snap.hidden[panel.id] === true) folded.push(panel);
        else if (isFoldable(panel.id)) foldable.push(panel);
      }

      var rows = [];
      for (var a = 0; a < folded.length; a += 1) {
        var opened = folded[a];
        rows.push(jsx(MenuItemButton, {
          onSelect: close(onOpen ? function (id) {
            return function () { onOpen(id); };
          }(opened.id) : null),
          children: t("openPrefix") + opened.label + t("openSuffix")
        }, "open:" + opened.id));
      }
      for (var b = 0; b < foldable.length; b += 1) {
        var hiddenPanel = foldable[b];
        rows.push(jsx(MenuItemButton, {
          separatorBefore: b === 0 && folded.length > 0,
          onSelect: close(function (id) {
            return function () {
              api.fold(id);
              refresh();
            };
          }(hiddenPanel.id)),
          children: t("foldPrefix") + hiddenPanel.label + t("foldSuffix")
        }, "fold:" + hiddenPanel.id));
      }
      if (folded.length > 0) {
        rows.push(jsx(MenuItemButton, {
          separatorBefore: true,
          onSelect: close(function () {
            api.unfoldAll();
            refresh();
          }),
          children: t("unfoldAll")
        }, "unfold-all"));
      }
      rows.push(jsx(MenuItemButton, {
        separatorBefore: true,
        current: snap.autoFoldNew === true,
        icon: snap.autoFoldNew && IconCheck ? jsx(IconCheck, { size: 16 }) : null,
        onSelect: close(function () {
          api.setAutoFoldNew(!snap.autoFoldNew);
          refresh();
        }),
        children: t("autoFoldNew")
      }, "auto-fold-new"));

      return jsx(Fragment, { children: rows });
    }

    // ------------------------------------------------------------------ 文案

    var messages = {
      en: {
        openPrefix: "Open “",
        openSuffix: "”",
        foldPrefix: "Hide “",
        foldSuffix: "” from sidebar",
        unfoldAll: "Put all panels back",
        autoFoldNew: "Auto-hide new plugin entries"
      },
      zh: {
        openPrefix: "打开「",
        openSuffix: "」",
        foldPrefix: "收起「",
        foldSuffix: "」",
        unfoldAll: "全部放回侧栏",
        autoFoldNew: "新插件自动收进更多"
      }
    };

    // --------------------------------------------------------------- 装配

    /**
     * 所有副作用都挂在当前 fiber 上：返回的清理函数在插件卸载时执行。
     * @param {any} ctx Cordis 客户端上下文
     * @returns {() => void} 清理函数
     */
    function setup(ctx) {
      try {
        ctx.effect(function () { return ctx.locale.register(LOCALE_NS, messages); });
      } catch (error) {
        /* 文案缺失时用 key 兜底 */
      }
      var t = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind(LOCALE_NS) : function (key) { return key; };

      var control = createScheduler(ctx);
      var api = createApi(ctx, control.schedule);

      try {
        if (MenuItemButton != null) {
          ctx.slots.inject(ACTIONS_SLOT, function () {
            return ctx.slots.register({
              name: ACTIONS_SLOT,
              id: "sidebar-more",
              order: -10,
              locale: LOCALE_NS,
              inject: function () { return { api: api }; }
            }, SidebarMoreMenu);
          });
        }
      } catch (error) {
        /* 注册失败：至少不挡宿主自己的菜单行 */
      }

      return function dispose() {
        control.stop();
      };
    }

    function apply(ctx) {
      ctx.effect(function () { return setup(ctx); });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  }
});
