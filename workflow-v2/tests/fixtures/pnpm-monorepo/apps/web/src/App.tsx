import { useState } from "react";
import { Toggle } from "@repo/ui/toggle";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <Toggle label="Dark" />
      <button onClick={() => setCount(count + 1)}>{count}</button>
    </main>
  );
}
