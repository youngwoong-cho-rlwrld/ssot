import assert from "node:assert/strict";
import { appendFile, mkdtemp, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readNewJsonlLines } from "./jsonlTail.mjs";

test("does not advance past a partial JSONL record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jsonl-tail-"));
  const file = path.join(directory, "transcript.jsonl");
  await writeFile(file, "old\n");
  const cursors = new Map([[file, 4]]);

  await appendFile(file, '{"message":"hel');
  let chunks = await readNewJsonlLines([{ file, size: (await stat(file)).size }], cursors);
  assert.deepEqual(chunks, []);
  assert.equal(cursors.get(file), 4);

  await appendFile(file, 'lo"}\n{"next":');
  chunks = await readNewJsonlLines([{ file, size: (await stat(file)).size }], cursors);
  assert.deepEqual(chunks, [{ file, lines: ['{"message":"hello"}'] }]);
  assert.equal(cursors.get(file), 24);

  await appendFile(file, "true}\n");
  chunks = await readNewJsonlLines([{ file, size: (await stat(file)).size }], cursors);
  assert.deepEqual(chunks, [{ file, lines: ['{"next":true}'] }]);
});

test("recovers when a transcript is truncated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jsonl-tail-"));
  const file = path.join(directory, "transcript.jsonl");
  await writeFile(file, "first\nsecond\n");
  const cursors = new Map([[file, 13]]);

  await truncate(file, 0);
  await writeFile(file, "replacement\n");
  const chunks = await readNewJsonlLines([{ file, size: 12 }], cursors);

  assert.deepEqual(chunks, [{ file, lines: ["replacement"] }]);
  assert.equal(cursors.get(file), 12);
});
