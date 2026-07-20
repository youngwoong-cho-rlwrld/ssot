export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { buildResultsAgentPrompt } from "../../../../lib/agentPrompt.mjs";
import {
  removeRequestContext,
  writeRequestContext,
} from "../../../../lib/agentContext.mjs";
import {
  fetchOpenClawJson,
  openClawApiUrl,
  OPENCLAW_CHAT_TIMEOUT_MS,
} from "../../../../lib/openclawUpstream.ts";
import { requireSsotUser } from "../../../../lib/ssotAuth.ts";
import path from "node:path";

const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const SAFE_SESSION_KEY = /^agent:main:ssot-results-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MessageRequest = {
  message: string;
  context: Record<string, unknown> | null;
  model: string | null;
  sessionKey: string;
};

export async function POST(request: Request) {
  const unauthorized = requireSsotUser(request);
  if (unauthorized) return unauthorized;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }

  const parsed = parseMessageRequest(input);
  if (typeof parsed === "string") return badRequest(parsed);

  const requestId = `rsv-${Date.now()}-${crypto.randomUUID()}`;
  const contextDirectory = resultsAgentContextDirectory();
  let contextFile: string | null = null;

  try {
    contextFile = await writeRequestContext(contextDirectory, {
      requestId,
      source: "Results Sheet Viewer",
      message: parsed.message,
      context: parsed.context,
    });
    const prompt = buildResultsAgentPrompt({ requestId, message: parsed.message, contextFile });
    let sessionKey = parsed.sessionKey;
    let payload: unknown;
    try {
      payload = await sendOpenClawMessage(prompt, sessionKey, parsed.model, request.signal);
    } catch (error) {
      if (!isTranscriptCompactionFailure(error)) throw error;
      sessionKey = `agent:main:ssot-results-${crypto.randomUUID()}`;
      payload = await sendOpenClawMessage(prompt, sessionKey, parsed.model, request.signal);
    }
    return Response.json({ ...agentEnvelope(payload), sessionKey });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  } finally {
    if (contextFile) {
      try {
        await removeRequestContext(contextDirectory, requestId, contextFile);
      } catch (error) {
        console.error(`Failed to remove Results agent context: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function sendOpenClawMessage(
  prompt: string,
  sessionKey: string,
  model: string | null,
  signal: AbortSignal,
) {
  return fetchOpenClawJson<unknown>(
    openClawApiUrl("/api/chat"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: prompt,
        session_key: sessionKey,
        ...(model ? { model } : {}),
      }),
      signal,
    },
    OPENCLAW_CHAT_TIMEOUT_MS,
  );
}

function isTranscriptCompactionFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("transcript compaction failed");
}

function resultsAgentContextDirectory() {
  return process.env.RESULTS_AGENT_CONTEXT_DIR ?? path.join(process.cwd(), ".agent-context");
}

function parseMessageRequest(input: unknown): MessageRequest | string {
  if (!isRecord(input)) return "Request body must be a JSON object.";

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) return "Message is required.";
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    return `Message exceeds the ${MAX_MESSAGE_BYTES}-byte limit.`;
  }

  const context = input.context == null ? null : input.context;
  if (context !== null && !isRecord(context)) return "Context must be a JSON object or null.";
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_CONTEXT_BYTES) {
    return `Context exceeds the ${MAX_CONTEXT_BYTES}-byte limit.`;
  }

  const model = typeof input.model === "string" ? input.model.trim() : null;
  if (model && model.length > 512) return "Model is too long.";

  const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
  if (!SAFE_SESSION_KEY.test(sessionKey)) return "Session key is invalid.";

  return { message, context, model: model || null, sessionKey };
}

function agentEnvelope(payload: unknown) {
  const reply = assistantReply(payload);
  const parsed = extractJsonObject(reply);
  if (isRecord(parsed) && typeof parsed.message === "string" && Array.isArray(parsed.actions)) {
    return parsed;
  }
  return {
    message: reply || "OpenClaw returned no visible reply.",
    actions: [],
  };
}

function assistantReply(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.result)) return "";
  const result = payload.result;
  const texts = Array.isArray(result.payloads)
    ? result.payloads.flatMap((item) => (
        isRecord(item) && typeof item.text === "string" && item.text.trim()
          ? [item.text.trim()]
          : []
      ))
    : [];
  if (texts.length) return texts.join("\n");
  return isRecord(result.meta) && typeof result.meta.finalAssistantVisibleText === "string"
    ? result.meta.finalAssistantVisibleText.trim()
    : "";
}

function extractJsonObject(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      return null;
    }
  }
}

function badRequest(error: string) {
  return Response.json({ error }, { status: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
