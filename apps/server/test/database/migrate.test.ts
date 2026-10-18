import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { migrate } from "../../src/platform/database/migrate.js";
function fixture(
  applied: { name: string; checksum: string }[] = [],
  failSql?: string,
) {
  const commands: string[] = [];
  let released = false;
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        commands.push(sql);
        if (sql === failSql) throw new Error("Simulated DDL failure");
        return { rows: sql.startsWith("SELECT name, checksum") ? applied : [] };
      },
      release: () => {
        released = true;
      },
    }),
  } as unknown as Pool;
  return { pool, commands, released: () => released };
}
const first = {
  name: "0001_foundations.sql",
  sql: "CREATE TABLE fixture (id text)",
};
test("new migration commits DDL and journal together, then releases the connection", async () => {
  const f = fixture();
  await migrate(f.pool, [first]);
  assert.equal(f.commands[0], "BEGIN");
  assert.ok(
    f.commands.indexOf(first.sql) <
      f.commands.findIndex((s) =>
        s.startsWith("INSERT INTO escalator_migration"),
      ),
  );
  assert.equal(f.commands.at(-1), "COMMIT");
  assert.equal(f.released(), true);
});
test("identical applied migration is not executed again", async () => {
  const f = fixture([
    {
      name: first.name,
      checksum: createHash("sha256").update(first.sql).digest("hex"),
    },
  ]);
  await migrate(f.pool, [first]);
  assert.equal(f.commands.includes(first.sql), false);
  assert.equal(
    f.commands.some((s) => s.startsWith("INSERT INTO escalator_migration")),
    false,
  );
  assert.equal(f.commands.at(-1), "COMMIT");
});
test("modified or removed history fails before new DDL and rolls back", async () => {
  for (const migrations of [[], [first]]) {
    const f = fixture([{ name: first.name, checksum: "wrong-checksum" }]);
    await assert.rejects(migrate(f.pool, migrations), /history differs/);
    assert.equal(f.commands.includes(first.sql), false);
    assert.equal(f.commands.at(-1), "ROLLBACK");
    assert.equal(f.released(), true);
  }
});
test("DDL failure rolls back without adding its journal entry", async () => {
  const f = fixture([], first.sql);
  await assert.rejects(migrate(f.pool, [first]), /Simulated DDL failure/);
  assert.equal(
    f.commands.some((s) => s.startsWith("INSERT INTO escalator_migration")),
    false,
  );
  assert.equal(f.commands.at(-1), "ROLLBACK");
  assert.equal(f.released(), true);
});
test("duplicate migration names fail before connecting", async () => {
  const f = fixture();
  await assert.rejects(migrate(f.pool, [first, first]), /unique ascending/);
  assert.deepEqual(f.commands, []);
});
