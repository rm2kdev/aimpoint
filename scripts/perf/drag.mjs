#!/usr/bin/env node
// Drag performance suite (VEC-72). Drives real pointer drags in the signed-in app through the Chrome DevTools
// Protocol and prints, per scenario: frame times, dropped frames, long tasks, React renders per pointermove,
// pointermove handler time, layouts per move, and anything (realtime events, RSC fetches, server actions)
// that fired mid-drag. Measures only: it never edits app code, and against a real org every drag ends with
// Escape, so no task or project moves.
//
//   pnpm perf:drag                                  # dev server on :3200, current org + throwaway large org
//   pnpm perf:drag --target prod=http://10.0.0.2:3290 --target dev=http://10.0.0.2:3200
//   pnpm perf:drag --sizes large --panes closed --only reorder,project --runs 3 --json /tmp/drag.json
//
// Options
//   --target name=url   app to measure (repeatable; default dev=http://10.0.0.2:3200)
//   --org <slug>        the "current" org (default northwind)
//   --user <email>      admin of that org to sign in as (default ryan@demo.vector.dev); the session cookie is
//                       minted from AUTH_SECRET in .env.local, no password involved
//   --sizes a,b         current | large (default both). "large" creates a throwaway org in Mongo (~300 tasks,
//                       20 projects, --tasks/--projects to change), runs there with real drops, then deletes it
//                       from every collection, also on Ctrl-C
//   --panes a,b         closed | open (task pane open on a task that isn't dragged; default both)
//   --only a,b          scenario filter: reorder, across, heading, spring, project, realtime (default all;
//                       realtime runs in the large org only, where a fixture bot can edit tasks)
//   --runs n            timed runs per scenario (default 2), after one render-counting run
//   --drop              also drop (not Escape) in the current org. Off by default: it reorders real tasks
//   --headless          run Chrome headless. Default is a visible window: headless Chrome on a Mac caps
//                       rAF at ~20 fps (no display link), so its frame numbers are meaningless
//   --browser <b>       chrome (default) | webkit: Playwright WebKit as a Safari stand-in (VEC-97); needs
//                       PLAYWRIGHT_DIR=<dir with playwright installed>; no long-task / layout metrics there
//   --json <file>       write every raw sample as JSON
//   --keep-org          don't delete the throwaway org (prints its slug)
//   PERF_DEBUG=1        log CDP calls and navigation to stderr
//   PERF_PROFILE=<dir>  also save a CPU profile (.cpuprofile) of every timed run there; with a build that has
//                       productionBrowserSourceMaps on, its frames map back to source (VEC-81)
//   PERF_TRACE=<dir>    also save a DevTools timeline trace of every timed run there and print per run: style
//                       recalcs, layouts, paint ops, layerize time and main-thread ms per frame (VEC-97). A 60 Hz
//                       frame interval hides headroom; paints/layouts per drag and main ms/frame show it
//
// Dev vs production: build in a copy or worktree (never in the live :3200 checkout), `pnpm start --port 3290`
// there with the same .env.local, then pass both targets. The prod server has its own in-process realtime bus,
// so the realtime scenario's bot edits go to whichever target is being measured.
//
// Requires: a Chromium (CHROME_PATH, else Playwright's cache, else /Applications/Google Chrome.app) and the
// target server(s) running against the MONGODB_URI/MONGODB_DB in .env.local.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ObjectId } from "mongodb";
import { connect, createLargeOrg, deleteOrg, leftovers } from "./fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const FRAME_MS = 1000 / 60;
const STEP_PX = 8; // per pointermove: ~480 px/s at 60 moves/s, a brisk but ordinary drag
const VIEW = { width: 1440, height: 900 };
const SCENARIOS = ["reorder", "across", "heading", "spring", "project", "realtime"];
const DESCRIPTIONS = {
  idle: "no input, rAF only (frame floor of this browser)",
  reorder: "task row down ~8 rows and back up, same status group",
  across: "task row from one status group into the next one",
  heading: "task row onto another status group's heading, hover 600 ms",
  spring: "task row onto a sidebar project, dwell until it opens, then into its list",
  project: "sidebar project down 6 rows, back to the top, down again",
  realtime: "reorder while a teammate bot edits a visible task over REST every 400 ms (large org only)",
};

