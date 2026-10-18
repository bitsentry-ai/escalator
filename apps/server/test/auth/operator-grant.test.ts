import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOperatorGrant } from "../../src/platform/auth/operator-grant.js";
import { tokenDigest } from "../../src/platform/auth/credentials.js";
test("operator grants use exclusive private files and persist only a digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escalator-auth-"));
  const file = join(dir, "grant");
  try {
    let digest = "";
    await writeOperatorGrant(file, async (value) => {
      digest = value;
    });
    const raw = (await readFile(file, "utf8")).trim();
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(tokenDigest(raw), digest);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(
      writeOperatorGrant(file, async () =>
        assert.fail("existing file must not issue a new grant"),
      ),
    );
    assert.equal((await readFile(file, "utf8")).trim(), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("failed grant persistence removes the newly created file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escalator-auth-"));
  const file = join(dir, "grant");
  try {
    await assert.rejects(
      writeOperatorGrant(file, async () => {
        throw new Error("storage unavailable");
      }),
    );
    await assert.rejects(stat(file), { code: "ENOENT" });
    await assert.rejects(
      writeOperatorGrant("relative", async () => assert.fail("invalid path")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
