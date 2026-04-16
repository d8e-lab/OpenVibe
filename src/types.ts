export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AgentLogEntry {
  at: number;
  /** e.g. "codeEditReview", "shellEditor", "shellReview", "todolistReview", "todolistWriter" */
  agent: string;
  /** Free-form stage label like "request" | "response" | "error" */
  stage: string;
  /** Sanitized payload for debugging; keep it JSON-serializable. */
  data: any;
}

export interface GitSnapshot {
  id: string;
  timestamp: number;
  userInstruction: string;
  gitCommitHash?: string;
  gitTag?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
  snapshots?: GitSnapshot[];
  agentLogs?: AgentLogEntry[];
  isActive?: boolean;
}

export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Ask before applying **edit** tool (file changes). */
  confirmChanges?: boolean;
  /** Ask before running **run_shell_command** after review (independent from confirmChanges). */
  confirmShellCommand?: boolean;
  maxInteractions?: number; // -1 means unlimited
  maxSequenceLength?: number;
}
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}