import { useEffect, useRef, useState } from "react";
/** Prevent duplicate submissions and late callbacks after a scope/selection unmount. */
export function useRuleAction() {
  const active = useRef(false),
    busy = useRef(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function run<T>(work: () => Promise<T>, done: (value: T) => void) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await work();
      if (active.current) done(result);
    } catch {
      if (active.current) setError(true);
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }
  return { pending, error, run };
}