// ---- args / env --------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { targets: [], org: "northwind", user: "ryan@demo.vector.dev", sizes: ["current", "large"], panes: ["closed", "open"], only: SCENARIOS, runs: 2, drop: false, headless: false, json: null, keepOrg: false, browser: "chrome", tasks: 300, projects: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--target") {
      const [name, url] = v().split("=");
      o.targets.push({ name: url ? name : "app", url: (url ?? name).replace(/\/$/, "") });
    } else if (a === "--org") o.org = v();
    else if (a === "--user") o.user = v();
    else if (a === "--sizes") o.sizes = v().split(",");
    else if (a === "--panes") o.panes = v().split(",");
    else if (a === "--only") o.only = v().split(",");
    else if (a === "--runs") o.runs = Number(v());
    else if (a === "--tasks") o.tasks = Number(v());
    else if (a === "--projects") o.projects = Number(v());
    else if (a === "--drop") o.drop = true;
    else if (a === "--headless") o.headless = true;
    else if (a === "--json") o.json = v();
    else if (a === "--keep-org") o.keepOrg = true;
    else if (a === "--browser") o.browser = v();
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 30).join("\n"));
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!o.targets.length) o.targets.push({ name: "dev", url: "http://10.0.0.2:3200" });
  return o;
}

function loadEnv() {
  const env = { ...process.env };
  const file = path.join(ROOT, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

async function mintSession(env, uid) {
  const req = createRequire(path.join(ROOT, "x.js"));
  let jwtPath;
  try {
    jwtPath = createRequire(path.join(path.dirname(req.resolve("next-auth/package.json")), "x.js")).resolve("@auth/core/jwt");
  } catch {
    jwtPath = path.join(ROOT, "node_modules/.pnpm/node_modules/@auth/core/jwt.js");
  }
  const { encode } = await import(pathToFileURL(jwtPath).href);
  return encode({ token: { uid, sub: uid }, secret: env.AUTH_SECRET, salt: "authjs.session-token" });
}

// ---- Chrome + CDP ------------------------------------------------------------------------------------

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      for (const sub of ["chrome-mac-arm64", "chrome-mac", "chrome-mac-x64"]) {
        for (const app of ["Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "Chromium.app/Contents/MacOS/Chromium"]) {
          const p = path.join(cache, d, sub, app);
          if (fs.existsSync(p)) return p;
        }
      }
      const linux = path.join(cache, d, "chrome-linux/chrome");
      if (fs.existsSync(linux)) return linux;
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  throw new Error("No Chromium found: set CHROME_PATH");
}

async function launchChrome(headless) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-drag-chrome-"));
  const args = [
    `--user-data-dir=${dir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--use-mock-keychain", // macOS: cookie access otherwise waits on a Keychain prompt
    "--password-store=basic",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    `--window-size=${VIEW.width},${VIEW.height + 100}`,
    "--force-device-scale-factor=1",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const bin = findChrome();
  debug("chrome", bin);
  const proc = spawn(bin, args, { stdio: "ignore" });
  const portFile = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 600 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  debug("cdp", port, page?.url);
  const cdp = await CDP.connect(page.webSocketDebuggerUrl);
  return {
    cdp,
    close: async () => {
      cdp.close();
      proc.kill();
      await sleep(300);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new CDP(ws);
      ws.onopen = () => resolve(c);
      ws.onerror = (e) => reject(e);
    });
  }
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
        else resolve(msg.result);
      } else if (msg.method) (this.handlers.get(msg.method) ?? []).forEach((h) => h(msg.params));
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    if (method !== "Input.dispatchMouseEvent" && method !== "Runtime.evaluate") debug("send", method);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debug = process.env.PERF_DEBUG ? (...a) => console.error("[debug]", ...a) : () => {};

// ---- Page helpers ------------------------------------------------------------------------------------

class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.x = 0;
    this.y = 0;
    this.net = null; // collector while a move window is open
    cdp.on("Network.eventSourceMessageReceived", (e) => {
      if (!this.net) return;
      let type = e.eventName || "message";
      try {
        type = JSON.parse(e.data).type ?? type;
      } catch {}
      this.net.realtime.push(type);
    });
    cdp.on("Network.requestWillBeSent", (e) => {
      if (!this.net) return;
      const h = Object.fromEntries(Object.entries(e.request.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      if (h["next-action"]) this.net.actions.push(e.request.url);
      else if (h.rsc === "1" || /[?&]_rsc=/.test(e.request.url)) this.net.rsc.push(e.request.url);
    });
  }
  async init(probe) {
    const c = this.cdp;
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Network.enable");
    await c.send("Performance.enable", { timeDomain: "timeTicks" });
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: probe });
    await c.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 1, mobile: false });
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await c.send("Page.bringToFront");
  }
  async eval(expr) {
    const r = await this.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async goto(url) {
    debug("goto", url);
    await this.cdp.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete' && window.__perf?.everCommitted && !!document.querySelector('ul[data-sortable-list]')", 30000);
    if ((await this.eval("location.pathname")).startsWith("/login")) throw new Error(`signed out at ${url}`);
    await sleep(1500); // realtime stream connects, fonts and lazy chunks settle
  }
  async waitFor(expr, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.eval(`!!(${expr})`).catch(() => false)) return true;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${expr}`);
  }
  layout() {
    return this.eval("window.__perf.layout()");
  }
  async metrics() {
    const { metrics } = await this.cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }
  mouse(type, x, y, buttons) {
    this.x = x;
    this.y = y;
    return this.cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? (buttons ? "left" : "none") : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  }
  /** Press at (x, y) and travel past the 4px drag threshold in small steps. */
  async press(x, y) {
    await this.mouse("mouseMoved", x, y, 0);
    await sleep(50);
    await this.mouse("mousePressed", x, y, 1);
    for (const d of [2, 5, 10]) {
      await this.mouse("mouseMoved", x, y + d, 1);
      await sleep(FRAME_MS);
    }
  }
  /** Move to (x, y) one pointermove per frame, STEP_PX apart. */
  async path(x, y, step = STEP_PX) {
    const x0 = this.x;
    const y0 = this.y;
    const n = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / step));
    const start = performance.now();
    for (let i = 1; i <= n; i++) {
      await this.mouse("mouseMoved", x0 + ((x - x0) * i) / n, y0 + ((y - y0) * i) / n, 1);
      const wait = start + i * FRAME_MS - performance.now();
      if (wait > 0) await sleep(wait);
    }
  }
  /** Hold still-ish (1px jitter each frame, like a hand) for `ms`, or until `until()` turns true. */
  async hover(ms, until) {
    const x = this.x;
    const y = this.y;
    const end = performance.now() + ms;
    let i = 0;
    while (performance.now() < end) {
      await this.mouse("mouseMoved", x + (i++ % 2), y, 1);
      await sleep(FRAME_MS);
      if (until && i % 6 === 0 && (await until())) break;
    }
    await this.mouse("mouseMoved", x, y, 1);
  }
  async escape() {
    const k = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await this.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
    await this.mouse("mouseReleased", this.x, this.y, 0);
  }
  release() {
    return this.mouse("mouseReleased", this.x, this.y, 0);
  }
}

