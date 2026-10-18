import type { Role } from "@bitsentry-escalator/features/contracts";
import type {
  AccountProof,
  AccountRecord,
  Registration,
} from "./auth.repository.js";
import {
  AuthenticationError,
  issueToken,
  PasswordHasher,
  tokenDigest,
} from "./credentials.js";
import { loginSchema } from "./schemas.js";

/** Host-local port. Proofs are produced after password/session verification, never from request input. */
export interface AuthAccounts {
  findByLogin(login: string): Promise<AccountRecord | undefined>;
  findById(id: string): Promise<AccountRecord | undefined>;
  register(input: Registration): Promise<string>;
  invite(
    proof: AccountProof,
    digest: string,
    role: Role,
    expiresAt: Date,
  ): Promise<string>;
  takeRateSlot(
    digest: string,
    maximum: number,
    windowSeconds: number,
  ): Promise<boolean>;
}
export interface AccountSecurity {
  authenticate(proof: AccountProof, factor?: string): Promise<AccountProof>;
  beginTotp(proof: AccountProof): Promise<{ uri: string }>;
  enableTotp(
    proof: AccountProof,
    token: string,
  ): Promise<{ proof: AccountProof; recoveryCodes: string[] }>;
  disableTotp(proof: AccountProof, factor: string): Promise<AccountProof>;
  recover(digest: string, passwordHash: string): Promise<void>;
}
export interface PasswordWork {
  create(password: string): Promise<string>;
  matches(encoded: string, password: string): Promise<boolean>;
}
export class LocalAuthService {
  // The dummy verifier is initialized once at composition time to equalize unknown-account work.
  constructor(
    private readonly accounts: AuthAccounts,
    private readonly security: AccountSecurity,
    private readonly passwords: PasswordWork,
    private readonly dummyHash: string,
    private readonly now: () => number = Date.now,
  ) {}
  static async create(accounts: AuthAccounts, security: AccountSecurity) {
    const passwords = new PasswordHasher();
    return new LocalAuthService(
      accounts,
      security,
      passwords,
      await passwords.create(issueToken().value),
    );
  }
  async initializeSession(ip: string): Promise<void> {
    if (
      !ip ||
      ip.length > 128 ||
      !(await this.accounts.takeRateSlot(
        tokenDigest(`session-ip:${ip}`),
        60,
        300,
      ))
    )
      throw new AuthenticationError();
  }
  private async limit(ip: string, subject: string): Promise<void> {
    if (!ip || ip.length > 128) throw new AuthenticationError();
    if (!(await this.accounts.takeRateSlot(tokenDigest(`ip:${ip}`), 30, 300)))
      throw new AuthenticationError();
    if (
      !(await this.accounts.takeRateSlot(
        tokenDigest(`subject:${subject}`),
        10,
        300,
      ))
    )
      throw new AuthenticationError();
  }
  private proof(account: AccountRecord): AccountProof {
    if (!account.enabled) throw new AuthenticationError();
    return { accountId: account.id, authVersion: account.authVersion };
  }
  async current(proof: AccountProof): Promise<AccountRecord> {
    const account = await this.accounts.findById(proof.accountId);
    if (!account?.enabled || account.authVersion !== proof.authVersion)
      throw new AuthenticationError();
    return account;
  }
  private async passwordProof(
    proof: AccountProof,
    password: string,
  ): Promise<AccountProof> {
    const account = await this.current(proof);
    if (!(await this.passwords.matches(account.passwordHash, password)))
      throw new AuthenticationError();
    // Security persistence rechecks the version under its row lock after password work.
    return this.proof(account);
  }
  async login(
    ip: string,
    input: { login: string; password: string; factor?: string },
  ): Promise<AccountProof> {
    const login = loginSchema.parse(input.login);
    await this.limit(ip, `login:${login}`);
    const account = await this.accounts.findByLogin(login);
    const valid = await this.passwords.matches(
      account?.passwordHash ?? this.dummyHash,
      input.password,
    );
    if (!account || !valid) throw new AuthenticationError();
    return this.security.authenticate(this.proof(account), input.factor);
  }
  async register(
    ip: string,
    input: {
      token: string;
      login: string;
      password: string;
      displayName: string;
      timeZone: string;
    },
  ): Promise<void> {
    await this.limit(ip, `register:${tokenDigest(input.token)}`);
    const passwordHash = await this.passwords.create(input.password);
    await this.accounts.register({
      tokenDigest: tokenDigest(input.token),
      login: input.login,
      passwordHash,
      displayName: input.displayName,
      timeZone: input.timeZone,
    });
    // Require a fresh login; consuming an invitation does not create a session.
  }
  async invite(ip: string, proof: AccountProof, role: Role): Promise<string> {
    await this.limit(ip, `invite:${proof.accountId}`);
    const account = await this.current(proof);
    if (account.role !== "administrator") throw new AuthenticationError();
    const token = issueToken();
    await this.accounts.invite(
      proof,
      token.digest,
      role,
      new Date(this.now() + 86400000),
    );
    return token.value;
  }
  async beginTotp(
    ip: string,
    proof: AccountProof,
    password: string,
  ): Promise<{ uri: string }> {
    await this.limit(ip, `mfa:${proof.accountId}`);
    return this.security.beginTotp(await this.passwordProof(proof, password));
  }
  async enableTotp(ip: string, proof: AccountProof, token: string) {
    await this.limit(ip, `mfa:${proof.accountId}`);
    await this.current(proof);
    return this.security.enableTotp(proof, token);
  }
  async disableTotp(
    ip: string,
    proof: AccountProof,
    password: string,
    factor: string,
  ) {
    await this.limit(ip, `mfa:${proof.accountId}`);
    return this.security.disableTotp(
      await this.passwordProof(proof, password),
      factor,
    );
  }
  async recover(ip: string, token: string, password: string): Promise<void> {
    await this.limit(ip, `recovery:${tokenDigest(token)}`);
    await this.security.recover(
      tokenDigest(token),
      await this.passwords.create(password),
    );
    // Operator recovery revokes prior sessions; require a new password login.
  }
}
