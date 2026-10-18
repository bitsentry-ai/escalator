/** Updated only after a real claim/settlement returns, never by a timer tick. */
export class SchedulerProgress {
  private active = false;
  private readonly settled: (number | null)[];
  constructor(
    lanes: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 65)
      throw new Error("Invalid health lane count");
    this.settled = Array.from({ length: lanes }, () => null);
  }
  start() {
    this.active = true;
    this.settled.fill(null);
  }
  stop() {
    this.active = false;
  }
  record(
    lane: number,
    outcome: "idle" | "completed" | "retry" | "wait" | "failed" | "stale",
  ) {
    if (
      !this.active ||
      lane < 0 ||
      lane >= this.settled.length ||
      !Number.isInteger(lane)
    )
      return;
    if (["idle", "completed", "retry", "wait"].includes(outcome))
      this.settled[lane] = this.now();
  }
  snapshot(): { running: boolean; laneAgeMs: (number | null)[] } {
    const now = this.now();
    return {
      running: this.active,
      laneAgeMs: this.settled.map((value) =>
        value === null ||
        !Number.isFinite(now) ||
        !Number.isFinite(value) ||
        now < value
          ? null
          : now - value,
      ),
    };
  }
}
