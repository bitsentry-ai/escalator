export interface PollerOptions {
  intervalMs: number;
  batchSize: number;
  onError(): void;
}
/** One queue per poller keeps slow delivery attempts separate from deadline jobs. */
export class WorkPoller {
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  constructor(
    private readonly runOne: () => Promise<
      "idle" | "completed" | "retry" | "wait" | "failed" | "stale"
    >,
    private readonly options: PollerOptions,
  ) {
    if (
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1 ||
      options.intervalMs > 60_000 ||
      !Number.isSafeInteger(options.batchSize) ||
      options.batchSize < 1 ||
      options.batchSize > 100
    ) {
      throw new Error("Invalid work poller bounds");
    }
  }
  start(): void {
    if (this.stopping) throw new Error("Work poller is stopping");
    if (this.active) return;
    this.active = true;
    this.schedule(0);
  }
  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = Promise.resolve()
        .then(() => this.drain())
        .finally(() => {
          this.pending = undefined;
          if (this.active) this.schedule(this.options.intervalMs);
        });
    }, delay);
  }
  private async drain(): Promise<void> {
    try {
      for (
        let count = 0;
        this.active && count < this.options.batchSize;
        count++
      ) {
        if ((await this.runOne()) === "idle") break;
      }
    } catch {
      // The next poll may recover a database outage. Never log payloads or secrets.
      try {
        this.options.onError();
      } catch {
        /* Observability must not stop retries. */
      }
    }
  }
  /** Await the bounded attempt before the host disconnects its database. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.active = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stopping = (this.pending ?? Promise.resolve()).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
}
