export type AgentConnectionStatus = "connected" | "disconnected" | "configuring";

export type AgentConfig = {
  agentUrl: string;
  token: string;
};

export type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};
