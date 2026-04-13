import { ChatMessage, ApiConfig } from '../types';
import { SYSTEM_PROMPT, TOOL_DEFINITIONS } from '../toolDefinitions';
import { sendChatMessage } from '../api';
import { gitSnapshotTool } from '../tools';
import { AUTO_COMPACT_TOKEN_THRESHOLD, MAX_TOOL_ITERATIONS } from '../constants';

export class MessageHandler {
  private _isRunning = false;
  private _stopRequested = false;
  private _abortController: AbortController = new AbortController();

  constructor(
    private readonly _context: {
      getApiConfig: () => ApiConfig;
      post: (message: any) => void;
      /** Assembled system + history; extension point for multi-agent. */
      buildMessagesForLlm: (systemPrompt: string) => ChatMessage[];
      addMessage: (message: ChatMessage) => void;
      getCurrentSessionId: () => string;
      saveCurrentSession: () => void;
      sanitizeIncompleteToolCalls: () => void;
      executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
      compactHistory: (triggeredByTokenLimit?: boolean) => Promise<string>;
    }
  ) {}

  public async handleUserMessage(text: string): Promise<void> {
    if (this._isRunning) { return; }

    this._context.sanitizeIncompleteToolCalls();

    this._isRunning = true;
    this._stopRequested = false;
    this._abortController = new AbortController();
    this._context.post({ type: 'setRunning', running: true });

    // Empty message = "continue" signal; don't add it to conversation history.
    if (text) {
      // 尝试创建Git快照（静默失败，不影响主流程）
      try {
        gitSnapshotTool({
          sessionId: this._context.getCurrentSessionId(),
          userInstruction: text,
          description: `Auto-snapshot before processing user instruction`
        });
      } catch {
        /* no Git repo or snapshot failure — non-fatal */
      }
      
      this._context.post({ type: 'addMessage', message: { role: 'user', content: text } });
      this._context.addMessage({ role: 'user', content: text });
    }
    
    this._context.post({ type: 'loading', loading: true });
    
    try {
      const apiConfig = this._context.getApiConfig();
      let iterations = 0;
      const maxIterations = apiConfig.maxInteractions === -1 ? Number.MAX_SAFE_INTEGER : (apiConfig.maxInteractions || MAX_TOOL_ITERATIONS);
      // Internal-only prompt injection for the next LLM call.
      // Used to nudge the model when it returns plain text without tool calls and without <TASK_COMPLETE>.
      // IMPORTANT: Do not append this as a visible chat message.
      let injectedSystemPrompt = '';
      
      while (iterations < maxIterations && !this._stopRequested) {
        iterations++;

        // Check if user requested stop before each iteration
        if (this._stopRequested) {
          this._context.post({ type: 'info', message: 'Operation stopped by user.' });
          break;
        }

        const allMessages = this._context.buildMessagesForLlm(SYSTEM_PROMPT + injectedSystemPrompt);

        const response = await sendChatMessage(allMessages, apiConfig, TOOL_DEFINITIONS, this._abortController.signal);

        // Check for stop request before processing response
        if (this._stopRequested) {
          this._context.post({ type: 'info', message: 'Operation stopped by user.' });
          break;
        }

        // Check if the assistant output contains the completion signal
        const hasCompletionSignal = response.content && response.content.includes('<TASK_COMPLETE>');
        
        if (response.toolCalls && response.toolCalls.length > 0) {
          // Reset any internal nudge once the model starts using tools again.
          injectedSystemPrompt = '';
          // Push assistant turn (may have reasoning text + tool_calls)
          this._context.addMessage({
            role: 'assistant',
            content: response.content,
            tool_calls: response.toolCalls,
          });

          // Show any reasoning text the model produced alongside the tool calls
          if (response.content) {
            this._context.post({ type: 'addMessage', message: { role: 'assistant', content: response.content } });
          }

          // Execute each tool call sequentially
          for (const toolCall of response.toolCalls) {
            // Check for stop request before each tool call
            if (this._stopRequested) {
              this._context.post({ type: 'info', message: 'Operation stopped by user.' });
              break;
            }

            const name = toolCall.function.name;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(toolCall.function.arguments); } catch { /* keep empty */ }

            this._context.post({ type: 'toolCall', name, args });

            let result: string;
            try {
              if (name === 'compact') {
                result = await this._context.compactHistory(false);
              } else {
                result = await this._context.executeTool(name, args);
              }
            } catch (e: any) {
              result = JSON.stringify({ error: e.message });
            }

            this._context.post({ type: 'toolResult', name, result });
            if (name !== 'compact') {
              this._context.addMessage({ role: 'tool', content: result, tool_call_id: toolCall.id });
            }
          }

          // Go back to the top of the loop to continue the conversation
        } else {
          // Text response (no tool calls)
          let content = response.content ?? '(no response)';

          // Strip the completion signal from the visible text
          if (hasCompletionSignal) {
            content = content.replace('<TASK_COMPLETE>', '').trim();
          }

          this._context.addMessage({ role: 'assistant', content });
          this._context.post({ type: 'addMessage', message: { role: 'assistant', content } });
          if (response.tokenUsage) {
            this._context.post({ type: 'tokenUsage', usage: response.tokenUsage });
            // 自动 compact：prompt_tokens 超过阈值时在本轮结束后压缩历史
            if (response.tokenUsage.prompt_tokens >= AUTO_COMPACT_TOKEN_THRESHOLD) {
              await this._context.compactHistory(true);
            }
          }

          if (hasCompletionSignal) {
            injectedSystemPrompt = '';
            break;
          } else {
            // LLM provided a response without tool calls and without <TASK_COMPLETE>
            // Nudge the LLM internally (do NOT show in chatbot, do NOT store in session history).
            injectedSystemPrompt =
              `\n\n[INTERNAL NUDGE]\n` +
              `上一轮你只输出了纯文本，没有任何tool calls，也没有输出任务完成标记<TASK_COMPLETE>。\n` +
              `- 如果任务已完成：请只输出<TASK_COMPLETE>。\n` +
              `- 如果需要继续：请继续分析并在需要时发起tool calls。\n` +
              `[END INTERNAL NUDGE]\n`;
          }
        }
        
        if (iterations >= maxIterations) {
          this._context.post({ type: 'info', message: `Iteration limit (${maxIterations}) reached. Send an empty message to keep going, or type a new instruction.` });
        }
      } // end while
    } catch (error: any) {
      if (error.name === 'AbortError') {
        this._context.post({ type: 'info', message: 'Operation stopped by user.' });
      } else {
        this._context.post({ type: 'error', message: error.message });
      }
    } finally {
      this._context.post({ type: 'loading', loading: false });
      this._context.post({ type: 'setRunning', running: false });
      this._isRunning = false;
      this._stopRequested = false;
    }
  }

  public stopCurrentOperation(): void {
    if (this._isRunning) {
      this._stopRequested = true;
      this._abortController.abort();
      this._context.post({ type: 'info', message: 'Stopping current operation...' });
    }
  }
}