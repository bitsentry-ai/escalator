import "reflect-metadata";
import { Module } from "@nestjs/common";
import {
  DatabaseModule,
  StandaloneDatabase,
} from "../database/database.module.js";
import { SecretKeyRing } from "../secrets/keyring.js";
import { SecretKeysModule } from "../secrets/secrets.module.js";
import { PostgresAccountSecurity } from "./account-security.repository.js";
import { LocalAuthService } from "./auth.service.js";
@Module({
  imports: [DatabaseModule, SecretKeysModule],
  providers: [
    {
      provide: LocalAuthService,
      inject: [StandaloneDatabase, SecretKeyRing],
      useFactory: async (database: StandaloneDatabase, keys: SecretKeyRing) => {
        const accounts = new PostgresAccountSecurity(
          database.pool,
          database.workspaceId,
          keys,
        );
        return LocalAuthService.create(accounts, accounts);
      },
    },
  ],
  exports: [LocalAuthService, DatabaseModule, SecretKeysModule],
})
export class AuthModule {}
