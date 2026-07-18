import { open } from "node:fs/promises";

/**
 * Reads only complete newline-terminated records and advances each cursor to
 * the last consumed newline. An in-progress JSONL write is intentionally
 * re-read on the next poll so partial JSON and UTF-8 sequences cannot be lost.
 *
 * @param {Array<{file: string, size: number}>} files
 * @param {Map<string, number>} cursors
 */
export async function readNewJsonlLines(files, cursors) {
  const chunks = [];
  for (const item of files) {
    const previous = cursors.get(item.file) ?? 0;
    const start = previous <= item.size ? previous : 0;
    if (item.size <= start) continue;

    const handle = await open(item.file, "r");
    try {
      const buffer = Buffer.alloc(item.size - start);
      const bytesRead = await readFully(handle, buffer, start);
      const completeEnd = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (completeEnd < 0) continue;

      const complete = buffer.subarray(0, completeEnd + 1).toString("utf8");
      chunks.push({
        file: item.file,
        lines: complete.split(/\r?\n/).filter(Boolean),
      });
      cursors.set(item.file, start + completeEnd + 1);
    } finally {
      await handle.close();
    }
  }
  return chunks;
}

async function readFully(handle, buffer, position) {
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      position + total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}
