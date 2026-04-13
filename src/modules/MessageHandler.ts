import * as vscode from 'vscode';
import { ChatMessage, ChatSession, ApiConfig } from '../types';
import { SYSTEM_PROMPT, TOOL_DEFINITIONS } from '../toolDefinitions';
import { sendChatMessage } from '../api';
import { gitSnapshotTool } from '../tools';

const MAX_TOOL_ITERATIONS = 20;
const AUTO_COMPACT_TOKEN_THRESHOLD = 1_000_000;

export class MessageHandler {
  private _isRunning = false;
  private _stopRequested = false;
  private _abortController: AbortController = new AbortController();

  constructor(
    private readonly _context: {
      getApiConfig: () => ApiConfig;
      post: (message: any) => void;
      getCurrentMessages: () => ChatMessage[];
      addMessage: (message: ChatMessage) => void;
      getCurrentSessionId: () => string;
      saveCurrentSession: () => void;
      sanitizeIncompleteToolCalls: () => void;
      executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
      compactHistory: (triggeredByTokenLimit?: boolean) => Promise<string>;
    }
  ) {}

  private _sanitizeIncompleteToolCalls(): void {
    // 从chatView.ts中提取的逻辑
    const messages = this._context.getCurrentMessages();
    // 查找最后的助手消息（包含tool_calls）- 使用传统循环替代findLastIndex
    let lastAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].tool_calls) {
        lastAssistantIndex = i;
        break;
      }
    }
    if (lastAssistantIndex < 0) { return; }
    const assistantMsg = messages[lastAssistantIndex];
    if (!assistantMsg.tool_calls) { return; }
    // 检查对应的tool结果是否存在
    const toolCallIds = assistantMsg.tool_calls.map((tc: { id: string }) => tc.id);
    const existingToolCallIds = new Set(
      messages
        .filter((m: ChatMessage) => m.role === 'tool' && m.tool_call_id)
        .map((m: ChatMessage) => m.tool_call_id!)
    );
    const missingIds = toolCallIds.filter(id => !existingToolCallIds.has(id));
    if (missingIds.length === 0) { return; }
    // 如果有缺失的tool结果，删除这个不完整的助手消息
    messages.splice(lastAssistantIndex, 1);
    // 也删除跟随的tool结果（如果有的话，应该是空的）
    for (let i = messages.length - 1; i >= lastAssistantIndex; i--) {
      if (messages[i].role === 'tool' && messages[i].tool_call_id && missingIds.includes(messages[i].tool_call_id!)) {
        messages.splice(i, 1);
      }
    }
  }

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
        const snapshotResult = gitSnapshotTool({
          sessionId: this._context.getCurrentSessionId(),
          userInstruction: text,
          description: `Auto-snapshot before processing user instruction`
        });
        const parsed = JSON.parse(snapshotResult);
        if (parsed.success && parsed.snapshotId) {
          console.log(`Git snapshot created: ${parsed.snapshotId} for instruction: ${text.substring(0, 50)}...`);
        } else {
          console.log(`Git snapshot result: success=${parsed.success}, snapshotId=${parsed.snapshotId}, message="${parsed.message || ''}", error="${parsed.error || ''}"`);
        }
      } catch (error) {
        // 如果Git仓库不存在或快照创建失败，只记录到控制台
        console.log('Git snapshot creation skipped or failed:', error);
      }
      
      this._context.post({ type: 'addMessage', message: { role: 'user', content: text } });
      this._context.addMessage({ role: 'user', content: text });
    }
    
    this._context.post({ type: 'loading', loading: true });
    
    try {
      const apiConfig = this._context.getApiConfig();
      let iterations = 0;
      let memoryUpdateDone = false;
      const maxIterations = apiConfig.maxInteractions === -1 ? Number.MAX_SAFE_INTEGER : (apiConfig.maxInteractions || MAX_TOOL_ITERATIONS);
      
      while (iterations < maxIterations && !this._stopRequested) {
        iterations++;

        // Check if user requested stop before each iteration
        if (this._stopRequested) {
          this._context.post({ type: 'info', message: 'Operation stopped by user.' });
          break;
        }

        const allMessages: ChatMessage[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...this._context.getCurrentMessages(),
        ];

        const response = await sendChatMessage(allMessages, apiConfig, TOOL_DEFINITIONS, this._abortController.signal);

        // Check for stop request before processing response
        if (this._stopRequested) {
          this._context.post({ type: 'info', message: 'Operation stopped by user.' });
          break;
        }

        // Check if the assistant output contains the completion signal
        const hasCompletionSignal = response.content && response.content.includes('<TASK_COMPLETE>');
        
        if (response.toolCalls && response.toolCalls.length > 0) {
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
              result = await this._context.executeTool(name, args);
            } catch (e: any) {
              result = JSON.stringify({ error: e.message });
            }

            this._context.post({ type: 'toolResult', name, result });
            this._context.addMessage({ role: 'tool', content: result, tool_call_id: toolCall.id });
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

          // Only exit when the model explicitly signals it is done.
          if (hasCompletionSignal) {
            memoryUpdateDone = true;
            // MODIFIED: Removed automatic memory update prompt for better user experience
            // Now directly break when task is complete
            break;
          } else {
            // LLM provided a response without tool calls and without <TASK_COMPLETE>
            // Add a prompt asking the LLM to either continue or signal completion
            const prompt = `你的回答没有包含工具调用，也没有任务完成标记<TASK_COMPLETE>。请确认：
1. 如果任务已完成，请输出<TASK_COMPLETE>
2. 如果需要继续分析或调用工具，请继续。`;
            this._context.post({ type: 'addMessage', message: { role: 'user', content: prompt } });
            this._context.addMessage({ role: 'user', content: prompt });
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