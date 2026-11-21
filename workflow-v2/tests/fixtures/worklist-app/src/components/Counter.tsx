import { useEffect, useTransition } from "react";
import { useCounter } from "../hooks/useCounter";
import { pad, shout } from "../lib/format";
import { useTheme } from "theme-kit";

export function Counter({ start, label }: { start: number; label: string }) {
  const counter = useCounter(start);
  const theme = useTheme();
  const [pending, startTransition] = useTransition();
  const title = shout(label);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    console.log(label, start);
  }, [start]);
  return (
    <button class={theme.dark ? "dark" : "light"} disabled={pending} onClick={() => startTransition(counter.increment)}>
      {pad(counter.count)}
    </button>
  );
}
