/**
 * A2A (Agent-to-Agent) Protocol v1.0 types
 * Based on https://google.github.io/A2A/specification/
 */

// -- Roles & States --

export type Role = "ROLE_UNSPECIFIED" | "ROLE_USER" | "ROLE_AGENT";

export type TaskState =
  | "TASK_STATE_UNSPECIFIED"
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_REJECTED"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED";

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

// -- Parts (content units) --

export type Part = {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
};

// -- Messages --

export type Message = {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
};

// -- Tasks --

export type TaskStatus = {
  state: TaskState;
  message?: Message;
  timestamp?: string;
};

export type Artifact = {
  artifactId: string;
  name: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
};

export type Task = {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
};

// -- Agent Card --

export type AgentInterface = {
  url: string;
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON";
  protocolVersion: string;
  tenant?: string;
};

export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
};

export type AgentCapabilities = {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: unknown[];
  extendedAgentCard?: boolean;
};

export type AgentCard = {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  version: string;
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  provider?: { organization: string; url?: string };
  documentationUrl?: string;
  iconUrl?: string;
};

// -- Request/Response --

export type SendMessageConfiguration = {
  acceptedOutputModes?: string[];
  historyLength?: number;
  returnImmediately?: boolean;
};

export type SendMessageRequest = {
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: Record<string, unknown>;
};

export type SendMessageResponse = {
  task?: Task;
  message?: Message;
};

// -- Streaming Events --

export type TaskStatusUpdateEvent = {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
};

export type TaskArtifactUpdateEvent = {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
};

// -- JSON-RPC envelope --

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};
