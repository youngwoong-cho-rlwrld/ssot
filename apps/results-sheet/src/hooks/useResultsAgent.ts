import { useCallback, useEffect, useRef, useState } from "react";
import { validateAgentEnvelope, type AgentAction } from "@/lib/agentActions";
import { apiPath } from "@/lib/basePath";
import { errorMessage, readJsonRecord } from "@/lib/http";
import { makeId } from "@/lib/id";
import type {
  AgentConnectionStatus,
  AgentMessage,
  AgentModel,
} from "@/lib/agentTypes";
import type { Field } from "@enmight/types/apiTypes";

const MODEL_STORAGE_KEY = "results-sheet-openclaw-model";
const STATUS_TIMEOUT_MS = 20_000;
const MESSAGE_TIMEOUT_MS = 150_000;
const RESULTS_SESSION_KEY = /^agent:main:ssot-results-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UseResultsAgentProps = {
  enabled: boolean;
  context: unknown;
  columns: Field[];
  applyActions: (actions: AgentAction[]) => void;
};

export function useResultsAgent({ enabled, context, columns, applyActions }: UseResultsAgentProps) {
  const [status, setStatus] = useState<AgentConnectionStatus>("configuring");
  const [statusDetail, setStatusDetail] = useState("Connecting to OpenClaw...");
  const [models, setModels] = useState<AgentModel[]>([]);
  const [selectedModel, setSelectedModelState] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [pending, setPending] = useState(false);
  const statusControllerRef = useRef<AbortController | null>(null);
  const messageControllerRef = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const sessionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setSelectedModelState(localStorage.getItem(MODEL_STORAGE_KEY)?.trim() ?? "");
  }, []);

  const loadModels = useCallback(async () => {
    if (pendingRef.current) return;
    statusControllerRef.current?.abort();
    const controller = new AbortController();
    statusControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    setStatus((current) => current === "connected" ? current : "configuring");
    try {
      const response = await fetch(apiPath("/api/agent/models"), {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await readJsonRecord(response);
      if (!response.ok) {
        throw new Error(typeof payload.error === "string"
          ? payload.error
          : `${response.status} ${response.statusText}`);
      }

      const nextModels = normalizeModels(payload.models);
      setModels(nextModels);
      setSelectedModelState((current) => {
        if (nextModels.some((model) => model.key === current && model.available)) return current;
        const next = nextModels.find((model) => model.isDefault && model.available)
          ?? nextModels.find((model) => model.available);
        if (next) localStorage.setItem(MODEL_STORAGE_KEY, next.key);
        return next?.key ?? "";
      });
      setStatus("connected");
      setStatusDetail(nextModels.some((model) => model.available)
        ? "Connected to OpenClaw."
        : "OpenClaw has no available chat model.");
    } catch (error) {
      if (controller.signal.aborted) {
        setStatusDetail("OpenClaw connection timed out.");
      } else {
        setStatusDetail(`OpenClaw unavailable: ${errorMessage(error)}`);
      }
      setStatus("disconnected");
      setModels([]);
    } finally {
      window.clearTimeout(timeout);
      if (statusControllerRef.current === controller) statusControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      statusControllerRef.current?.abort();
      messageControllerRef.current?.abort();
      return;
    }
    void loadModels();
    return () => {
      statusControllerRef.current?.abort();
      messageControllerRef.current?.abort();
    };
  }, [enabled, loadModels]);

  const appendMessage = useCallback((message: Omit<AgentMessage, "id">) => {
    setMessages((current) => [...current, { ...message, id: makeId("message") }]);
  }, []);

  const send = useCallback(async (message: string) => {
    if (pendingRef.current) return;
    appendMessage({ role: "user", text: message });
    if (!selectedModel) {
      appendMessage({ role: "system", text: "OpenClaw has no available model." });
      return;
    }

    statusControllerRef.current?.abort();
    pendingRef.current = true;
    setPending(true);
    setStatus("configuring");
    setStatusDetail("OpenClaw is working...");
    const controller = new AbortController();
    messageControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), MESSAGE_TIMEOUT_MS);
    try {
      const response = await fetch(apiPath("/api/agent/message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          context,
          model: selectedModel,
          sessionKey: currentSessionKey(sessionKeyRef),
        }),
        signal: controller.signal,
      });
      const payload = await readJsonRecord(response);
      if (!response.ok) {
        // The server received the request and rejected it: drop the session key
        // so the next send starts a fresh OpenClaw session. Timeouts and network
        // errors (handled in catch) keep the key so the conversation can resume.
        sessionKeyRef.current = null;
        throw new Error(typeof payload.error === "string"
          ? payload.error
          : `${response.status} ${response.statusText}`);
      }

      if (typeof payload.sessionKey === "string" && RESULTS_SESSION_KEY.test(payload.sessionKey)) {
        sessionKeyRef.current = payload.sessionKey;
      }

      const validation = validateAgentEnvelope(payload, columns);
      if (!validation.envelope) {
        appendMessage({
          role: "system",
          text: `Rejected OpenClaw output: ${validation.errors.join("; ")}`,
        });
      } else {
        applyActions(validation.envelope.actions);
        appendMessage({
          role: "assistant",
          text: validation.envelope.message || `Applied ${validation.envelope.actions.length} action(s).`,
        });
      }
      setStatus("connected");
      setStatusDetail("Connected to OpenClaw.");
    } catch (error) {
      const messageText = controller.signal.aborted
        ? "OpenClaw request timed out."
        : errorMessage(error);
      appendMessage({ role: "system", text: `OpenClaw error: ${messageText}` });
      setStatus("disconnected");
      setStatusDetail(`OpenClaw request failed: ${messageText}`);
    } finally {
      window.clearTimeout(timeout);
      if (messageControllerRef.current === controller) {
        messageControllerRef.current = null;
      }
      pendingRef.current = false;
      setPending(false);
    }
  }, [appendMessage, applyActions, columns, context, selectedModel]);

  const setSelectedModel = useCallback((model: string) => {
    if (!models.some((candidate) => candidate.key === model && candidate.available)) return;
    sessionKeyRef.current = null;
    setSelectedModelState(model);
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  }, [models]);

  return {
    status,
    statusDetail,
    models,
    selectedModel,
    setSelectedModel,
    messages,
    pending,
    send,
  };
}

function normalizeModels(input: unknown): AgentModel[] {
  if (!Array.isArray(input)) return [];
  const models: AgentModel[] = [];
  const keys = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key || key.length > 512 || keys.has(key)) continue;
    keys.add(key);
    models.push({
      key,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : key,
      provider: typeof record.provider === "string" ? record.provider.trim() : "",
      available: record.available === true,
      isDefault: record.isDefault === true,
    });
  }
  return models;
}

function currentSessionKey(ref: { current: string | null }) {
  if (ref.current) return ref.current;
  const sessionKey = `agent:main:ssot-results-${crypto.randomUUID()}`;
  ref.current = sessionKey;
  return sessionKey;
}

