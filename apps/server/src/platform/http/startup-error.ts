export function reportStartupFailure(error: unknown): void {
  console.error(
    "Escalator could not start; verify the database, mounted keys, public origin and built assets.",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
