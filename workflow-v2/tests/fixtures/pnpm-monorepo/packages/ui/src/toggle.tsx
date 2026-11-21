import { Check } from "lucide-react";
import { useToggle } from "@repo/hooks";

export function Toggle({ label }: { label: string }) {
  const { on, toggle } = useToggle(false);
  return (
    <button className="toggle" onClick={toggle}>
      {on && <Check />}
      {label}
    </button>
  );
}
