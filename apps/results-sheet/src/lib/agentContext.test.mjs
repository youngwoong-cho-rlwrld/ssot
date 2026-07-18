import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  removeRequestContext,
  scavengeStaleRequestContexts,
  writeRequestContext,
} from "./agentContext.mjs";

test("writes private request contexts and removes only the expected file", async () => {
  const directory = path.join(await mkdtemp(path.join(tmpdir(), "agent-context-")), "contexts");
  const payload = { requestId: "rsv-1234-abcdef", message: "hello", context: { rows: [] } };
  const file = await writeRequestContext(directory, payload);

  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), payload);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(
    removeRequestContext(directory, payload.requestId, path.join(directory, "other.json")),
    /unexpected context file/,
  );
  await removeRequestContext(directory, payload.requestId, file);
  await assert.rejects(stat(file), { code: "ENOENT" });
});

test("scavenges only stale regular request context files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-context-"));
  const stale = path.join(directory, "rsv-1000-deadbeef.json");
  const fresh = path.join(directory, "rsv-2000-cafebabe.json");
  const unrelated = path.join(directory, "notes.json");
  await Promise.all([
    writeFile(stale, "{}"),
    writeFile(fresh, "{}"),
    writeFile(unrelated, "{}"),
  ]);
  await utimes(stale, new Date(1_000), new Date(1_000));
  await utimes(fresh, new Date(9_500), new Date(9_500));

  const removed = await scavengeStaleRequestContexts(directory, 2_000, 10_000);

  assert.equal(removed, 1);
  await assert.rejects(stat(stale), { code: "ENOENT" });
  assert.equal((await stat(fresh)).isFile(), true);
  assert.equal((await stat(unrelated)).isFile(), true);
});
