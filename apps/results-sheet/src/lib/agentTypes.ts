export type AgentConnectionStatus = "connected" | "disconnected" | "configuring";

export type AgentModel = {
  key: string;
  name: string;
  provider: string;
  available: boolean;
  isDefault: boolean;
};

export type AgentMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};
