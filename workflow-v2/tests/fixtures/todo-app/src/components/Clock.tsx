import { useEffect, useRef, useState } from "react";

export function Clock({ tickMs }: { tickMs: number }) {
  const [now, setNow] = useState(() => new Date());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return <div ref={box} onClick={() => box.current?.focus()} tabIndex={0}>{now.toLocaleTimeString()}</div>;
}
