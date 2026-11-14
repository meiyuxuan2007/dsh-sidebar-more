/**
 * lib/client.js 的行为测试：用 vm 跑真实源码，喂假 DOM / 假 localStorage / 假 ctx。
 *
 * 覆盖三条必须回归的路径：
 *   1. 首轮（localStorage 为空）不折叠任何入口，只记 seen 与 seededAt；
 *   2. 首轮宽限窗口内晚到注册的入口不被当成「新插件」收起，窗口外才收；
 *   3. 老用户的 folded / unfolded / autoFoldNew 不被覆盖。
 * 另含平台锁、fail-open、卸载还原。
 *
 * 运行：npm test（node --test test/）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
const STORAGE_KEY = "dsh.sidebar-more.v1";
const DIAG_KEY = "dsh.sidebar-more.lastpass";
const HIDDEN_ATTR = "data-dsh-sidebar-more-hidden";
const T0 = 1763200000000;

// ------------------------------------------------------------------ 假 DOM

function createNode(tag) {
  return {
    tagName: tag.toUpperCase(),
    attributes: Object.create(null),
    parentElement: null,
    children: [],
    isConnected: true,
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    querySelectorAll(selector) {
      if (selector !== "button") return [];
      const found = [];
      const walk = (current) => {
        for (const child of current.children) {
          if (child.tagName === "BUTTON") found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    }
  };
}

/**
 * 造一个只认 "nav" 与隐藏标记选择器的 document。
 * __mount(panels) 重建导航栏，模拟侧栏重渲染（旧 nav 标记为已断开）。
 */
function createDocument() {
  const navs = [];
  const wrappers = [];
  const doc = {
    body: createNode("body"),
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll(selector) {
      if (selector === "nav") return navs.filter((nav) => nav.isConnected);
      if (selector === `[${HIDDEN_ATTR}]`) {
        return wrappers.filter((node) => node.getAttribute(HIDDEN_ATTR) === "1");
      }
      return [];
    }
  };
  doc.__wrappers = wrappers;
  doc.__mount = (panels) => {
    for (const old of navs) old.isConnected = false;
    const nav = createNode("nav");
    for (const panel of panels) {
      const wrapper = createNode("div");
      const button = createNode("button");
      button.setAttribute("aria-label", panel.label || panel.id);
      wrapper.children.push(button);
      button.parentElement = wrapper;
      wrapper.parentElement = nav;
      nav.children.push(wrapper);
      wrappers.push(wrapper);
    }
    // 「更多」按钮：带 aria-haspopup=menu，折叠逻辑应跳过它。
    const moreWrapper = createNode("div");
    const moreButton = createNode("button");
    moreButton.setAttribute("aria-label", "More");
    moreButton.setAttribute("aria-haspopup", "menu");
    moreWrapper.children.push(moreButton);
    moreButton.parentElement = moreWrapper;
    moreWrapper.parentElement = nav;
    nav.children.push(moreWrapper);

    navs.length = 0;
    navs.push(nav);
    return nav;
  };
  return doc;
}

// ------------------------------------------------------------------ 假环境

const REACT_STUB = {
  Fragment: "Fragment",
  createElement: () => null,
  useState: (initial) => [initial, () => {}]
};

function requireStub(name) {
  if (name === "react") return REACT_STUB;
  if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
  if (name === "@deepseek-ai/dsh-client-ui-primitives") {
    // 非空即可：为空时 client.js 会跳过菜单注册（MenuItemButton != null 才注册）。
    return { MenuItemButton: () => null, IconCheckOutlineRegular: () => null };
  }
  throw new Error(`unexpected module request: ${name}`);
}

function createEnv() {
  const frames = [];
  const timeouts = [];
  const storage = new Map();
  const clock = { now: T0 };
  const documentStub = createDocument();

  class FakeDate extends Date {
    static now() {
      return clock.now;
    }
  }

  let captured = null;
  let frameId = 0;
  const sandbox = {
    console,
    Date: FakeDate,
    JSON,
    Object,
    Array,
    String,
    Number,
    Math,
    Error,
    isFinite,
    parseInt,
    document: documentStub,
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => {
        storage.set(key, String(value));
      },
      removeItem: (key) => {
        storage.delete(key);
      },
      clear: () => storage.clear()
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout: () => {},
    window: {
      __ModuleLoader__: {
        load(config) {
          captured = config;
        }
      },
      requestAnimationFrame(fn) {
        frames.push(fn);
        frameId += 1;
        return frameId;
      },
      addEventListener() {},
      removeEventListener() {}
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "lib/client.js" });

  return {
    document: documentStub,
    storage,
    clock,
    frames,
    async flush() {
      while (frames.length > 0) {
        const pending = frames.splice(0, frames.length);
        for (const fn of pending) fn(0);
        await Promise.resolve();
      }
    },
    module() {
      assert.ok(captured, "client.js 应通过 __ModuleLoader__.load 注册自身");
      return captured.factory(requireStub);
    }
  };
}

