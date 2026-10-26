import type { Role } from "@bitsentry-escalator/features/contracts";
export interface LocalUser {
  id: string;
  login: string;
  displayName: string;
  timeZone: string;
  role: Role;
  totpEnabled: boolean;
}
export interface LocalSession {
  csrf: string;
  user: LocalUser | null;
}
export interface Registration {
  token: string;
  login: string;
  password: string;
  displayName: string;
  timeZone: string;
}
/** A query carries its input in the URL; a mutation sends it in the body. */
function trpcUrl(name: string, queryInput: unknown): string {
  if (queryInput === undefined) return `/trpc/${name}`;
  return `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(queryInput))}`;
}
/** The session token a response carries, if any; a malformed one is rejected. */
function sessionToken(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("csrf" in result))
    return undefined;
  if (
    typeof result.csrf !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.csrf)
  )
    throw new Error("Invalid session token");
  return result.csrf;
}
/** Same-origin tRPC transport. Credentials/tokens stay in request bodies and memory. */
export class LocalAuthClient {
  private csrf: string | undefined;
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async mutationHeaders(): Promise<Record<string, string>> {
    if (!this.csrf) await this.session();
    // Without a session token the server rejects the mutation anyway.
    if (!this.csrf) throw new Error("Authentication request failed");
    return {
      "Content-Type": "application/json",
      "x-escalator-csrf": this.csrf,
    };
  }
  private async request<T>(
    name: string,
    input?: unknown,
    mutation = false,
  ): Promise<T> {
    const headers = mutation ? await this.mutationHeaders() : {};
    const response = await this.fetcher(
      trpcUrl(name, mutation ? undefined : input),
      {
        method: mutation ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: mutation ? JSON.stringify(input ?? null) : undefined,
      },
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        this.csrf = undefined;
      throw new Error("Authentication request failed");
    }
    const envelope = (await response.json()) as { result?: { data: unknown } };
    if (!envelope.result) throw new Error("Invalid authentication response");
    const result = envelope.result.data;
    const csrf = sessionToken(result);
    if (csrf !== undefined) this.csrf = csrf;
    return result as T;
  }
  query<T>(procedure: string, input?: unknown) {
    return this.request<T>(procedure, input);
  }
  mutate<T>(procedure: string, input?: unknown) {
    return this.request<T>(procedure, input, true);
  }
  session() {
    return this.request<LocalSession>("auth.session");
  }
  login(input: { login: string; password: string; factor?: string }) {
    return this.request<{ csrf: string }>("auth.login", input, true);
  }
  register(input: Registration) {
    return this.request<{ ok: boolean }>("auth.register", input, true);
  }
  invite(role: Role) {
    return this.request<{ token: string }>("auth.invite", { role }, true);
  }
  beginTotp(password: string) {
    return this.request<{ uri: string }>("auth.beginTotp", { password }, true);
  }
  enableTotp(token: string) {
    return this.request<{ csrf: string; recoveryCodes: string[] }>(
      "auth.enableTotp",
      { token },
      true,
    );
  }
  disableTotp(password: string, factor: string) {
    return this.request<{ csrf: string }>(
      "auth.disableTotp",
      { password, factor },
      true,
    );
  }
  async recover(token: string, password: string) {
    await this.request("auth.recover", { token, password }, true);
    this.csrf = undefined;
  }
  async logout() {
    await this.request("auth.logout", undefined, true);
    this.csrf = undefined;
  }
}
