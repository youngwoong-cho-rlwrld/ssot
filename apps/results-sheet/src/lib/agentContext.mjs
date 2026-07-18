import { promises as fs } from "node:fs";
import path from "node:path";

const REQUEST_ID_PATTERN = /^rsv-\d+-[a-z0-9-]+$/i;
const REQUEST_FILE_PATTERN = /^rsv-\d+-[a-z0-9-]+\.json$/i;

export function requestContextFile(directory, requestId) {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error(`invalid agent request id: ${requestId}`);
  }
  return path.join(directory, `${requestId}.json`);
}

export async function writeRequestContext(directory, payload) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // mkdir does not tighten an existing legacy directory.
  await fs.chmod(directory, 0o700);
  const file = requestContextFile(directory, payload.requestId);
  await fs.writeFile(file, `${JSON.stringify(payload)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return file;
}

export async function removeRequestContext(directory, requestId, file) {
  const expected = path.resolve(requestContextFile(directory, requestId));
  const candidate = path.resolve(file);
  if (candidate !== expected) {
    throw new Error(`refusing to remove unexpected context file ${candidate}`);
  }

  try {
    await fs.unlink(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function scavengeStaleRequestContexts(
  directory,
  maxAgeMs,
  nowMs = Date.now(),
) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  await fs.chmod(directory, 0o700);

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !REQUEST_FILE_PATTERN.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    let metadata;
    try {
      metadata = await fs.stat(file);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (nowMs - metadata.mtimeMs < maxAgeMs) continue;
    try {
      await fs.unlink(file);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}