function panel(id, order, label) {
  return { id, order, label: label || id };
}

/** 挂载插件：返回手动触发同步与卸载的把手。 */
function mount(env, panels) {
  const disposers = [];
  let onChange = null;
  let registerSpec = null;

  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return () => {};
    },
    locale: {
      register() {},
      bind() {
        return (key) => key;
      }
    },
    slots: {
      entriesOfSlot() {
        return panels.map((item) => ({ options: item }));
      },
      subscribe(name, listener) {
        onChange = listener;
        return () => {};
      },
      inject(name, build) {
        if (typeof build === "function") build();
      },
      register(spec) {
        registerSpec = spec;
        return () => {};
      }
    },
    layout: {
      selectPanel() {}
    }
  };

  env.module().apply(ctx);

  return {
    ctx,
    trigger() {
      if (onChange) onChange();
    },
    spec() {
      return registerSpec;
    },
    api() {
      return registerSpec ? registerSpec.inject().api : null;
    },
    dispose() {
      for (const fn of disposers) fn();
    }
  };
}

function hiddenIds(env) {
  return env.document
    .querySelectorAll(`[${HIDDEN_ATTR}]`)
    .map((node) => node.getAttribute("aria-label") || node.children[0].getAttribute("aria-label"));
}

function readStored(env) {
  const raw = env.storage.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function readDiagnostics(env) {
  const raw = env.storage.get(DIAG_KEY);
  return raw ? JSON.parse(raw) : null;
}

// -------------------------------------------------------------------- 用例

test("首轮：不折叠任何入口，只记 seen 与 seededAt", async () => {
  const env = createEnv();
  const panels = [panel("plugins", 0, "Plugins"), panel("skills-manager", 2, "Skills"), panel("dsh-taskboard", 10, "Taskboard")];
  env.document.__mount(panels);
  mount(env, panels);
  await env.flush();

  assert.deepEqual(hiddenIds(env), [], "首轮不应隐藏任何行");

  const state = readStored(env);
  assert.deepEqual(state.folded, []);
  assert.deepEqual(state.unfolded, []);
  assert.deepEqual(state.seen, ["plugins", "skills-manager", "dsh-taskboard"]);
  assert.equal(state.seededAt, T0);
  assert.equal(state.autoFoldNew, true);

  const diag = readDiagnostics(env);
  assert.equal(diag.applied, true, "行与会话一一对应时应真正动手（只是没有要藏的行）");
  assert.equal(diag.rows, panels.length, "rows 是面板行数（「更多」按钮不计入）");
});

test("首轮宽限窗口：晚到注册的入口只记 seen，不折叠", async () => {
  const env = createEnv();
  const panels = [panel("plugins", 0, "Plugins"), panel("skills-manager", 2, "Skills")];
  env.document.__mount(panels);
  const handle = mount(env, panels);
  await env.flush();
  assert.deepEqual(hiddenIds(env), []);

  // 5 秒后另一个插件才把入口注册进来（按需加载的常态）
  env.clock.now = T0 + 5000;
  panels.push(panel("late-plugin", 30, "Late"));
  env.document.__mount(panels);
  handle.trigger();
  await env.flush();

  assert.deepEqual(hiddenIds(env), [], "窗口内晚到的入口不应被收起");
  const state = readStored(env);
  assert.ok(state.seen.includes("late-plugin"), "seen 应记下晚到的入口");
  assert.deepEqual(state.folded, []);
});

test("窗口外新出现的入口：autoFoldNew 打开时自动收起", async () => {
  const env = createEnv();
  const panels = [panel("plugins", 0, "Plugins"), panel("skills-manager", 2, "Skills")];
  env.document.__mount(panels);
  const handle = mount(env, panels);
  await env.flush();

  env.clock.now = T0 + 20000; // 越过 15 秒宽限窗口
  panels.push(panel("new-plugin", 30, "New Plugin"));
  env.document.__mount(panels);
  handle.trigger();
  await env.flush();

  assert.deepEqual(hiddenIds(env), ["New Plugin"], "只藏新入口，老入口保持可见");
  assert.deepEqual(readStored(env).folded, ["new-plugin"]);
});

test("autoFoldNew=false：新入口只记 seen，不折叠", async () => {
  const env = createEnv();
  env.storage.set(
    STORAGE_KEY,
    JSON.stringify({
      folded: [],
      unfolded: [],
      autoFoldNew: false,
      seen: ["plugins", "skills-manager"],
      seededAt: T0
    })
  );
  const panels = [panel("plugins", 0, "Plugins"), panel("skills-manager", 2, "Skills")];
  env.document.__mount(panels);
  const handle = mount(env, panels);
  await env.flush();

  env.clock.now = T0 + 60000;
  panels.push(panel("new-plugin", 30, "New Plugin"));
  env.document.__mount(panels);
  handle.trigger();
  await env.flush();

  assert.deepEqual(hiddenIds(env), []);
  assert.deepEqual(readStored(env).folded, []);
  assert.ok(readStored(env).seen.includes("new-plugin"));
});

test("老用户状态不被覆盖：已收起的保留，未收的不动", async () => {
  const env = createEnv();
  env.storage.set(
    STORAGE_KEY,
    JSON.stringify({
      folded: ["skills-manager"],
      unfolded: ["dsh-taskboard"],
      autoFoldNew: true,
      seen: ["plugins", "skills-manager", "dsh-taskboard"],
      seededAt: T0 - 86400000
    })
  );
  const panels = [
    panel("plugins", 0, "Plugins"),
    panel("skills-manager", 2, "Skills"),
    panel("dsh-taskboard", 10, "Taskboard")
  ];
  env.document.__mount(panels);
  mount(env, panels);
  await env.flush();

  assert.deepEqual(hiddenIds(env), ["Skills"]);
  const state = readStored(env);
  assert.deepEqual(state.folded, ["skills-manager"]);
  assert.deepEqual(state.unfolded, ["dsh-taskboard"]);
  assert.equal(state.seededAt, T0 - 86400000, "老用户的 seededAt 不应被改写");
});

test("平台锁：plugins 永不设置折叠，也不出现在 hidden 里", async () => {
  const env = createEnv();
  const panels = [panel("plugins", 0, "Plugins"), panel("ssh", 40, "SSH")];
  env.document.__mount(panels);
  const handle = mount(env, panels);
  await env.flush();

  const api = handle.api();
  assert.ok(api, "菜单应完成注册");
  assert.equal(api.isFoldable("plugins"), false);
  assert.equal(api.isFoldable("ssh"), true);

  api.fold("plugins");
  await env.flush();
  assert.deepEqual(hiddenIds(env), [], "即便 folded 里写了 plugins，也不得隐藏");
});

test("fail-open：行标签对不上时整轮放弃，不动 DOM", async () => {
  const env = createEnv();
  env.storage.set(
    STORAGE_KEY,
    JSON.stringify({
      folded: ["skills-manager"],
      unfolded: [],
      autoFoldNew: true,
      seen: ["plugins", "skills-manager"],
      seededAt: T0 - 86400000
    })
  );
  const panels = [panel("plugins", 0, "Plugins"), panel("skills-manager", 2, "Skills")];
  const nav = env.document.__mount(panels);
  // 把第二行的标签改掉，模拟宿主改了文案 / 结构
  const buttons = nav.querySelectorAll("button");
  buttons[1].setAttribute("aria-label", "Skills (renamed)");
  mount(env, panels);
  await env.flush();

  assert.deepEqual(hiddenIds(env), [], "校验不通过时不得隐藏任何行");
  assert.equal(readDiagnostics(env).applied, false);
});

test("卸载：已隐藏的行全部还原", async () => {
  const env = createEnv();
  env.storage.set(
    STORAGE_KEY,
    JSON.stringify({
      folded: ["skills-manager"],
      unfolded: [],
      autoFoldNew: true,
      seen: ["plugins", "skills-manager"],
      seededAt: T0 - 86400000
    })
  );
  const panels = [panel("plugins", 0, "Plugins"), panel("skills-manager", 2, "Skills")];
  env.document.__mount(panels);
  const handle = mount(env, panels);
  await env.flush();
  assert.deepEqual(hiddenIds(env), ["Skills"]);

  handle.dispose();
  assert.deepEqual(hiddenIds(env), [], "插件卸载后行应恢复显示");
});
