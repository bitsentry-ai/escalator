import { useEffect, useRef, useState } from "react";
import type { AcknowledgementResult } from "../../contracts/index.js";
import type { AcknowledgementClient } from "./client.js";
export function AcknowledgementScreen({
  client,
  t,
}: {
  client: AcknowledgementClient | undefined;
  t: (key: string) => string;
}) {
  const [result, setResult] = useState<AcknowledgementResult>();
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    setResult(undefined);
    setError(false);
    setPending(true);
    if (!client) {
      setResult({ state: "invalid" });
      setPending(false);
    } else
      void client
        .preview(controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setResult(value);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setPending(false);
        });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [client, reload]);
  async function acknowledge() {
    if (!client || pending || result?.state !== "open") return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setError(false);
    try {
      const value = await client.acknowledge(controller.signal);
      if (!controller.signal.aborted) setResult(value);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <main
      style={{
        maxWidth: 480,
        width: "100%",
        boxSizing: "border-box",
        margin: "auto",
        padding: 20,
        overflowWrap: "anywhere",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>{t("ack.title")}</h1>
      {pending && <p role="status">{t("ack.loading")}</p>}
      {error && (
        <div role="alert">
          <p>{t("ack.failed")}</p>
          <button
            disabled={pending}
            onClick={() => setReload((value) => value + 1)}
          >
            {t("ack.retry")}
          </button>
        </div>
      )}
      {result?.state === "open" && (
        <>
          <h2>{result.title}</h2>
          <p>{t("ack.explanation")}</p>
          <button
            style={{ minHeight: 48, width: "100%", font: "inherit" }}
            disabled={pending}
            onClick={() => void acknowledge()}
          >
            {t("ack.confirm")}
          </button>
        </>
      )}
      {result && result.state !== "open" && (
        <p role="status">{t(`ack.${result.state}`)}</p>
      )}
    </main>
  );
}
