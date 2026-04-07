import axios from 'axios';
import { ChatMessage, ApiConfig, ToolDefinition, ToolCall, TokenUsage } from './types';

export interface ApiResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  tokenUsage?: TokenUsage;
}

export async function sendChatMessage(
  messages: ChatMessage[],
  config: ApiConfig,
  tools?: ToolDefinition[],
  signal?: AbortSignal
): Promise<ApiResponse> {
  const url = `${config.baseUrl}/chat/completions`;

  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.7,
    max_tokens: 4000,
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = 'auto';
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      timeout: 120000,
      signal,
    });

    const choice = response.data?.choices?.[0];
    if (!choice) {
      throw new Error('Invalid response from API: missing choices');
    }

    const msg = choice.message;
    const content: string | null = msg?.content ?? null;
    const toolCalls: ToolCall[] | undefined =
      Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0
        ? msg.tool_calls
        : undefined;
    if (content === null && !toolCalls) {
      throw new Error('Invalid response from API: no content and no tool calls');
    }

    const tokenUsage = response.data?.usage
      ? {
          prompt_tokens: response.data.usage.prompt_tokens ?? 0,
          completion_tokens: response.data.usage.completion_tokens ?? 0,
          total_tokens: response.data.usage.total_tokens ?? 0,
        }
      : undefined;

    return { content, toolCalls, tokenUsage };
  } catch (error: any) {
    // Aborted by caller (user clicked Stop)
    if (error.name === 'CanceledError' || error.code === 'ERR_CANCELED') {
      const abortErr = new Error('Operation stopped by user.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('Request timed out. Please check your API endpoint and network connection.');
      }
      const status = error.response?.status;
      const detail = error.response?.data?.error?.message || error.message;
      throw new Error(`API error${status ? ` (${status})` : ''}: ${detail}`);
    }
    throw error;
  }
}