/**
 * The same page driver on Playwright WebKit (`--browser webkit`), the nearest scriptable stand-in for Safari
 * (VEC-97). WebKit has no CDP here: no Performance.getMetrics (layout/style columns read 0), no long-task or
 * LoAF entries (LT columns read 0, which means "not measured", not "none"), no CPU profile and no SSE
 * frames (RT reads 0). Frames, the card columns, renders per move and handler time are measured the same way.
 */
class WebKitPage extends Page {
  constructor(pw) {
    super({ on() {} });
    this.pw = pw;
    pw.on("request", (r) => {
      if (!this.net) return;
      const h = r.headers();
      if (h["next-action"]) this.net.actions.push(r.url());
      else if (h.rsc === "1" || /[?&]_rsc=/.test(r.url())) this.net.rsc.push(r.url());
    });
  }
  async init(probe) {
    await this.pw.addInitScript(probe);
  }
  async eval(expr) {
    return this.pw.evaluate(`(async () => (${expr}))()`);
  }
  async goto(url) {
    debug("goto", url);
    await this.pw.goto(url);
    await this.waitFor("document.readyState === 'complete' && window.__perf?.everCommitted && !!document.querySelector('ul[data-sortable-list]')", 30000);
    if ((await this.eval("location.pathname")).startsWith("/login")) throw new Error(`signed out at ${url}`);
    await sleep(1500);
  }
  async metrics() {
    return {};
  }
  async mouse(type, x, y) {
    this.x = x;
    this.y = y;
    const m = this.pw.mouse;
    if (type === "mouseMoved") return m.move(x, y);
    await m.move(x, y);
    return type === "mousePressed" ? m.down() : m.up();
  }
  async escape() {
    await this.pw.keyboard.press("Escape");
    await this.pw.mouse.up();
  }
}

async function importPlaywright() {
  // Not a dependency of the app: resolve it from PLAYWRIGHT_DIR (a scratch npm dir with `playwright` installed
  // and `npx playwright install webkit` run), else from the repo.
  const base = process.env.PLAYWRIGHT_DIR ? path.join(process.env.PLAYWRIGHT_DIR, "x.js") : path.join(ROOT, "x.js");
  return import(pathToFileURL(createRequire(base).resolve("playwright")).href);
}

