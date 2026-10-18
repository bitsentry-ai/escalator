/** Separate from the entry module so tests can import it without starting a server. */
export function listenPort(raw: string | undefined): number {
  if (raw === undefined) return 3000;
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 65535)
    throw new Error("Invalid PORT");
  return Number(raw);
}
