import { useCallback, useEffect, useRef, useState } from "react";
import type { IncidentPageInput } from "../../contracts/index.js";
import type { IncidentCollection } from "../incidents-client.js";
export function useIncidentCollection<T extends { id: string }>(
  fetch: (input: IncidentPageInput) => Promise<IncidentCollection<T>>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    busy.current = true;
    setItems([]);
    setNext(null);
    setLoading(true);
    setError(false);
    void fetch({ limit: 25 })
      .then((page) => {
        if (current === generation.current) {
          setItems(page.items);
          setNext(page.next);
        }
      })
      .catch(() => {
        if (current === generation.current) setError(true);
      })
      .finally(() => {
        if (current === generation.current) {
          busy.current = false;
          setLoading(false);
        }
      });
    return () => {
      generation.current++;
    };
  }, [fetch, reload]);
  async function more() {
    if (!next || busy.current) return;
    const current = generation.current;
    busy.current = true;
    setLoading(true);
    setError(false);
    try {
      const page = await fetch({ limit: 25, after: next });
      if (current === generation.current) {
        setItems((previous) => [
          ...previous,
          ...page.items.filter(
            (item) => !previous.some((old) => old.id === item.id),
          ),
        ]);
        setNext(page.next);
      }
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      if (current === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  }
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  return { items, next, loading, error, more, refresh };
}