async function launchWebKit(headless) {
  const pwMod = await importPlaywright();
  const { webkit } = pwMod.webkit ? pwMod : pwMod.default;
  const browser = await webkit.launch({ headless });
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const pw = await context.newPage();
  return {
    page: new WebKitPage(pw),
    setCookie: (url, value) => context.addCookies([{ name: "authjs.session-token", value, url: `${url}/`, httpOnly: true }]),
    close: () => browser.close(),
  };
}

// ---- Scenarios ---------------------------------------------------------------------------------------
// Each one: set up (scroll), press, then `record` wraps the measured move phase, then end (drop or Escape).

const centre = (b) => ({ x: b.x + Math.min(60, b.w / 3), y: b.y + b.h / 2 });
const inView = (L, r) => L.scroller && r.y > L.scroller.y + 60 && r.y + r.h < L.scroller.y + L.scroller.h - 60;
const taskGroups = (L) => L.groups.filter((g) => g.rows.length);

function pickPair(L) {
  const gs = L.groups;
  for (let i = 0; i < gs.length; i++) {
    if (!gs[i].rows.length) continue;
    const b = gs.slice(i + 1).find((g) => g.rows.length);
    if (b) return [gs[i], b];
  }
  throw new Error("need two non-empty, unfolded status groups");
}

const scenarios = {
  async reorder(page, record) {
    let L = await page.layout();
    const a = taskGroups(L).sort((x, y) => y.rows.length - x.rows.length)[0];
    if (!a || a.rows.length < 3) throw new Error("need a status group with 3+ rows");
    await page.eval(`window.__perf.scrollGroupTo(${JSON.stringify(a.listId)}, ${L.scroller.y + 110}, 0)`);
    L = await page.layout();
    const rows = L.groups.find((g) => g.listId === a.listId).rows.filter((r) => inView(L, r));
    const src = centre(rows[0].handle);
    await page.press(src.x, src.y);
    const down = rows[Math.min(rows.length - 1, 8)];
    await record(async () => {
      await page.path(src.x, down.y + down.h - 3);
      await page.path(src.x, rows[1].y + rows[1].h - 3);
    });
  },

  async across(page, record) {
    let L = await page.layout();
    const [a, b] = pickPair(L);
    await page.eval(`window.__perf.scrollGroupTo(${JSON.stringify(b.listId)}, ${L.scroller.y + L.scroller.h * 0.5})`);
    L = await page.layout();
    const ra = L.groups.find((g) => g.listId === a.listId).rows.filter((r) => inView(L, r));
    const rb = L.groups.find((g) => g.listId === b.listId).rows.filter((r) => inView(L, r));
    if (!ra.length || !rb.length) throw new Error("groups not both in view");
    const src = centre(ra[ra.length - 1].handle);
    await page.press(src.x, src.y);
    const into = rb[Math.min(rb.length - 1, 5)];
    await record(async () => {
      await page.path(src.x, into.y + into.h - 3);
      const back = ra[Math.max(0, ra.length - 3)];
      await page.path(src.x, back.y + back.h - 3);
      await page.path(src.x, into.y + into.h - 3);
    });
  },

  async heading(page, record) {
    let L = await page.layout();
    const [a, b] = pickPair(L);
    await page.eval(`window.__perf.scrollGroupTo(${JSON.stringify(b.listId)}, ${L.scroller.y + L.scroller.h * 0.5})`);
    L = await page.layout();
    const ra = L.groups.find((g) => g.listId === a.listId).rows.filter((r) => inView(L, r));
    const h = L.groups.find((g) => g.listId === b.listId).heading;
    const src = centre(ra[0].handle);
    await page.press(src.x, src.y);
    await record(async () => {
      await page.path(src.x, h.y + h.h / 2);
      await page.hover(600);
    });
  },

  async spring(page, record) {
    await page.eval("document.querySelector('section[aria-label] .overflow-y-auto').scrollTop = 0");
    let L = await page.layout();
    const g = taskGroups(L)[0];
    const row = g.rows.find((r) => inView(L, r)) ?? g.rows[0];
    const proj = L.projects.find((p) => !p.active && p.y > 0 && p.y < VIEW.height - 40);
    if (!proj) throw new Error("no sidebar project row in view");
    const src = centre(row.handle);
    const origin = L.url;
    await page.press(src.x, src.y);
    await record(async () => {
      await page.path(proj.x + 60, proj.y + proj.h / 2);
      await page.hover(2500, async () => (await page.eval("location.pathname + location.search")) !== origin);
      await page.hover(300);
      L = await page.layout();
      const into = taskGroups(L)[0]?.rows.filter((r) => inView(L, r))[1];
      if (into) {
        await page.path(into.handle.x + 120, into.y + into.h - 3);
        await page.hover(200);
      }
    });
    return { origin };
  },

  async project(page, record) {
    const L = await page.layout();
    const ps = L.projects.filter((p) => p.y > 0 && p.y < VIEW.height - 40);
    if (ps.length < 3) throw new Error("need 3+ sidebar projects in view");
    const x = ps[0].x + 60;
    await page.press(x, ps[0].y + ps[0].h / 2);
    const down = ps[Math.min(ps.length - 1, 6)];
    await record(async () => {
      await page.path(x, down.y + down.h - 3);
      await page.path(x, ps[0].y + 3);
      await page.path(x, down.y + down.h - 3);
    });
  },
};

