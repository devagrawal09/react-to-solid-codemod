# Reviewing a value for a Solid 2 conversion

The component is being converted from React (with the React Compiler) to Solid 2. In Solid the
component body runs once; it does not rerun when props, state, stores or context change. Every
`const` in the body therefore has to be one of the following. Choose for each listed value.

Assume hooks have already been converted the usual way: `useState`/store selectors/atom values
become reactive accessors, `useRef`, `useId`, setters, `useNavigate` and similar stay stable,
context objects become objects of getters. Props are reactive. Read other files in the checkout to
see what a local hook returns when it matters.

| Answer | Meaning |
|---|---|
| static | Computed once is correct: it depends on nothing that can change while the component is mounted (module constants, `useId`, refs, setters, stable functions). |
| function | A function (arrow or declaration). It needs no wrapper because it reads values when it is called. Use this for any function, even if it reads reactive values. |
| memo | Derived from reactive values and worth caching: allocates (object, array, `.map`/`.filter`, a non-trivial call) or is read in several places. Becomes `createMemo(() => ...)`. |
| accessor | Derived from reactive values but cheap (a comparison, a field read, a boolean, a template string). Becomes `() => ...`, re-evaluated on read. |
| call-time | Derived from reactive values but only ever read inside event handlers, effects or callbacks, never during render or in JSX. A `() => ...` read at the moment it's used. |
| inline | A JSX element used exactly once in the returned JSX: move it to where it is used. |
| jsx-fn | A JSX element used more than once or passed on (to a prop, a function): becomes `() => <...>`. |
| getter-object | A hook result or object whose properties should be read as `x.prop` at the point of use (a context, or an object of getters a converted hook returns). |
| getter-read | A value destructured from such an object (`const { a } = useThing()`): read it as `thing.a` at the use site instead. |

If memo vs accessor is a judgment call, pick one and add `close` in the note. If you can't tell
from the code, answer `unsure` with the reason.

Output, one line per value, exactly:

`<packet id> | <value name> | <line> | <answer> | <one-line reason>`
