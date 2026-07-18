import { useCallback, useEffect, useRef, useState } from "react";
import { validateAgentEnvelope, type AgentAction } from "@/lib/agentActions";
import {
  AGENT_SERVER_PANE_COMMANDS,
  SHELL_PANE_COMMANDS,
} from "@/lib/agentContract.mjs";
import { makeId } from "@/lib/id";
import type { AgentConfig, AgentConnectionStatus, AgentMessage } from "@/lib/agentTypes";
import type { Field } from "@enmight/types/apiTypes";

const AGENT_CONFIG_STORAGE_KEY = "results-sheet-viewer-agent-config";
const STATUS_POLL_MS = 5_000;
const STATUS_TIMEOUT_MS = 8_000;
const MESSAGE_TIMEOUT_MS = 130_000;

type UseResultsAgentProps = {
  context: unknown;
  columns: Field[];
  applyActions: (actions: AgentAction[]) => void;
};

export function useResultsAgent({ context, columns, applyActions }: UseResultsAgentProps) {
  const [configOpen, setConfigOpen] = useState(false);
  const [status, setStatus] = useState<AgentConnectionStatus>("configuring");
  const [statusDetail, setStatusDetail] = useState("");
  const [config, setConfig] = useState<AgentConfig>(() => ({ agentUrl: defaultAgentUrl(), token: "" }));
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [pending, setPending] = useState(false);
  const statusControllerRef = useRef<AbortController | null>(null);
  const statusRequestIdRef = useRef(0);
  const pendingRef = useRef(false);

  useEffect(() => {
    setConfig(readAgentConfig());
  }, []);

  const cancelStatusRequest = useCallback(() => {
    statusRequestIdRef.current += 1;
    statusControllerRef.current?.abort();
    statusControllerRef.current = null;
  }, []);

  const checkStatus = useCallback(async (nextConfig: AgentConfig) => {
    if (pendingRef.current) return;
    cancelStatusRequest();
    if (!nextConfig.agentUrl || !nextConfig.token) {
      setStatus("disconnected");
      setStatusDetail("Agent URL and token are required.");
      return;
    }

    const requestId = statusRequestIdRef.current;
    const controller = new AbortController();
    statusControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    setStatus((current) => current === "connected" ? current : "configuring");
    setStatusDetail("Checking agent connection...");
    try {
      const response = await fetch(agentEndpoint(nextConfig.agentUrl, "/status"), {
        headers: agentAuthHeaders(nextConfig.token),
        signal: controller.signal,
      });
      const payload = await readJsonRecord(response);
      if (requestId !== statusRequestIdRef.current) return;
      if (!response.ok) {
        setStatus("disconnected");
        setStatusDetail(statusErrorMessage(response.status, payload.error));
      } else if (payload.tmuxConnected !== true) {
        setStatus("configuring");
        setStatusDetail(typeof payload.tmuxError === "string"
          ? `tmux is not ready: ${payload.tmuxError}`
          : `tmux target ${stringValue(payload.tmuxTarget, "results-agent:0.0")} was not found.`);
      } else if (isShellPaneCommand(payload.tmuxCommand)) {
        setStatus("configuring");
        setStatusDetail(`tmux target ${stringValue(payload.tmuxTarget, "unknown")} is running ${payload.tmuxCommand}. Run claude in that pane.`);
      } else if (isAgentPaneCommand(payload.tmuxCommand)) {
        setStatus("configuring");
        setStatusDetail(`tmux target ${stringValue(payload.tmuxTarget, "unknown")} points at the agent server. Point AGENT_TMUX_TARGET at the Claude Code pane.`);
      } else {
        setStatus("connected");
        setStatusDetail(`Connected to tmux target ${stringValue(payload.tmuxTarget, "results-agent:0.0")}.`);
      }
    } catch (error) {
      if (requestId !== statusRequestIdRef.current) return;
      setStatus("disconnected");
      setStatusDetail(controller.signal.aborted
        ? "Agent status check timed out."
        : `Agent unreachable: ${errorMessage(error)}`);
    } finally {
      window.clearTimeout(timeout);
      if (requestId === statusRequestIdRef.current) statusControllerRef.current = null;
    }
  }, [cancelStatusRequest]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      await checkStatus(config);
      if (!stopped) timer = window.setTimeout(poll, STATUS_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      cancelStatusRequest();
    };
  }, [cancelStatusRequest, checkStatus, config]);

  const appendMessage = useCallback((message: Omit<AgentMessage, "id">) => {
    setMessages((current) => [...current, { ...message, id: makeId("message") }]);
  }, []);

  const send = useCallback(async (message: string) => {
    if (pendingRef.current) return;
    appendMessage({ role: "user", text: message });
    if (!config.agentUrl || !config.token) {
      appendMessage({ role: "system", text: "Agent is not configured." });
      setConfigOpen(true);
      return;
    }

    cancelStatusRequest();
    pendingRef.current = true;
    setPending(true);
    setStatus("configuring");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), MESSAGE_TIMEOUT_MS);
    try {
      const response = await fetch(agentEndpoint(config.agentUrl, "/message"), {
        method: "POST",
        headers: { ...agentAuthHeaders(config.token), "Content-Type": "application/json" },
        body: JSON.stringify({ message, context }),
        signal: controller.signal,
      });
      const payload = await readJsonRecord(response);
      if (!response.ok) throw new Error(
        typeof payload.error === "string" ? payload.error : `${response.status} ${response.statusText}`,
      );

      const validation = validateAgentEnvelope(payload, columns);
      if (!validation.envelope) {
        appendMessage({ role: "system", text: `Rejected Claude output: ${validation.errors.join("; ")}` });
      } else {
        applyActions(validation.envelope.actions);
        appendMessage({
          role: "assistant",
          text: validation.envelope.message || `Applied ${validation.envelope.actions.length} action(s).`,
        });
      }
      setStatus("connected");
    } catch (error) {
      const messageText = controller.signal.aborted ? "Agent request timed out." : errorMessage(error);
      appendMessage({ role: "system", text: `Agent error: ${messageText}` });
      setStatus("disconnected");
      setStatusDetail(`Agent request failed: ${messageText}`);
    } finally {
      window.clearTimeout(timeout);
      pendingRef.current = false;
      setPending(false);
    }
  }, [appendMessage, applyActions, cancelStatusRequest, columns, config, context]);

  const saveConfig = useCallback((nextConfig: AgentConfig) => {
    setConfig(nextConfig);
    localStorage.setItem(AGENT_CONFIG_STORAGE_KEY, JSON.stringify(nextConfig));
    setConfigOpen(false);
    setStatus("configuring");
    setStatusDetail("Checking agent connection...");
  }, []);

  return {
    configOpen,
    setConfigOpen,
    status,
    statusDetail,
    config,
    messages,
    pending,
    send,
    saveConfig,
  };
}