/** reorder, with a teammate's edits arriving over realtime mid-drag (needs the fixture's bot). */
scenarios.realtime = async (page, record, ctx) => {
  if (!ctx.bot) throw new Error("realtime needs the throwaway org's fixture bot (size large)");
  const { url, key, taskKeys } = ctx.bot;
  // Each edit must change something, or the server publishes nothing: step every task's priority on each visit.
  const prio = (ctx.bot.prio ??= new Map());
  let i = ctx.bot.round ?? 0;
  let stop = false;
  const edits = (async () => {
    while (!stop) {
      const k = taskKeys[i++ % taskKeys.length];
      const next = ((prio.get(k) ?? i) + 1) % 4;
      prio.set(k, next);
      const r = await fetch(`${url}/api/v1/tasks/${k}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ priority: next }),
      }).catch((e) => ({ ok: false, status: e.message, text: async () => "" }));
      ctx.edits = ctx.edits ?? { ok: 0, failed: 0, last: "" };
      if (r.ok) ctx.edits.ok++;
      else {
        ctx.edits.failed++;
        ctx.edits.last = `${r.status} ${(await r.text()).slice(0, 120)}`;
      }
      await sleep(400);
    }
  })();
  try {
    await scenarios.reorder(page, record);
  } finally {
    stop = true;
    await edits;
    ctx.bot.round = i;
    if (ctx.edits?.failed) debug("realtime edits", ctx.edits);
  }
};

/** One drag: returns the raw sample. `count` = render-counting run (wrapped layout reads, fiber walk). */
async function runOnce(page, name, { count, drop, ctx = {} }) {
  let sample = null;
  let traceSummary = null;
  const record = async (moves) => {
    page.net = { realtime: [], rsc: [], actions: [] };
    const m0 = await page.metrics();
    await page.eval(`window.__perf.start(${count})`);
    // PERF_PROFILE=<dir>: also record a CPU profile of each timed run (open it in DevTools > Performance).
    const profile = process.env.PERF_PROFILE && !count && page instanceof Page && !(page instanceof WebKitPage);
    if (profile) {
      await page.cdp.send("Profiler.enable");
      await page.cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      await page.cdp.send("Profiler.start");
    }
    // PERF_TRACE=<dir>: also record a DevTools timeline trace of each timed run and count what the main thread
    // did per frame (style recalcs and the elements they touched, layouts, paints) (VEC-97).
    const trace = process.env.PERF_TRACE && !count && !(page instanceof WebKitPage);
    let events = null;
    if (trace) {
      events = [];
      page.cdp.on("Tracing.dataCollected", (e) => events?.push(...e.value));
      await page.cdp.send("Tracing.start", {
        categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame",
        options: "record-as-much-as-possible",
      });
    }
    await moves();
    if (trace) {
      const done = new Promise((r) => page.cdp.on("Tracing.tracingComplete", r));
      await page.cdp.send("Tracing.end");
      await done;
      const all = events;
      events = null;
      fs.mkdirSync(process.env.PERF_TRACE, { recursive: true });
      const file = path.join(process.env.PERF_TRACE, `${name}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify({ traceEvents: all }));
      const n = (nm) => all.filter((e) => e.name === nm && e.ph === "X");
      const dur = (xs) => xs.reduce((a, e) => a + (e.dur || 0), 0) / 1000;
      const ult = n("UpdateLayoutTree");
      // Main-thread time per frame (renderer main thread tasks bucketed by frame): the headroom that decides
      // whether a 120 Hz display (8.3 ms) can be held, which a 60 Hz frame interval can't show.
      const main = (() => {
        const c = new Map();
        for (const e of all) if (e.name === "UpdateLayoutTree" || e.name === "Paint") c.set(`${e.pid}:${e.tid}`, (c.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
        const tid = [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const tasks = all.filter((e) => e.name === "RunTask" && e.ph === "X" && `${e.pid}:${e.tid}` === tid);
        if (!tasks.length) return [];
        const t0 = Math.min(...tasks.map((e) => e.ts));
        const b = new Map();
        for (const e of tasks) {
          const k = Math.floor((e.ts - t0) / (FRAME_MS * 1000));
          b.set(k, (b.get(k) ?? 0) + e.dur / 1000);
        }
        return [...b.values()];
      })();
      traceSummary = {
        file,
        frames: all.filter((e) => e.name === "BeginFrame").length,
        style: ult.length,
        styleEls: ult.reduce((a, e) => a + (e.args?.elementCount || 0), 0),
        styleMs: dur(ult),
        layout: n("Layout").length,
        layoutMs: dur(n("Layout")),
        paint: n("Paint").length,
        paintMs: dur(n("Paint")),
        prePaintMs: dur(n("PrePaint")),
        layerizeMs: dur(n("Layerize")),
        mainP50: +pct(main, 50).toFixed(2),
        mainP95: +pct(main, 95).toFixed(2),
        mainMax: +Math.max(0, ...main).toFixed(2),
      };
      console.log(`    trace ${name}: ${JSON.stringify(traceSummary)}`);
    }
    if (profile) {
      const { profile: p } = await page.cdp.send("Profiler.stop");
      fs.mkdirSync(process.env.PERF_PROFILE, { recursive: true });
      const file = path.join(process.env.PERF_PROFILE, `${name}-${Date.now()}.cpuprofile`);
      fs.writeFileSync(file, JSON.stringify(p));
      debug("cpu profile", file);
    }
    const r = await page.eval("window.__perf.stop()");
    const m1 = await page.metrics();
    const d = (k) => (m1[k] ?? 0) - (m0[k] ?? 0);
    sample = {
      ...r,
      net: page.net,
      layouts: d("LayoutCount"),
      styles: d("RecalcStyleCount"),
      layoutMs: d("LayoutDuration") * 1000,
      styleMs: d("RecalcStyleDuration") * 1000,
      scriptMs: d("ScriptDuration") * 1000,
    };
    page.net = null;
  };
  const extra = (await scenarios[name](page, record, ctx)) ?? {};
  const tEnd = await page.eval("performance.now()");
  if (drop) await page.release();
  else await page.escape();
  await sleep(1500);
  sample.end = await page.eval(`window.__perf.after(${tEnd})`);
  if (extra.origin && !drop) {
    // A cancelled spring drag goes back to the page it started on.
    await page.waitFor(`location.pathname + location.search === ${JSON.stringify(extra.origin)}`, 8000).catch(() => {
      sample.note = "did not return to origin";
    });
  }
  return sample;
}

async function idle(page) {
  await page.eval("window.__perf.start(false)");
  await sleep(1500);
  return page.eval("window.__perf.stop()");
}

// ---- Stats -------------------------------------------------------------------------------------------

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const median = (xs) => pct(xs, 50);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function summarise(countRun, timed, interval) {
  const frames = timed.flatMap((s) => s.frames);
  const slots = frames.map((d) => Math.max(1, Math.round(d / interval)));
  const dropped = sum(slots.map((n) => n - 1));
  const lts = timed.map((s) => s.longtasks);
  const moves = countRun.moveMs.length || 1;
  const top = Object.entries(countRun.renders).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} ${(c / moves).toFixed(1)}`);
  const forced = timed.flatMap((s) => s.loafs.flatMap((l) => l.scripts.map((x) => x.forced || 0)));
  return {
    moves: Math.round(median(timed.map((s) => s.moveMs.length))),
    p50: pct(frames, 50),
    p95: pct(frames, 95),
    max: Math.max(...frames),
    droppedPct: (100 * dropped) / sum(slots),
    ltCount: sum(lts.map((l) => l.length)) / timed.length,
    ltMs: sum(lts.map((l) => sum(l.map((e) => e.d)))) / timed.length,
    ltMax: Math.max(0, ...lts.flat().map((e) => e.d)),
    rendersPerMove: sum(Object.values(countRun.renders)) / moves,
    commitsPerMove: countRun.commits / moves,
    handlerP50: pct(timed.flatMap((s) => s.moveMs), 50),
    handlerP95: pct(timed.flatMap((s) => s.moveMs), 95),
    layoutsPerMove: sum(timed.map((s) => s.layouts)) / sum(timed.map((s) => s.moveMs.length || 1)),
    layoutMsPerMove: sum(timed.map((s) => s.layoutMs + s.styleMs)) / sum(timed.map((s) => s.moveMs.length || 1)),
    gbcrPerMove: countRun.gbcr / moves,
    gcsPerMove: countRun.gcs / moves,
    forcedMs: sum(forced) / timed.length,
    realtime: [...new Set(timed.flatMap((s) => s.net.realtime).concat(countRun.net.realtime))],
    realtimeCount: sum(timed.map((s) => s.net.realtime.length)) / timed.length,
    rsc: sum(timed.map((s) => s.net.rsc.length)) / timed.length,
    actions: sum(timed.map((s) => s.net.actions.length)) / timed.length,
    endLtMs: sum(timed.map((s) => sum(s.end.longtasks.map((e) => e.d)))) / timed.length,
    endLtMax: Math.max(0, ...timed.flatMap((s) => s.end.longtasks.map((e) => e.d))),
    // The floating card (VEC-97): frames with a pointermove in which the card wasn't yet where the latest
    // pointer puts it, its lag in px, and how many times per second it actually moved.
    cardStalePct: (() => {
      const c = timed.flatMap((x) => x.card ?? []);
      return c.length ? (100 * c.filter((e) => e.lag > 0.5).length) / c.length : NaN;
    })(),
    cardLagP95: pct(timed.flatMap((x) => (x.card ?? []).map((e) => e.lag)), 95),
    cardFps: median(
      timed
        .map((x) => x.card ?? [])
        .filter((c) => c.length > 1)
        .map((c) => (1000 * c.filter((e) => e.moved).length) / (c.at(-1).t - c[0].t)),
    ),
    topRenders: top,
    notes: [...new Set(timed.concat(countRun).map((s) => s.note).filter(Boolean))],
  };
}

const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "-");
const f0 = (n) => (Number.isFinite(n) ? n.toFixed(0) : "-");

function printTable(rows) {
  const cols = [
    ["target", (r) => r.target],
    ["size", (r) => r.size],
    ["pane", (r) => r.pane],
    ["scenario", (r) => r.scenario],
    ["moves", (r) => f0(r.s.moves)],
    ["p50 ms", (r) => f1(r.s.p50)],
    ["p95 ms", (r) => f1(r.s.p95)],
    ["max ms", (r) => f0(r.s.max)],
    ["drop %", (r) => f1(r.s.droppedPct)],
    ["LT n", (r) => f1(r.s.ltCount)],
    ["LT ms", (r) => f0(r.s.ltMs)],
    ["LT max", (r) => f0(r.s.ltMax)],
    ["card fps", (r) => f0(r.s.cardFps)],
    ["stale %", (r) => f1(r.s.cardStalePct)],
    ["rend/mv", (r) => f1(r.s.rendersPerMove)],
    ["hndl p95", (r) => f1(r.s.handlerP95)],
    ["lay/mv", (r) => f1(r.s.layoutsPerMove)],
    ["gBCR/mv", (r) => f1(r.s.gbcrPerMove)],
    ["RT", (r) => f1(r.s.realtimeCount)],
    ["RSC", (r) => f1(r.s.rsc)],
    ["end LT", (r) => f0(r.s.endLtMs)],
  ];
  const cells = [cols.map((c) => c[0]), ...rows.map((r) => cols.map((c) => String(c[1](r))))];
  const w = cols.map((_, i) => Math.max(...cells.map((row) => row[i].length)));
  const line = (row) => row.map((v, i) => (i < 4 ? v.padEnd(w[i]) : v.padStart(w[i]))).join("  ");
  console.log(line(cells[0]));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const row of cells.slice(1)) console.log(line(row));
}

// ---- Main --------------------------------------------------------------------------------------------

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const probe = fs.readFileSync(path.join(HERE, "probe.js"), "utf8");
  const { client, db } = await connect(env);
  let large = null;
  let chrome = null;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (chrome) await chrome.close().catch(() => {});
    if (large && !opt.keepOrg) {
      const counts = await deleteOrg(db, large.orgId);
      const left = await leftovers(db, large.orgId);
      console.log(`\nThrowaway org ${large.slug} deleted: ${JSON.stringify(counts)}; documents left: ${left}`);
    } else if (large) console.log(`\nKept throwaway org ${large.slug} (${large.orgId})`);
    await client.close();
  };
  process.on("SIGINT", () => cleanup().finally(() => process.exit(130)));

  try {
    const user = await db.collection("users").findOne({ email: opt.user });
    if (!user) throw new Error(`no user ${opt.user}`);
    const uid = user._id.toHexString();
    const org = await db.collection("orgs").findOne({ slug: opt.org });
    if (opt.sizes.includes("current")) {
      const m = org && (await db.collection("memberships").findOne({ orgId: org._id, userId: new ObjectId(uid) }));
      if (m?.role !== "admin") throw new Error(`${opt.user} must be an admin of ${opt.org} (manual drags are creator/admin only)`);
    }
    if (opt.sizes.includes("large")) {
      large = await createLargeOrg(db, uid, { tasks: opt.tasks, projects: opt.projects });
      console.log(`Created throwaway org ${large.slug}: ${large.taskCount} tasks, ${large.projectKeys.length} projects`);
    }
    const token = await mintSession(env, uid);
    let page;
    if (opt.browser === "webkit") {
      const wk = await launchWebKit(opt.headless);
      chrome = wk;
      page = wk.page;
      await page.init(probe);
      for (const t of opt.targets) await wk.setCookie(t.url, token);
    } else {
      chrome = await launchChrome(opt.headless);
      page = new Page(chrome.cdp);
      await page.init(probe);
      for (const t of opt.targets) {
        await chrome.cdp.send("Network.setCookie", { name: "authjs.session-token", value: token, url: `${t.url}/`, path: "/", httpOnly: true });
      }
    }

    const results = [];
    const raw = [];
    for (const t of opt.targets) {
      // Frame floor of this browser on this machine: the interval dropped frames are counted against.
      await page.goto(`${t.url}/o/${opt.org}/all`);
      const cal = await idle(page);
      const interval = median(cal.frames) || FRAME_MS;
      console.log(`\n[${t.name}] ${t.url}  idle rAF: p50 ${f1(pct(cal.frames, 50))} ms, p95 ${f1(pct(cal.frames, 95))} ms (interval ${f1(interval)} ms)`);
      for (const size of opt.sizes) {
        const slug = size === "large" ? large.slug : opt.org;
        const drop = size === "large" || opt.drop;
        const listUrl = `${t.url}/o/${slug}/all`;
        const ctx = size === "large" ? { bot: { url: t.url, key: large.botKey, taskKeys: large.botTaskKeys } } : {};
        for (const pane of opt.panes) {
          let url = listUrl;
          if (pane === "open") {
            await page.goto(listUrl);
            const L = await page.layout();
            const gs = taskGroups(L);
            const key = gs[gs.length - 1]?.rows.at(-1)?.key;
            if (!key) throw new Error("no task to open in the pane");
            url = `${listUrl}?task=${encodeURIComponent(key)}`;
          }
          for (const name of SCENARIOS.filter((s) => opt.only.includes(s) && (s !== "realtime" || size === "large"))) {
            const samples = [];
            try {
              for (let i = 0; i <= opt.runs; i++) {
                await page.goto(url);
                samples.push(await runOnce(page, name, { count: i === 0, drop, ctx }));
              }
            } catch (e) {
              console.log(`  ${size}/${pane}/${name}: FAILED ${e.message}`);
              await page.escape().catch(() => {});
              continue;
            }
            const s = summarise(samples[0], samples.slice(1), interval);
            const row = { target: t.name, size, pane, scenario: name, s };
            results.push(row);
            raw.push({ ...row, samples });
            console.log(`  ${size}/${pane}/${name}: p95 ${f1(s.p95)} ms, ${f1(s.droppedPct)}% dropped, ${f1(s.ltCount)} long tasks (${f0(s.ltMs)} ms), ${f1(s.rendersPerMove)} renders/move`);
          }
        }
      }
    }

    console.log("\nScenarios:");
    for (const n of SCENARIOS.filter((s) => opt.only.includes(s))) console.log(`  ${n.padEnd(8)} ${DESCRIPTIONS[n]}`);
    console.log(
      "\nColumns: p50/p95/max = rAF frame time during the move; drop % = missed frame slots; LT = long tasks (>50 ms) per run, count / total / longest;\n" +
        "rend/mv = React component renders per pointermove; hndl p95 = pointermove handler incl. the synchronous React commit (ms);\n" +
        "card fps = times per second the floating card moved; stale % = frames with a pointermove that painted the card short of the pointer;\n" +
        "lay/mv = layouts per move (Performance.getMetrics); gBCR/mv = getBoundingClientRect calls per move; RT = realtime events received\n" +
        "mid-drag; RSC = RSC fetches mid-drag; end LT = long-task ms in the 1.5 s after the drop / Escape. Real orgs end with Escape.\n",
    );
    printTable(results);
    console.log("\nTop renders per pointermove (count run):");
    for (const r of results) console.log(`  ${r.target}/${r.size}/${r.pane}/${r.scenario}: ${r.s.topRenders.join(", ")}${r.s.notes.length ? `  [${r.s.notes.join("; ")}]` : ""}`);
    if (opt.json) {
      fs.writeFileSync(opt.json, JSON.stringify({ at: new Date().toISOString(), options: { ...opt }, results: raw }, null, 1));
      console.log(`\nRaw samples: ${opt.json}`);
    }
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
