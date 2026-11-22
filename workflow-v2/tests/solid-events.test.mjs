// @vitest-environment jsdom
// What a converted form field's handler hears from @solidjs/testing-library's fireEvent and from
// @testing-library/user-event, with solid-js 2.0.3 and @solidjs/web 2.0.3 (browser build). These
// specs decided how R46 rewrites fireEvent.change:
//
// - R13 turns a text field's onChange (an <input> of a text-like type, a <textarea>) into onInput,
//   which Solid delegates to the document's native `input` listener. fireEvent.change dispatches
//   only `change`, so the handler never runs; React's onChange heard it because React listens to
//   both `input` and `change` on a text field. fireEvent.input then fireEvent.change, as a browser
//   fires them, runs it once.
// - A <select>, a checkbox and a radio keep onChange, Solid's listener for the native `change`:
//   fireEvent.change already reaches it, and an `input` before it doesn't run it twice.
// - user-event types, selects and clicks the way a browser does (`input` per key, `change` on a
//   select or a checkbox), so its calls need no change.
import { afterEach, expect, it } from "vitest";
import { flush } from "solid-js";
import { spread } from "@solidjs/web";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// Renders an element with `props` the way the compiled JSX sets them (spread takes the same
// event path: onInput delegated, onChange a listener on the element); returns it and the values
// its handler was called with.
function field(tag, props) {
  const calls = [];
  const handler = (e) => calls.push(e.currentTarget.type === "checkbox" ? e.currentTarget.checked : e.currentTarget.value);
  let el;
  render(() => {
    el = document.createElement(tag);
    if (tag === "select") el.innerHTML = `<option value="a">a</option><option value="b">b</option>`;
    spread(el, Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v === "handler" ? handler : v])));
    return el;
  });
  return { el, calls };
}

it("doesn't run a converted text input's onInput on fireEvent.change, and runs it once on fireEvent.input then fireEvent.change", () => {
  const { el, calls } = field("input", { onInput: "handler" });
  fireEvent.change(el, { target: { value: "sol" } });
  flush();
  expect(calls).toEqual([]);
  fireEvent.input(el, { target: { value: "soli" } });
  fireEvent.change(el, { target: { value: "soli" } });
  flush();
  expect(calls).toEqual(["soli"]);
});

it("runs a converted textarea's onInput once on fireEvent.input then fireEvent.change", () => {
  const { el, calls } = field("textarea", { onInput: "handler" });
  fireEvent.input(el, { target: { value: "notes" } });
  fireEvent.change(el, { target: { value: "notes" } });
  flush();
  expect(calls).toEqual(["notes"]);
});

it("runs a select's onChange once on fireEvent.change, and once on fireEvent.input then fireEvent.change", () => {
  const { el, calls } = field("select", { onChange: "handler" });
  fireEvent.change(el, { target: { value: "b" } });
  flush();
  expect(calls).toEqual(["b"]);
  fireEvent.input(el, { target: { value: "a" } });
  fireEvent.change(el, { target: { value: "a" } });
  flush();
  expect(calls).toEqual(["b", "a"]);
});

it("runs a checkbox's onChange on fireEvent.change with target.checked, and on fireEvent.click", () => {
  const { el, calls } = field("input", { type: "checkbox", onChange: "handler" });
  fireEvent.change(el, { target: { checked: true } });
  flush();
  expect(calls).toEqual([true]);
  fireEvent.click(el);
  flush();
  expect(calls).toEqual([true, false]);
});

it("runs the converted handlers on user-event's type, selectOptions and click", async () => {
  const user = userEvent.setup();
  const text = field("input", { onInput: "handler" });
  const area = field("textarea", { onInput: "handler" });
  const select = field("select", { onChange: "handler" });
  const box = field("input", { type: "checkbox", onChange: "handler" });
  await user.type(text.el, "ab");
  await user.type(area.el, "c");
  await user.selectOptions(select.el, "b");
  await user.click(box.el);
  flush();
  expect([text.calls, area.calls, select.calls, box.calls]).toEqual([["a", "ab"], ["c"], ["b"], [true]]);
});
