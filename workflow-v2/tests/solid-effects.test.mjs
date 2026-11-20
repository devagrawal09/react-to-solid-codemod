// @vitest-environment jsdom
// What solid-js 2.0.3 and @solidjs/web 2.0.3 (browser build, development mode) do with the shapes
// R41 writes for useEffect and useLayoutEffect. These specs decided its design:
//
// - createEffect's apply runs synchronously inside render() on mount, with the DOM already
//   inserted; on an update it runs in a microtask after the write, after the render effects have
//   updated the DOM, so before the browser paints. That is useLayoutEffect's timing (React's
//   useEffect runs after paint, so Solid runs it earlier). createRenderEffect's apply runs before
//   the element is inserted, so it is no stand-in for useLayoutEffect.
// - Reading a signal directly in apply warns STRICT_READ_UNTRACKED in dev. Solid's guidance is to
//   read in compute and take the value as apply's parameter, so R41 hands the deps to apply as
//   parameters. A cleanup then sees its own run's values, as React's does; one that read the
//   accessor would see the next run's.
// - A cleanup apply returns runs before the next apply, and on dispose (in reverse creation order;
//   React runs a component's cleanups in declaration order).
// - Writes in apply are allowed with no diagnostic. Effects that read the written signal re-run in
//   the same flush; a read in the same apply still sees the old value (as React's closure does). A
//   write to the effect's own dependency re-runs it until it stops writing, synchronously, with
//   no loop guard (React stops at its update-depth limit).
// - apply must return a function or undefined: anything else throws in dev. A setter returns the
//   value it set, so `() => setX(1)` needs a block body; an async apply returns a promise, which
//   throws too.
// - onSettled in a component body runs once after mount effects, with the DOM inserted, honors a
//   returned cleanup on dispose, and its reads don't warn. It maps useEffect(fn, []).
import { afterEach, expect, it } from "vitest";
import { createEffect, createRenderEffect, createSignal, flush, merge, onCleanup, onSettled } from "solid-js";
import { createComponent, render } from "@solidjs/web";

const { warn, error } = console;
let mounted = [];
afterEach(() => {
  for (const m of mounted) m.dispose();
  mounted = [];
  console.warn = warn;
  console.error = error;
});

// Renders `body` as a component into a connected element; console warnings and errors from then
// until the spec ends go to `warnings`.
function mount(body) {
  const box = document.createElement("div");
  document.body.append(box);
  const warnings = [];
  console.warn = (...args) => warnings.push(String(args[0]));
  console.error = (...args) => warnings.push(String(args[0]));
  const dispose = render(() => createComponent(body, {}), box);
  const m = { box, warnings, dispose: () => { dispose(); box.remove(); } };
  mounted.push(m);
  return m;
}

it("runs createEffect's apply inside render() on mount, with the element inserted; a render effect's apply runs before", () => {
  const log = [];
  mount(() => {
    const el = document.createElement("p");
    createRenderEffect(() => 1, () => { log.push(`render effect: connected=${el.isConnected}`); });
    createEffect(() => 1, () => { log.push(`effect: connected=${el.isConnected}`); });
    return el;
  });
  expect(log).toEqual(["render effect: connected=false", "effect: connected=true"]);
});

it("runs apply in a microtask after a write, after the DOM has been updated", async () => {
  const log = [];
  let setCount;
  mount(() => {
    const [count, set] = createSignal(0);
    setCount = set;
    const el = document.createElement("p");
    createRenderEffect(() => count(), (n) => { el.textContent = String(n); });
    createEffect(() => [count()], ([n]) => { log.push(`apply ${n}, text ${el.textContent}`); });
    return el;
  });
  setCount(1);
  expect(log).toEqual(["apply 0, text 0"]);
  await Promise.resolve();
  expect(log).toEqual(["apply 0, text 0", "apply 1, text 1"]);
});

it("warns when apply reads a signal, and not when it takes the value from compute", () => {
  const direct = mount(() => {
    const [count] = createSignal(0);
    createEffect(() => [count()], () => { count(); });
    return document.createElement("p");
  });
  expect(direct.warnings).toContainEqual(expect.stringMatching(/^\[STRICT_READ_UNTRACKED\] Reactive value read directly in an effect callback/));
  const viaParameter = mount(() => {
    const [count] = createSignal(0);
    createEffect(() => [count()], ([count]) => { String(count); });
    return document.createElement("p");
  });
  expect(viaParameter.warnings).toEqual([]);
});

it("runs the returned cleanup before the next apply, with its own run's values, and on dispose", () => {
  const log = [];
  let setId;
  const m = mount(() => {
    const [id, set] = createSignal("a");
    setId = set;
    createEffect(() => [id()], ([id]) => {
      log.push(`subscribe ${id}`);
      return () => { log.push(`unsubscribe ${id}`); };
    });
    return document.createElement("p");
  });
  setId("b");
  flush();
  m.dispose();
  expect(log).toEqual(["subscribe a", "unsubscribe a", "subscribe b", "unsubscribe b"]);
});

it("runs cleanups on dispose in reverse creation order", () => {
  const log = [];
  const m = mount(() => {
    createEffect(() => 1, () => () => { log.push("first"); });
    createEffect(() => 1, () => () => { log.push("second"); });
    return document.createElement("p");
  });
  m.dispose();
  expect(log).toEqual(["second", "first"]);
});

