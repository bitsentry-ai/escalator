import "reflect-metadata";
import { Module } from "@nestjs/common";
import { SecretKeyRing } from "./keyring.js";

export function loadSecretKeys(
  environment: Readonly<Record<string, string | undefined>>,
): SecretKeyRing {
  return SecretKeyRing.fromFile(environment.ESCALATOR_SECRET_KEY_FILE);
}
@Module({
  providers: [
    { provide: SecretKeyRing, useFactory: () => loadSecretKeys(process.env) },
  ],
  exports: [SecretKeyRing],
})
export class SecretKeysModule {}
