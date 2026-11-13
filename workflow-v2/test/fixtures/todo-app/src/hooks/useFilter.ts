import { useState } from "react";

export type Filter = "all" | "open" | "done";

export function useFilter(initial: Filter) {
  const [filter, setFilter] = useState<Filter>(initial);
  const label = filter === "all" ? "Everything" : filter === "open" ? "Still to do" : "Finished";
  return { filter, setFilter, label };
}
