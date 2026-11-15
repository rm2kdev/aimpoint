// Injected into every page before any app script (Page.addScriptToEvaluateOnNewDocument) by
// scripts/perf/drag.mjs. Measures what happens while the runner drives a drag, without touching app code:
//
// - frames: rAF deltas while recording
// - longtasks / long animation frames (LoAF, with per-script forced style+layout time)
// - pointermove handler time: window capture listener (start) to a window bubble listener added after the
//   drag engine's own (end); React's synchronous re-render from useSyncExternalStore runs in between
// - React work: a minimal __REACT_DEVTOOLS_GLOBAL_HOOK__ that, in "count" mode, walks each commit and counts
//   component fibers that actually rendered (PerformedWork flag), by component name
// - getBoundingClientRect / getComputedStyle calls (count mode only, the wrapper costs a little)
(() => {
  if (window.__perf) return;
  const P = {
    recording: false,
    counting: false,
    t0: 0,
    lastFrame: 0,
    frames: [],
    longtasks: [],
    loafs: [],
    moveStart: 0,
    moveMs: [],
    renders: new Map(),
    mounts: 0,
    commits: 0,
    everCommitted: false,
    gbcr: 0,
    gcs: 0,
  };
  window.__perf = P;

  // ---- React DevTools hook (render counting) -------------------------------------------------------
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo
  const PERFORMED_WORK = 1;
  const nameOf = (f) => {
    const t = f.type;
    if (!t) return "?";
    if (typeof t === "function") return t.displayName || t.name || "anonymous";
    if (t.displayName) return t.displayName;
    if (t.render) return t.render.displayName || t.render.name || "forwardRef";
    if (t.type) return t.type.displayName || t.type.name || "memo";
    return "?";
  };
  const countCommit = (rootFiber) => {
    P.commits++;
    const stack = [rootFiber];
    while (stack.length) {
      const f = stack.pop();
      const alt = f.alternate;
      if (COMPONENT_TAGS.has(f.tag)) {
        if (!alt) P.mounts++;
        else if (f.flags & PERFORMED_WORK) {
          const n = nameOf(f);
          P.renders.set(n, (P.renders.get(n) || 0) + 1);
        }
      }
      // A subtree React bailed out of keeps the very same child fibers: nothing below it rendered.
      if (alt && f.child === alt.child) continue;
      for (let c = f.child; c; c = c.sibling) stack.push(c);
    }
  };
  let nextId = 1;
  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(r) {
      const id = nextId++;
      this.renderers.set(id, r);
      return id;
    },
    onCommitFiberRoot(_id, root) {
      P.everCommitted = true;
      if (P.recording && P.counting) countCommit(root.current);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    setStrictMode() {},
    checkDCE() {},
    on() {},
    off() {},
    emit() {},
    sub() {
      return () => {};
    },
  };
  try {
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true, writable: true });
  } catch {}

  // ---- Long tasks + long animation frames -----------------------------------------------------------
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longtasks.push({ s: e.startTime, d: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        P.loafs.push({
          s: e.startTime,
          d: e.duration,
          blocking: e.blockingDuration,
          styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
          scripts: (e.scripts || []).map((s) => ({
            invoker: s.invoker,
            fn: s.sourceFunctionName,
            src: (s.sourceURL || "").split("/").pop(),
            d: s.duration,
            forced: s.forcedStyleAndLayoutDuration,
          })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}

  // ---- Frames -------------------------------------------------------------------------------------
  const tick = (t) => {
    if (!P.recording) return;
    if (P.lastFrame) P.frames.push(t - P.lastFrame);
    P.lastFrame = t;
    requestAnimationFrame(tick);
  };

  // ---- pointermove handler time ---------------------------------------------------------------------
  addEventListener(
    "pointermove",
    (e) => {
      if (P.recording && e.buttons) P.moveStart = performance.now();
    },
    true,
  );
  const moveEnd = () => {
    if (!P.moveStart) return;
    P.moveMs.push(performance.now() - P.moveStart);
    P.moveStart = 0;
  };
  // Bubble phase on window runs after React's root listener, i.e. after the drag engine added its own
  // window pointermove listener, so this one is called after it on every move.
  addEventListener("pointerdown", () => addEventListener("pointermove", moveEnd));
  addEventListener("pointerup", () => removeEventListener("pointermove", moveEnd));
  addEventListener("keydown", (e) => e.key === "Escape" && removeEventListener("pointermove", moveEnd), true);

  // ---- Layout read counters -------------------------------------------------------------------------
  const gbcr = Element.prototype.getBoundingClientRect;
  const gcs = window.getComputedStyle;
  const wrapReads = (on) => {
    if (on) {
      Element.prototype.getBoundingClientRect = function () {
        P.gbcr++;
        return gbcr.call(this);
      };
      window.getComputedStyle = function (...a) {
        P.gcs++;
        return gcs.apply(window, a);
      };
    } else {
      Element.prototype.getBoundingClientRect = gbcr;
      window.getComputedStyle = gcs;
    }
  };

  P.start = (count) => {
    P.recording = true;
    P.counting = !!count;
    P.t0 = performance.now();
    P.lastFrame = 0;
    P.frames = [];
    P.moveMs = [];
    P.moveStart = 0;
    P.renders = new Map();
    P.mounts = 0;
    P.commits = 0;
    P.gbcr = 0;
    P.gcs = 0;
    if (count) wrapReads(true);
    requestAnimationFrame(tick);
    return P.t0;
  };
  P.stop = () => {
    const t1 = performance.now();
    P.recording = false;
    if (P.counting) wrapReads(false);
    const inWin = (e) => e.s >= P.t0 && e.s <= t1;
    return {
      ms: t1 - P.t0,
      frames: P.frames,
      longtasks: P.longtasks.filter(inWin),
      loafs: P.loafs.filter(inWin),
      moveMs: P.moveMs,
      renders: Object.fromEntries(P.renders),
      mounts: P.mounts,
      commits: P.commits,
      gbcr: P.gbcr,
      gcs: P.gcs,
    };
  };
  /** Long tasks / LoAFs from `since` (performance.now() time) to now: the release / drop phase. */
  P.after = (since) => ({
    longtasks: P.longtasks.filter((e) => e.s >= since),
    loafs: P.loafs.filter((e) => e.s >= since),
  });

  // ---- Geometry for the runner ------------------------------------------------------------------------
  const visible = (el) => !!el && el.offsetParent !== null;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  P.layout = () => {
    const scroller = document.querySelector("section[aria-label] .overflow-y-auto");
    const lists = [...document.querySelectorAll("ul[data-sortable-list]:not([aria-label='Projects'])")].filter(visible);
    const groups = lists.map((ul) => {
      const h2 = ul.parentElement.querySelector("h2");
      return {
        listId: ul.dataset.listId,
        label: ul.getAttribute("aria-label"),
        heading: h2 ? box(h2.querySelector("button") || h2) : null,
        rows: [...ul.querySelectorAll(":scope > li[data-sortable-id]")].map((li) => {
          const handle = li.querySelector("[data-sortable-handle]");
          const href = handle?.getAttribute("href") || "";
          return { id: li.dataset.sortableId, key: new URLSearchParams(href.split("?")[1] || "").get("task"), ...box(li), handle: handle ? box(handle) : null };
        }),
      };
    });
    const projUl = [...document.querySelectorAll("ul[data-sortable-list][aria-label='Projects']")].find(visible);
    const projects = projUl
      ? [...projUl.querySelectorAll(":scope > li[data-sortable-id]")].map((li) => {
          const a = li.querySelector("a");
          return { id: li.dataset.sortableId, name: a?.textContent || "", href: a?.getAttribute("href") || "", active: a?.getAttribute("aria-current") === "page", ...box(li) };
        })
      : [];
    return { url: location.pathname + location.search, scroller: scroller ? box(scroller) : null, groups, projects };
  };
  /** Scroll the task list so viewport y of `listId`'s group top lands at `y`. */
  P.scrollGroupTo = (listId, y, rowIndex = -1) => {
    const scroller = document.querySelector("section[aria-label] .overflow-y-auto");
    const ul = document.querySelector(`ul[data-sortable-list][data-list-id='${listId}']`);
    if (!scroller || !ul) return false;
    const el = rowIndex >= 0 ? ul.querySelectorAll(":scope > li[data-sortable-id]")[rowIndex] || ul : ul.parentElement;
    scroller.scrollTop += el.getBoundingClientRect().top - y;
    return true;
  };
})();
