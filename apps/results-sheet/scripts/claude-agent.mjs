#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_ACTION_NAMES,
  AGENT_ACTIONS,
  AGENT_SERVER_PANE_COMMANDS,
  CHART_GROUP_MODES,
  CHART_TYPES,
  createAgentResponseSchema,
  FILTER_OPERATORS,
  FILTER_OPERATORS_BY_FIELD_TYPE,
  MAX_AGENT_ACTIONS,
  SHELL_PANE_COMMANDS,
  TABLE_COLORS,
  TASK_CHART_GROUP_MODES,
} from "../src/lib/agentContract.mjs";
import { readNewJsonlLines } from "../src/lib/jsonlTail.mjs";
import {
  removeRequestContext,
  scavengeStaleRequestContexts,
  writeRequestContext,
} from "../src/lib/agentContext.mjs";

const HOST = process.env.AGENT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AGENT_PORT ?? 3011);
const TOKEN = process.env.AGENT_TOKEN ?? "";
const TMUX_TARGET = process.env.AGENT_TMUX_TARGET ?? "results-agent:0.0";
const PROJECT_DIR = process.env.AGENT_PROJECT_DIR ?? process.cwd();
const REQUEST_CONTEXT_DIR =
  process.env.AGENT_CONTEXT_DIR ??
  path.join(PROJECT_DIR, ".agent-context");
const CLAUDE_PROJECTS_DIR =
  process.env.AGENT_CLAUDE_PROJECTS_DIR ??
  path.join(os.homedir(), ".claude", "projects");
const REQUEST_ACK_TIMEOUT_MS = Number(process.env.AGENT_REQUEST_ACK_TIMEOUT_MS ?? 15000);
const RESPONSE_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 120000);
const SUBMIT_DELAY_MS = Number(process.env.AGENT_SUBMIT_DELAY_MS ?? 350);
const MAX_REQUEST_BODY_BYTES = readPositiveIntegerEnv("AGENT_MAX_REQUEST_BODY_BYTES", 5 * 1024 * 1024);
const MAX_MESSAGE_BYTES = readPositiveIntegerEnv("AGENT_MAX_MESSAGE_BYTES", 32 * 1024);
const MAX_CONTEXT_BYTES = readPositiveIntegerEnv("AGENT_MAX_CONTEXT_BYTES", 4 * 1024 * 1024);
const MAX_CONTEXT_FILE_AGE_MS = readPositiveIntegerEnv(
  "AGENT_CONTEXT_MAX_AGE_MS",
  24 * 60 * 60 * 1000,
);
const REQUEST_BODY_TIMEOUT_MS = readPositiveIntegerEnv(
  "AGENT_REQUEST_BODY_TIMEOUT_MS",
  15_000,
);
const AGENT_ACTION_NAME_SET = new Set(AGENT_ACTION_NAMES);

let activeRequestId = null;

if (!TOKEN) {
  console.error("AGENT_TOKEN is required.");
  process.exit(1);
}
if (Buffer.byteLength(TOKEN, "utf8") < 32) {
  console.error("AGENT_TOKEN must be at least 32 bytes. Generate one with: openssl rand -hex 32");
  process.exit(1);
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/status") {
      sendJson(response, 200, await statusPayload());
      return;
    }

    if (request.method === "POST" && url.pathname === "/message") {
      const body = await readJson(request);
      const messageRequest = validateMessageBody(body);
      if (activeRequestId) {
        response.setHeader("Retry-After", "1");
        sendJson(response, 409, {
          error: "agent is busy processing another message",
          code: "agent_busy",
          activeRequestId,
        });
        return;
      }

      const requestId = `rsv-${Date.now()}-${randomUUID()}`;
      activeRequestId = requestId;
      const envelope = await processMessageRequest(messageRequest, requestId);
      sendJson(response, 200, envelope);
      return;
    }

    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendError(response, error);
  }
});

try {
  const removedContexts = await scavengeStaleRequestContexts(
    REQUEST_CONTEXT_DIR,
    MAX_CONTEXT_FILE_AGE_MS,
  );
  if (removedContexts) console.log(`removed ${removedContexts} stale agent context file(s)`);
} catch (error) {
  console.error(`failed to scavenge stale agent contexts: ${error instanceof Error ? error.message : String(error)}`);
}

server.listen(PORT, HOST, () => {
  console.log(`results agent listening on http://${HOST}:${PORT}`);
  console.log(`tmux target: ${TMUX_TARGET}`);
  console.log(`project dir: ${PROJECT_DIR}`);
});