it("allows writes in apply: dependents update in the same flush, and the apply itself still reads the old value", async () => {
  const log = [];
  let setQuery;
  const m = mount(() => {
    const [query, setQ] = createSignal("");
    const [results, setResults] = createSignal([]);
    setQuery = setQ;
    createEffect(() => [query()], ([query]) => {
      setResults(query ? [query] : []);
      log.push(`after write: ${results().length}`);
    });
    createEffect(() => [results()], ([results]) => { log.push(`results: ${results.join()}`); });
    return document.createElement("p");
  });
  // On mount the write is a new empty array, so `results` changes and its effect runs again.
  expect(log).toEqual(["after write: 0", "results: ", "results: "]);
  setQuery("x");
  await Promise.resolve();
  expect(log.slice(3)).toEqual(["after write: 0", "results: x"]);
  // the read in apply warns; the write doesn't
  expect(m.warnings.length).toBeGreaterThan(0);
  expect(m.warnings.every((w) => w.startsWith("[STRICT_READ_UNTRACKED]"))).toBe(true);
});

it("re-runs an effect that writes its own dependency until it stops writing, synchronously", () => {
  const seen = [];
  const m = mount(() => {
    const [count, setCount] = createSignal(0);
    createEffect(() => [count()], ([count]) => {
      seen.push(count);
      if (count < 3) setCount(count + 1);
    });
    return document.createElement("p");
  });
  expect(seen).toEqual([0, 1, 2, 3]);
  expect(m.warnings).toEqual([]);
});

it("has no loop guard: an effect that always writes its own dependency keeps re-running", () => {
  let runs = 0;
  mount(() => {
    const [count, setCount] = createSignal(0);
    createEffect(() => [count()], ([count]) => {
      runs++;
      if (runs < 500) setCount(count + 1);
    });
    return document.createElement("p");
  });
  expect(runs).toBe(500);
});

it("throws when apply returns something other than a function: a setter's return value, or a promise", () => {
  expect(() => mount(() => {
    const [, setCount] = createSignal(0);
    createEffect(() => 1, () => setCount(1));
    return document.createElement("p");
  })).toThrow("effect callback returned an invalid cleanup value");
  expect(() => mount(() => {
    createEffect(() => 1, async () => {});
    return document.createElement("p");
  })).toThrow("effect callback returned an invalid cleanup value");
});

it("runs onSettled once after mount effects, with the element inserted, honors its cleanup, and doesn't warn on reads", () => {
  const log = [];
  let setCount;
  const m = mount(() => {
    const [count, set] = createSignal(0);
    setCount = set;
    const el = document.createElement("p");
    createEffect(() => [count()], ([count]) => { log.push(`effect ${count}`); });
    onSettled(() => {
      log.push(`settled: connected=${el.isConnected}, count=${count()}`);
      return () => { log.push("settled cleanup"); };
    });
    return el;
  });
  setCount(1);
  flush();
  m.dispose();
  expect(log).toEqual(["effect 0", "settled: connected=true, count=0", "effect 1", "settled cleanup"]);
  expect(m.warnings).toEqual([]);
});

// R43's zustand bridge, as its flag spells it out, over a store with zustand/vanilla's API
// (getState, setState that merges, subscribe that returns an unsubscribe). Converted callers read
// selected state as `x()` and call a selected action directly; this is what makes both true.
it("R43's zustand bridge: selected state is an accessor that follows the store, an action comes back as it is", () => {
  const createStore = (init) => {
    let state;
    const listeners = new Set();
    const setState = (partial) => { const prev = state; state = { ...state, ...(typeof partial === "function" ? partial(state) : partial) }; for (const l of listeners) l(state, prev); };
    const api = { getState: () => state, setState, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); }, listeners };
    state = init(setState, api.getState);
    return api;
  };
  const store = createStore((set) => ({ count: 0, inc: () => set((s) => ({ count: s.count + 1 })) }));
  const useCounter = Object.assign((selector) => { const initial = selector(store.getState()); if (typeof initial === "function") return initial; const [value, setValue] = createSignal(initial, { ownedWrite: true }); onCleanup(store.subscribe((state) => setValue(() => selector(state)))); return value; }, store);
  let inc;
  const m = mount(() => {
    const count = useCounter((s) => s.count);
    inc = useCounter((s) => s.inc);
    // A store write while a component runs (an owned scope) reaches every subscribed signal:
    // without ownedWrite, Solid throws REACTIVE_WRITE_IN_OWNED_SCOPE.
    inc();
    const el = document.createElement("p");
    createRenderEffect(() => count(), (n) => { el.textContent = String(n); });
    return el;
  });
  expect(inc).toBe(store.getState().inc);
  expect(m.box.textContent).toBe("1");
  inc();
  flush();
  expect(m.box.textContent).toBe("2");
  expect(m.warnings).toEqual([]);
  m.dispose();
  expect(store.listeners.size).toBe(0);
});

it("merge() keeps a getter in its defaults live, so R8's default that reads another prop follows that prop", () => {
  const [markdown, setMarkdown] = createSignal(false);
  const props = { get isMarkdown() { return markdown(); } };
  const merged = merge({ get showRefresh() { return !props.isMarkdown; } }, props);
  expect(merged.showRefresh).toBe(true);
  setMarkdown(true);
  flush();
  expect(merged.showRefresh).toBe(false);
  expect(merge({ get showRefresh() { return !props.isMarkdown; } }, { showRefresh: true }).showRefresh).toBe(true);
});
