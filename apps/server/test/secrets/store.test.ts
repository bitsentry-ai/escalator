import {
  secretFixtureSeed,
  secretFixtureValue,
  secretStoreConformance,
} from "@escalator-test/secrets";
import { SecretKeyRing } from "../../src/platform/secrets/keyring.js";
import { EncryptedSecretStore } from "../../src/platform/secrets/encrypted-secret.store.js";
secretStoreConformance("standalone encrypted secrets", () => {
  const seed = secretFixtureSeed();
  const keys = SecretKeyRing.parse({
    version: 1,
    activeKeyId: "fixture",
    keys: { fixture: Buffer.alloc(32, 1).toString("base64") },
  });
  let reads = 0;
  let revoked = false;
  const open = keys.open.bind(keys);
  keys.open = (identity, envelope) => {
    reads++;
    return open(identity, envelope);
  };
  const identity = {
    workspaceId: seed.request.workspaceId,
    id: seed.request.secretId,
  };
  const envelope = keys.seal(identity, Buffer.from(secretFixtureValue));
  const store = new EncryptedSecretStore(keys, {
    async load() {
      return { ...identity, envelope, disabled: revoked, claim: seed.claim };
    },
  });
  return {
    ...seed,
    store,
    reads: () => reads,
    revoke: () => {
      revoked = true;
    },
  };
});