function readAgentConfig(): AgentConfig {
  const fallback = { agentUrl: defaultAgentUrl(), token: "" };
  try {
    const parsed = JSON.parse(localStorage.getItem(AGENT_CONFIG_STORAGE_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return fallback;
    const record = parsed as Record<string, unknown>;
    return {
      agentUrl: typeof record.agentUrl === "string" && record.agentUrl ? record.agentUrl : fallback.agentUrl,
      token: typeof record.token === "string" ? record.token : "",
    };
  } catch {
    return fallback;
  }
}

function defaultAgentUrl() {
  if (typeof window === "undefined") return "http://localhost:3011";
  return `http://${window.location.hostname || "localhost"}:3011`;
}

function agentEndpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function agentAuthHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json() as unknown;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function statusErrorMessage(status: number, error: unknown) {
  if (status === 401) return "Agent token is not valid.";
  return typeof error === "string" && error ? `Agent error: ${error}` : `Agent returned HTTP ${status}.`;
}

function isShellPaneCommand(command: unknown) {
  return typeof command === "string"
    && SHELL_PANE_COMMANDS.some((candidate) => candidate === command.trim().toLowerCase());
}

function isAgentPaneCommand(command: unknown) {
  return typeof command === "string"
    && AGENT_SERVER_PANE_COMMANDS.some((candidate) => candidate === command.trim().toLowerCase());
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