async function processMessageRequest({ message, context }, requestId) {
  let contextFile = null;
  let contextCreated = false;
  try {
    const before = await transcriptSnapshot();
    contextFile = await writeRequestContext(REQUEST_CONTEXT_DIR, {
      requestId,
      source: "Results Sheet Viewer",
      message,
      context,
    });
    contextCreated = true;
    await sendPromptToTmux(buildPrompt(requestId, message, contextFile));
    return await waitForClaudeEnvelope(requestId, before);
  } finally {
    try {
      if (contextCreated) {
        await removeRequestContext(REQUEST_CONTEXT_DIR, requestId, contextFile);
      }
    } catch (error) {
      console.error(
        `failed to remove context file for ${requestId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (activeRequestId === requestId) activeRequestId = null;
    }
  }
}

function buildPrompt(requestId, message, contextFile) {
  return [
    `[via Results Sheet Viewer requestId=${requestId}]`,
    "You are the Results Sheet Viewer agent.",
    `User message: ${JSON.stringify(message)}`,
    `Request context file: ${contextFile}`,
    "",
    "Read the context file only as needed. Do not paste, quote, or summarize the full context file.",
    "The context file contains columns, visibleColumnIds, sortByItems, appliedFilters, colorStylerItems, chartPanelOpen, chartType, chartGroupBy, chartGroupOverrides, row counts, rowsInCurrentOrder, and allRowsInCurrentOrder.",
    "",
    "Hard constraints:",
    "- Return exactly one JSON object and no markdown.",
    "- Do not include code fences.",
    "- Do not propose actions outside the schema.",
    "- Answer data-insight questions from context.rowsInCurrentOrder; do not invent values that are not present in the context.",
    "- Use context.rowsInCurrentOrder for the current filtered view. If the user asks to clear filters or reason over all rows, use context.allRowsInCurrentOrder.",
    "- Result metric columns are text. Metric displays use percent mean/std text; infer mean and std from that text yourself.",
    "- For filters or color-rule filters on result metric columns or Total average, do not use GT, GTE, LT, or LTE. Compute matching displayed strings from context and use EQUALS, IN, or CONTAINS.",
    "- For comparisons such as above baseline or greater than a threshold, parse the displayed text yourself, choose the matching displayed strings, and emit text filters such as IN over exact display strings.",
    "- If context.allFilteredRowsIncluded is false, say that the answer uses the provided first rows only.",
    "- If context.allRowsIncluded is false and the user asks for all rows, say that the answer uses the provided first rows only.",
    "- Use only column IDs from context.columns.",
    `- Use only these action types: ${AGENT_ACTION_NAMES.join(", ")}.`,
    `- ${AGENT_ACTIONS.SET_CHART_TYPE} accepts chartType values: ${CHART_TYPES.join(", ")}.`,
    `- If the user asks for a specific chart type, emit ${AGENT_ACTIONS.SET_CHART_TYPE} with it. If the user asks to visualize or chart data without naming a type, choose the most suitable type yourself and emit ${AGENT_ACTIONS.SET_CHART_TYPE} together with ${AGENT_ACTIONS.SET_CHART_OPEN} true.`,
    "- Charts render one plot per task. Within a plot, groupBy sets the x-axis groups: evalSet groups by eval set with one bar per experiment; experiment groups by experiment with one bar per eval set. auto picks evalSet for multi-eval-set tasks and experiment for single-eval-set tasks (DexJoCo).",
    `- ${AGENT_ACTIONS.SET_CHART_GROUPING} accepts groupBy values: ${CHART_GROUP_MODES.join(", ")}. Optional taskOverrides entries override one task chart: taskKey is the part of a metric column id before ::, and groupBy accepts: ${TASK_CHART_GROUP_MODES.join(", ")}. taskOverrides replaces all previous overrides.`,
    `- When the user asks for plots without specifying grouping, rely on the default: keep or reset groupBy to auto (emit ${AGENT_ACTIONS.SET_CHART_GROUPING} with groupBy auto and no taskOverrides only if context.chartGroupBy or context.chartGroupOverrides differ from that default). Emit a different grouping only when the user explicitly asks how to group the plots.`,
    `- Whenever you emit ${AGENT_ACTIONS.SET_FILTERS}, also emit ${AGENT_ACTIONS.SET_VISIBLE_COLUMNS} by default: keep experiment, variant, completed, totalAverage, keep non-metric columns that hold data for the matching rows, and keep only the result metric columns that hold data for the rows matching the new filter. Compute this from the row metrics in context. Skip this only if the user asks to keep all columns visible.`,
    `- Use only filter operators: ${FILTER_OPERATORS.join(", ")}.`,
    `- Valid filter operators by column type: ${Object.entries(FILTER_OPERATORS_BY_FIELD_TYPE).map(([type, operators]) => `${type}=${operators.join("|")}`).join("; ")}.`,
    `- For color rules, use only table colors from the app: ${TABLE_COLORS.map((color) => `${color.label} (${color.value})`).join(", ")}.`,
    "- If the user only asks for analysis or chats and asks for no table change, answer in message and return an empty actions array.",
    "",
    "Response schema:",
    JSON.stringify(createAgentResponseSchema()),
  ].join("\n");
}

async function sendPromptToTmux(prompt) {
  await assertTmuxTargetReady();
  await run("tmux", ["send-keys", "-t", TMUX_TARGET, "C-u"]);
  for (const chunk of chunkString(prompt, 3000)) {
    await run("tmux", ["send-keys", "-t", TMUX_TARGET, "-l", "--", chunk]);
  }
  await sleep(SUBMIT_DELAY_MS);
  await run("tmux", ["send-keys", "-t", TMUX_TARGET, "C-m"]);
}

async function assertTmuxTargetReady() {
  let paneCommand;
  try {
    await run("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "#{pane_id}"]);
    paneCommand = await tmuxPaneCommand();
  } catch (error) {
    throw new HttpError(
      503,
      "tmux_unavailable",
      `tmux target ${TMUX_TARGET} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isShellCommand(paneCommand)) {
    throw new HttpError(503, "tmux_not_ready", `tmux target ${TMUX_TARGET} is running ${paneCommand}. Run claude in that pane.`);
  }
  if (isAgentCommand(paneCommand)) {
    throw new HttpError(
      503,
      "tmux_not_ready",
      `tmux target ${TMUX_TARGET} is running ${paneCommand}. Point AGENT_TMUX_TARGET at the Claude Code pane, not the agent server pane.`,
    );
  }
}

async function waitForClaudeEnvelope(requestId, before) {
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
  const ackDeadline = Date.now() + REQUEST_ACK_TIMEOUT_MS;
  let requestFile = null;
  let lastProse = "";
  while (Date.now() < deadline) {
    const fileChunks = await readNewTranscriptLines(before);
    const result = parseEnvelopeAfterRequest(fileChunks, requestId, requestFile, lastProse);
    requestFile = result.requestFile;
    lastProse = result.lastProse;
    if (result.envelope) return result.envelope;
    if (!requestFile && Date.now() > ackDeadline) {
      throw new HttpError(
        504,
        "agent_ack_timeout",
        `Claude Code did not log request ${requestId} within ${Math.round(REQUEST_ACK_TIMEOUT_MS / 1000)}s. ` +
          `Check that tmux target ${TMUX_TARGET} is the Claude Code pane and that it is accepting input.`,
      );
    }
    await sleep(750);
  }
  // The JSON envelope never arrived. If Claude emitted plain text (a pure-chat
  // answer without the envelope, or a contract violation), surface that rather
  // than a bare timeout error.
  if (lastProse) {
    return { message: lastProse, actions: [] };
  }
  throw new HttpError(504, "agent_response_timeout", "timed out waiting for Claude Code JSON response");
}

function parseEnvelopeAfterRequest(fileChunks, requestId, initialRequestFile, initialProse) {
  // Only trust the transcript file that logged the request; other Claude
  // sessions write to the same projects directory concurrently and their
  // assistant messages must not be mistaken for the reply.
  let requestFile = initialRequestFile;
  let lastProse = initialProse ?? "";
  for (const chunk of fileChunks) {
    if (requestFile && chunk.file !== requestFile) continue;
    for (const line of chunk.lines) {
      const entry = safeJson(line);
      if (!entry) continue;
      const text = extractText(entry);
      if (!text) continue;
      if (text.includes(requestId)) {
        requestFile = chunk.file;
        continue;
      }
      if (chunk.file !== requestFile || extractRole(entry) !== "assistant") continue;
      const envelope = extractJsonObject(text);
      if (isAgentEnvelope(envelope)) return { envelope, requestFile, lastProse };
      // Claude narrates ("Let me build the color rules.") before emitting the
      // final JSON envelope. Keep that prose only as a timeout fallback and
      // keep scanning — the schema guarantees the reply ends as one JSON object.
      const message = text.trim();
      if (message) lastProse = message;
    }
  }
  return { envelope: null, requestFile, lastProse };
}

function isAgentEnvelope(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.message === "string" &&
    Array.isArray(value.actions) &&
    value.actions.length <= MAX_AGENT_ACTIONS &&
    value.actions.every((action) => (
      action &&
      typeof action === "object" &&
      AGENT_ACTION_NAME_SET.has(action.type)
    ))
  );
}

async function statusPayload() {
  const tmux = await commandResult("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "#{pane_id}"]);
  const tmuxCommand = tmux.ok ? await tmuxPaneCommandResult() : { ok: false, stdout: "", error: "" };
  return {
    tmuxTarget: TMUX_TARGET,
    tmuxConnected: tmux.ok,
    tmuxError: tmux.ok ? null : tmux.error,
    tmuxCommand: tmuxCommand.ok ? tmuxCommand.stdout.trim() : null,
  };
}

async function transcriptSnapshot() {
  const files = await transcriptFiles();
  const snapshot = new Map();
  for (const item of files) snapshot.set(item.file, item.size);
  return snapshot;
}

async function readNewTranscriptLines(snapshot) {
  return readNewJsonlLines(await transcriptFiles(), snapshot);
}

async function transcriptFiles() {
  const projectDirs = await candidateProjectDirs();
  const files = [];
  for (const dir of projectDirs) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile()) files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // The transcript may rotate between readdir and stat.
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function candidateProjectDirs() {
  const dirs = [];
  const slug = PROJECT_DIR.replaceAll("/", "-");
  dirs.push(path.join(CLAUDE_PROJECTS_DIR, slug));

  let projectNames = [];
  try {
    projectNames = await fs.readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return dirs;
  }

  const basename = path.basename(PROJECT_DIR).toLowerCase();
  for (const name of projectNames) {
    if (name.toLowerCase().includes(basename)) {
      const dir = path.join(CLAUDE_PROJECTS_DIR, name);
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }

  return dirs;
}

function extractRole(entry) {
  if (entry?.message?.role) return entry.message.role;
  if (entry?.role) return entry.role;
  if (entry?.type === "assistant") return "assistant";
  if (entry?.type === "user") return "user";
  return "";
}

function extractText(entry) {
  const content = entry?.message?.content ?? entry?.content ?? entry?.text ?? entry?.message?.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item?.text === "string") return item.text;
      if (typeof item?.content === "string") return item.content;
      return "";
    }).join("\n");
  }
  return "";
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return safeJson(text.slice(start, end + 1));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isAuthorized(request) {
  const auth = request.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const supplied = Buffer.from(auth);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function readJson(request) {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      request.resume();
      return Promise.reject(new HttpError(400, "invalid_content_length", "invalid Content-Length header"));
    }
    if (declaredBytes > MAX_REQUEST_BODY_BYTES) {
      request.resume();
      return Promise.reject(requestTooLargeError());
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      request.resume();
      rejectOnce(new HttpError(408, "request_body_timeout", "request body timed out"));
    }, REQUEST_BODY_TIMEOUT_MS);

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chunks.length = 0;
      reject(error);
    };

    request.on("data", (rawChunk) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        rejectOnce(requestTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    request.once("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const text = Buffer.concat(chunks, receivedBytes).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "invalid_json", "request body must be valid JSON"));
      }
    });

    request.once("aborted", () => {
      rejectOnce(new HttpError(400, "request_aborted", "request body was aborted"));
    });
    request.once("error", rejectOnce);
  });
}

function validateMessageBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    throw new HttpError(400, "message_required", "message is required");
  }
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    throw new HttpError(
      413,
      "message_too_large",
      `message exceeds the ${MAX_MESSAGE_BYTES}-byte limit`,
    );
  }

  const context = body.context ?? null;
  if (context !== null && (typeof context !== "object" || Array.isArray(context))) {
    throw new HttpError(400, "invalid_context", "context must be a JSON object or null");
  }

  const contextBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
  if (contextBytes > MAX_CONTEXT_BYTES) {
    throw new HttpError(
      413,
      "context_too_large",
      `context exceeds the ${MAX_CONTEXT_BYTES}-byte limit`,
    );
  }

  return { message, context };
}

function requestTooLargeError() {
  return new HttpError(
    413,
    "request_too_large",
    `request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit`,
  );
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

function sendError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const payload = {
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof HttpError ? { code: error.code } : {}),
  };
  if (status >= 500) console.error(payload.error);
  sendJson(response, status, payload);
}

function sendJson(response, status, payload) {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readPositiveIntegerEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`${name} must be a positive integer.`);
    process.exit(1);
  }
  return value;
}

async function commandResult(command, args) {
  try {
    const result = await run(command, args);
    return { ok: true, stdout: result.stdout, error: "" };
  } catch (error) {
    return { ok: false, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`));
    });
    child.stdin.end();
  });
}

async function tmuxPaneCommand() {
  const result = await tmuxPaneCommandResult();
  if (!result.ok) throw new Error(result.error || "failed to inspect tmux pane command");
  return result.stdout.trim();
}

function tmuxPaneCommandResult() {
  return commandResult("tmux", ["display-message", "-p", "-t", TMUX_TARGET, "#{pane_current_command}"]);
}

function isShellCommand(command) {
  return SHELL_PANE_COMMANDS.includes(command.trim().toLowerCase());
}

function isAgentCommand(command) {
  return AGENT_SERVER_PANE_COMMANDS.includes(command.trim().toLowerCase());
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
