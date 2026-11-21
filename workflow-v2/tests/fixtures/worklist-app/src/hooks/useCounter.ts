import { useEffect, useState } from "react";

export function useCounter(start: number) {
  const [count, setCount] = useState(start);
  useEffect(() => {
    document.title = count + 1;
  });
  return { count, increment: () => setCount(count + 1) };
}
