import * as vscode from 'vscode';
import { sendChatMessage } from './api';
import { ChatMessage, ChatSession, ApiConfig } from './types';
import { TOOL_DEFINITIONS, SYSTEM_PROMPT } from './toolDefinitions';
import { readFileTool, findInFileTool, replaceLinesTool, getWorkspaceInfoTool, createDirectoryTool, getDiagnosticsTool } from './tools';
import type { ReplaceCheckContext } from './tools';
import * as fs from 'fs';
import * as path from 'path';

const MAX_TOOL_ITERATIONS = 20;
/** 当 prompt_tokens 超过此值时自动触发 /compact（可按需调整）。 */
const AUTO_COMPACT_TOKEN_THRESHOLD = 1_000_000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vibeCodingChat';
  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _currentSessionId: string = 'default';
  private _sessions: ChatSession[] = [];
  private _todoList: { goal: string; items: { text: string; done: boolean }[] } | null = null;
  private _isRunning = false;
  private _stopRequested = false;
  private _abortController: AbortController = new AbortController();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._loadSessions();
  }

  // ─── WebviewViewProvider ───────────────────────────────────────────────────
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'sendMessage') {
        await this._handleUserMessage(msg.text);
      }
      if (msg.type === 'ready') {
        // Replay visible conversation AFTER the webview signals it is ready,
        // so the message listener is guaranteed to be set up before we post.
        this._sendWorkspaceBanner();
        this._postSessionsList();
        for (const saved of this._messages) {
          if (saved.role === 'user') {
            this._view?.webview.postMessage({
              type: 'addMessage',
              message: { role: saved.role, content: saved.content },
            });
          } else if (saved.role === 'assistant' && saved.tool_calls) {
            // 处理包含 tool_calls 的助手消息
            // 先显示助手的内容（如果有）
            if (saved.content) {
              this._view?.webview.postMessage({
                type: 'addMessage',
                message: { role: saved.role, content: saved.content },
              });
            }
            // 为每个 tool call 发送 toolCall 消息
            for (const toolCall of saved.tool_calls) {
              const name = toolCall.function.name;
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(toolCall.function.arguments);
              } catch {
                // keep empty
              }
              this._view?.webview.postMessage({
                type: 'toolCall',
                name,
                args,
              });
            }
          } else if (saved.role === 'assistant' && saved.content) {
            // 普通助手消息
            this._view?.webview.postMessage({
              type: 'addMessage',
              message: { role: saved.role, content: saved.content },
            });
          } else if (saved.role === 'tool' && saved.tool_call_id && saved.content) {
            // 处理 tool 角色消息，发送 toolResult 消息
            // 我们需要从历史中找到对应的 tool call 来获取工具名称
            // 由于历史消息是顺序的，我们可以向后查找最近的包含 tool_calls 的助手消息
            let toolName = 'unknown';
            // 向后查找最近的助手消息中的 tool_call
            for (let i = this._messages.indexOf(saved) - 1; i >= 0; i--) {
              const prevMsg = this._messages[i];
              if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
                const matchingCall = prevMsg.tool_calls.find(
                  tc => tc.id === saved.tool_call_id
                );
                if (matchingCall) {
                  toolName = matchingCall.function.name;
                  break;
                }
              }
            }
            this._view?.webview.postMessage({
              type: 'toolResult',
              name: toolName,
              result: saved.content,
            });
          }
        }
      }
      if (msg.type === 'stopOperation') {
        this.stopCurrentOperation();
      }
      if (msg.type === 'clearHistory') {
        this.clearHistory();
        this._post({ type: 'clearMessages' });
      }
      if (msg.type === 'newSession') {
        this._createNewSession();
      }
      if (msg.type === 'switchSession') {
        await this._switchSession(msg.sessionId);
      }
      if (msg.type === 'deleteSession') {
        await this._deleteSession(msg.sessionId);
      }
      if (msg.type === 'updateSessionTitle') {
        await this._updateSessionTitle(msg.sessionId, msg.title);
      }
      if (msg.type === 'renameSession') {
        const newTitle = await vscode.window.showInputBox({
          prompt: 'New conversation title',
          value: msg.currentTitle,
          validateInput: v => v.trim() ? null : 'Title cannot be empty',
        });
        if (newTitle && newTitle.trim()) {
          await this._updateSessionTitle(msg.sessionId, newTitle.trim());
        }
      }
    });
  }

  // ─── Message handling ──────────────────────────────────────────────────────
  /**
   * Remove any assistant message with tool_calls that is not fully answered
   * by subsequent tool messages. This covers two cases:
   *   1. Session ended / user stopped mid-flight  → orphaned assistant+tool_calls
   *   2. Old bug: _saveMessages persisted tool_calls without tool responses
   *
   * Unlike a simple truncation, this pass only removes the offending
   * assistant message and its partial tool responses, preserving any later
   * valid messages (e.g. a final text reply that was correctly saved).
   */
  private _sanitizeIncompleteToolCalls() {
    let changed = false;
    const clean: ChatMessage[] = [];

    for (let i = 0; i < this._messages.length; i++) {
      const msg = this._messages[i];

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const requiredIds = new Set(msg.tool_calls.map(tc => tc.id));
        const rest = this._messages.slice(i + 1);
        const respondedIds = new Set(
          rest
            .filter(m => m.role === 'tool' && m.tool_call_id)
            .map(m => m.tool_call_id!)
        );

        if (!Array.from(requiredIds).every(id => respondedIds.has(id))) {
          // Drop this assistant message AND any immediately-following
          // partial tool messages, then resume from the next non-tool message.
          changed = true;
          let j = i + 1;
          while (j < this._messages.length && this._messages[j].role === 'tool') {
            j++;
          }
          i = j - 1; // loop will i++ → resumes at j
          continue;
        }
      }

      clean.push(msg);
    }

    if (changed) {
      this._messages = clean;
      this._saveSessions();
    }
  }

  private async _handleUserMessage(text: string) {
    if (!this._view || this._isRunning) { return; }

    // 注意：/compact 指令现在通过工具调用（compact）处理，而不是直接执行
    // 系统会将用户输入的 /compact 视为普通消息，让AI决定何时调用compact工具

    // Clean up any incomplete tool-call turns left by a previous stop/error
    this._sanitizeIncompleteToolCalls();

    this._isRunning = true;
    this._stopRequested = false;
    this._abortController = new AbortController();
    this._post({ type: 'setRunning', running: true });

    // Empty message = "continue" signal; don't add it to conversation history.
    if (text) {
      this._post({ type: 'addMessage', message: { role: 'user', content: text } });
      this._addMessage({ role: 'user', content: text });
    }
    this._post({ type: 'loading', loading: true });
     try {
         const apiConfig = this._getApiConfig();
         let iterations = 0;
         let memoryUpdateDone = false;
         const maxIterations = apiConfig.maxInteractions === -1 ? Number.MAX_SAFE_INTEGER : (apiConfig.maxInteractions || MAX_TOOL_ITERATIONS);
         while (iterations < maxIterations && !this._stopRequested) {
           iterations++;

        // Check if user requested stop before each iteration
        if (this._stopRequested) {
          this._post({ type: 'info', message: 'Operation stopped by user.' });
          break;
        }

        const allMessages: ChatMessage[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...this._messages,
        ];

        const response = await sendChatMessage(allMessages, apiConfig, TOOL_DEFINITIONS, this._abortController.signal);

        // Check for stop request before processing response
        if (this._stopRequested) {
          this._post({ type: 'info', message: 'Operation stopped by user.' });
          break;
        }

        // Check if the assistant output contains the completion signal
        const hasCompletionSignal = response.content && response.content.includes('<TASK_COMPLETE>');
        
        if (response.toolCalls && response.toolCalls.length > 0) {
          // Push assistant turn (may have reasoning text + tool_calls)
          this._addMessage({
            role: 'assistant',
            content: response.content,
            tool_calls: response.toolCalls,
          });

          // Show any reasoning text the model produced alongside the tool calls
          if (response.content) {
            this._post({ type: 'addMessage', message: { role: 'assistant', content: response.content } });
          }

          // Execute each tool call sequentially
          for (const toolCall of response.toolCalls) {
            // Check for stop request before each tool call
            if (this._stopRequested) {
              this._post({ type: 'info', message: 'Operation stopped by user.' });
              break;
            }

            const name = toolCall.function.name;
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(toolCall.function.arguments); } catch { /* keep empty */ }

            this._post({ type: 'toolCall', name, args });

            let result: string;
            try {
              result = await this._executeTool(name, args);
            } catch (e: any) {
              result = JSON.stringify({ error: e.message });
            }

            this._post({ type: 'toolResult', name, result });
            this._addMessage({ role: 'tool', content: result, tool_call_id: toolCall.id });
          }

          // Go back to the top of the loop to continue the conversation
        } else {
          // Text response (no tool calls)
          let content = response.content ?? '(no response)';

          // Strip the completion signal from the visible text
          if (hasCompletionSignal) {
            content = content.replace('<TASK_COMPLETE>', '').trim();
          }

          this._addMessage({ role: 'assistant', content });
          this._post({ type: 'addMessage', message: { role: 'assistant', content } });
          if (response.tokenUsage) {
            this._post({ type: 'tokenUsage', usage: response.tokenUsage });
            // 自动 compact：prompt_tokens 超过阈值时在本轮结束后压缩历史
            if (response.tokenUsage.prompt_tokens >= AUTO_COMPACT_TOKEN_THRESHOLD) {
              await this._compactHistory(true);
            }
          }


          // Only exit when the model explicitly signals it is done.
          if (hasCompletionSignal) {
            memoryUpdateDone = true;
            // MODIFIED: Removed automatic memory update prompt for better user experience
            // Now directly break when task is complete
            break;
          }
        }
      if (iterations >= maxIterations) {
        this._post({ type: 'info', message: `Iteration limit (${maxIterations}) reached. Send an empty message to keep going, or type a new instruction.` });
      }
     } // end while
  } // end try
  catch (error: any) {
      if (error.name === 'AbortError') {
        this._post({ type: 'info', message: 'Operation stopped by user.' });
      } else {
        this._post({ type: 'error', message: error.message });
      }
    } finally {
      this._post({ type: 'loading', loading: false });
      this._post({ type: 'setRunning', running: false });
      this._isRunning = false;
      this._stopRequested = false;
    }
  }

  public stopCurrentOperation() {
    if (this._isRunning) {
      this._stopRequested = true;
      this._abortController.abort();
      this._post({ type: 'info', message: 'Stopping current operation...' });
    }
  }

  // ─── Tool dispatch ─────────────────────────────────────────────────────────

  private async _executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'get_workspace_info':
        return getWorkspaceInfoTool();

      case 'read_file':
        return readFileTool({
          filePath: args.filePath as string,
          startLine: args.startLine as number | undefined,
          endLine: args.endLine as number | undefined,
        });

      case 'find_in_file':
        return findInFileTool({
          filePath: args.filePath as string,
          searchString: args.searchString as string,
          contextBefore: args.contextBefore as number | undefined,
          contextAfter: args.contextAfter as number | undefined,
          occurrence: args.occurrence as number | undefined,
        });

      case 'edit':
        return replaceLinesTool(
          {
            filePath: args.filePath as string,
            startLine: args.startLine as number,
            endLine: args.endLine as number,
            newContent: args.newContent as string,
          },
          (ctx) => this._llmCheckReplace(ctx),
          this._getApiConfig().confirmChanges !== false ? (ctx) => this._userConfirmReplace(ctx) : undefined
        );

      case 'create_directory':
        return createDirectoryTool({
          dirPath: args.dirPath as string,
          recursive: args.recursive as boolean | undefined,
        });

       case 'create_todo_list': {
        const goal = args['goal'] as string;
        const items = (args['items'] as string[]) || [];
        const expandIndex = args['expandIndex'] as number | undefined;

        // 处理扩展模式
        if (this._todoList && expandIndex !== undefined) {
          if (expandIndex < 0 || expandIndex >= this._todoList.items.length) {
            return JSON.stringify({ error: `Expand index ${expandIndex} is out of range (0–${this._todoList.items.length - 1}).` });
          }
          
          const newItems = items.map(text => ({ text, done: false }));
          this._todoList.items.splice(expandIndex, 1, ...newItems);
          
          const list = this._todoList.items
            .map((item, i) => `${i + 1}. [${item.done ? 'x' : ' '}] ${item.text}`)
            .join('\n');
          const remaining = this._todoList.items.filter(i => !i.done).length;
          const result = JSON.stringify({
            success: true,
            message: `Todo list expanded at index ${expandIndex} with ${items.length} items.`,
            goal: this._todoList.goal,
            items: list,
            remaining,
          });
          
          const todoListDisplay = `Todo list expanded:\n\n**Goal**: ${this._todoList.goal}\n\n**Items**:\n${list}\n\n**Remaining**: ${remaining} item(s)`;
          this._post({ type: 'addMessage', message: { role: 'assistant', content: todoListDisplay } });
          
          return result;
        }
        
        // 创建新列表
        this._todoList = {
          goal,
          items: items.map(text => ({ text, done: false })),
        };
        const list = items.map((item, i) => `${i + 1}. [ ] ${item}`).join('\n');
        const result = JSON.stringify({
          success: true,
          message: `Todo list created with ${items.length} items.`,
          goal,
          items: list,
        });
        
        const todoListDisplay = `Todo list created:\n\n**Goal**: ${goal}\n\n**Items**:\n${list}`;
        this._post({ type: 'addMessage', message: { role: 'assistant', content: todoListDisplay } });
        
        return result;
      }

      case 'complete_todo_item': {
        const idx = args['index'] as number;
        const summary = (args['summary'] as string) || '';
        if (!this._todoList) {
          return JSON.stringify({ error: 'No todo list exists. Call create_todo_list first.' });
        }
        if (idx < 0 || idx >= this._todoList.items.length) {
          return JSON.stringify({ error: `Index ${idx} is out of range (0–${this._todoList.items.length - 1}).` });
        }
        this._todoList.items[idx].done = true;
        const list = this._todoList.items
          .map((item, i) => `${i + 1}. [${item.done ? 'x' : ' '}] ${item.text}`)
          .join('\n');
        const remaining = this._todoList.items.filter(i => !i.done).length;
        const result = JSON.stringify({
          success: true,
          message: summary ? `Item ${idx + 1} complete: ${summary}` : `Item ${idx + 1} marked complete.`,
          remaining,
          todoList: list,
        });
        
        // 向用户显示更新后的todo list
        const todoListDisplay = `Todo list updated:\n\n**Items**:\n${list}\n\n**Remaining**: ${remaining} item(s)`;
        this._post({ type: 'addMessage', message: { role: 'assistant', content: todoListDisplay } });
        
        return result;
       }

        case 'compact': {
          return await this._compactHistory();
        }

        case 'get_diagnostics': {
          return getDiagnosticsTool({
            uri: args.uri as string | undefined,
            filePath: args.filePath as string | undefined,
          });
        }

        default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  // ─── LLM secondary confirmation for replace ────────────────────────────────
  /**
   * Sends the before/after context windows to the LLM and asks it to confirm
   * whether the replacement looks correct. Returns true only if the LLM
   * explicitly approves.
   */
  private async _llmCheckReplace(ctx: ReplaceCheckContext): Promise<boolean> {
    const apiConfig = this._getApiConfig();

    const prompt =
      `You are a code-review assistant. A replace_lines operation is about to be applied.\n` +
      `File: ${ctx.filePath}  |  lines ${ctx.startLine}–${ctx.endLine}\n\n` +
      `## BEFORE (lines marked >>> will be replaced)\n\`\`\`\n${ctx.beforeContext}\n\`\`\`\n\n` +
      `## AFTER (lines marked >>> are the new content)\n\`\`\`\n${ctx.afterContext}\n\`\`\`\n\n` +
      `Does this replacement look correct and safe to apply? ` +
      `Reply with exactly one word: CONFIRM or REJECT, followed by a brief reason.`;

    let reply: string;
    try {
      const checkMessages: import('./types').ChatMessage[] = [
        { role: 'user', content: prompt },
      ];
      // Use the same API but without tools so we get a plain text answer
      const response = await sendChatMessage(checkMessages, apiConfig, undefined, this._abortController.signal);
      reply = (response.content ?? '').trim().toUpperCase();
    } catch {
      // If the check call itself fails, default to rejecting to stay safe
      return false;
    }

    const approved = reply.startsWith('CONFIRM');

    // Surface the LLM's verdict in the chat UI
    this._post({
      type: 'addMessage',
      message: {
        role: 'system',
        content: `🔍 **Replace check** (${ctx.filePath} lines ${ctx.startLine}–${ctx.endLine}): ${approved ? '✅ CONFIRMED' : '❌ REJECTED'} — ${reply.slice(approved ? 7 : 6).trim() || '(no reason given)'}`,
      },
    });

    return approved;
  }

  // ─── User confirmation dialog for replace ──────────────────────────────────
  private async _userConfirmReplace(ctx: ReplaceCheckContext): Promise<boolean> {
    const answer = await vscode.window.showWarningMessage(
      `Apply changes to ${ctx.filePath} (lines ${ctx.startLine}–${ctx.endLine})?`,
      { modal: true, detail: `BEFORE:\n${ctx.beforeContext}\n\nAFTER:\n${ctx.afterContext}` },
      '确认修改',
      '拒绝'
    );
    return answer === '确认修改';
  }

  // ─── /compact ──────────────────────────────────────────────────────────────
  /**
   * 用 LLM 将当前对话历史压缩为一段摘要，然后用单条 summary 消息替换全部历史，
   * 以释放 context window 空间。
   *
   * 摘要策略：
   *   - 保留所有已完成/决定的关键事项（文件改动、架构决策、待办进度）
   *   - 省略中间的工具调用细节和冗长的 assistant 思考过程
   *   - 保留最后 2 条 user/assistant 交流，让上下文不显突兀
   */
   private async _compactHistory(triggeredByTokenLimit = false): Promise<string> {
     if (this._messages.length === 0) {
       const emptyMessage = 'Nothing to compact: conversation is empty.';
       if (triggeredByTokenLimit) {
         this._post({ type: 'info', message: emptyMessage });
       }
       return JSON.stringify({ success: false, message: emptyMessage });
     }

     if (!triggeredByTokenLimit) {
       // 只在非自动触发时显示信息，因为工具调用会显示为气泡
       this._post({ type: 'info', message: '🗜️ Compacting conversation history…' });
     } else {
       this._post({ type: 'info', message: '⚡ Context window nearly full — compacting conversation history…' });
     }

     try {
       const apiConfig = this._getApiConfig();

       // 把当前历史序列化为可读文本交给 LLM
       const historyText = this._messages
         .filter(m => m.role !== 'tool' || !!m.content)
         .map(m => {
           const roleLabel =
             m.role === 'user' ? 'User' :
             m.role === 'assistant' ? 'Assistant' :
             m.role === 'tool' ? 'Tool result' : 'System';
           const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
           return `[${roleLabel}]\n${body}`;
         })
         .join('\n\n---\n\n');

       const summarizePrompt =
         `You are a conversation summarizer. Below is the full history of a coding-assistant session.\n` +
         `Your job is to write a CONCISE but COMPLETE summary that will replace the history.\n\n` +
         `Rules:\n` +
         `- Keep: all files created/modified (with key changes), decisions made, goals, current task state, and any open questions.\n` +
         `- Omit: verbose tool output, repetitive reasoning, step-by-step narration already reflected in outcomes.\n` +
         `- Write in third-person present tense ("The user is building…", "The assistant has modified…").\n` +
         `- End with a short "## Current State" section describing what was happening right before this summary.\n\n` +
         `=== CONVERSATION HISTORY ===\n${historyText}\n=== END ===\n\n` +
         `Write the summary now:`;

       const summaryResponse = await sendChatMessage(
         [{ role: 'user', content: summarizePrompt }],
         apiConfig,
         undefined,
         this._abortController.signal
       );

       const summary = summaryResponse.content?.trim() ?? '(summary unavailable)';

       // 用 summary 替换全部历史，前置一条 system 风格的 summary 消息
       const summaryMessage: ChatMessage = {
         role: 'assistant',
         content:
           `📋 **[Conversation history compacted]**\n\n${summary}`,
       };

       this._messages = [summaryMessage];
       this._saveCurrentSession();

       // 刷新 UI
       this._post({ type: 'clearMessages' });
       this._post({ type: 'addMessage', message: { role: 'assistant', content: summaryMessage.content } });
       
       if (!triggeredByTokenLimit) {
         // 只在非自动触发时显示成功信息，因为工具调用结果会显示为气泡
         this._post({ type: 'info', message: '✅ History compacted. Continuing with summary as context.' });
       }

       return JSON.stringify({
         success: true,
         message: 'Conversation history compacted successfully.',
         summary: summaryMessage.content
       });

     } catch (error: any) {
       if (error.name === 'AbortError') {
         const abortMessage = 'Compact cancelled.';
         this._post({ type: 'info', message: abortMessage });
         return JSON.stringify({ success: false, message: abortMessage });
       } else {
         const errorMessage = `Failed to compact history: ${error.message}`;
         this._post({ type: 'error', message: errorMessage });
         return JSON.stringify({ success: false, message: errorMessage });
       }
     }
   }

  // ─── Workspace banner ──────────────────────────────────────────────────────
  private _sendWorkspaceBanner() {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const name = workspace?.name || 'No workspace open';
    const path = workspace?.uri.fsPath || '';
    const text = `Workspace: ${name} (${path})`;
    this._post({ type: 'addMessage', message: { role: 'system', content: text } });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private _getStorageRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder is open');
    }
    const workspaceRoot = folders[0].uri.fsPath;
    return path.join(workspaceRoot, '.OpenVibe');
  }

  private _getSessionsDir(): string {
    return path.join(this._getStorageRoot(), 'sessions');
  }

  private _getSessionFilePath(sessionId: string): string {
    return path.join(this._getSessionsDir(), `${sessionId}.json`);
  }

  private _getSessionsIndexPath(): string {
    return path.join(this._getStorageRoot(), 'sessions-index.json');
  }

  private _ensureStorageDirs(): void {
    const storageRoot = this._getStorageRoot();
    if (!fs.existsSync(storageRoot)) {
      fs.mkdirSync(storageRoot, { recursive: true });
    }
    
    const sessionsDir = this._getSessionsDir();
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
  }

  private _loadSessionsIndex(): ChatSession[] {
    this._ensureStorageDirs();
    
    const indexPath = this._getSessionsIndexPath();
    console.log(`[LOAD_INDEX] Loading from: ${indexPath}`);
    console.log(`[LOAD_INDEX] File exists: ${fs.existsSync(indexPath)}`);
    
    if (!fs.existsSync(indexPath)) {
      console.log(`[LOAD_INDEX] File does not exist, returning empty array`);
      return [];
    }
    
    try {
      const data = fs.readFileSync(indexPath, 'utf-8');
      console.log(`[LOAD_INDEX] Raw file content: ${data.substring(0, 200)}...`);
      const sessions = JSON.parse(data);
      console.log(`[LOAD_INDEX] Parsed ${Array.isArray(sessions) ? sessions.length : 0} sessions`);
      return Array.isArray(sessions) ? sessions : [];
    } catch (error) {
      console.warn('[LOAD_INDEX] Failed to load sessions index:', error);
      return [];
    }
  }

  private _saveSessionsIndex(sessions: ChatSession[]): void {
    this._ensureStorageDirs();
    
    try {
      const indexPath = this._getSessionsIndexPath();
      const data = JSON.stringify(sessions, null, 2);
      fs.writeFileSync(indexPath, data, 'utf-8');
    } catch (error) {
      console.warn('Failed to save sessions index:', error);
    }
  }

  private _loadSession(sessionId: string): ChatSession | null {
    this._ensureStorageDirs();
    
    const filePath = this._getSessionFilePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(data);
      return session;
    } catch (error) {
      console.warn(`Failed to load session ${sessionId}:`, error);
      return null;
    }
  }

  private _saveSession(session: ChatSession): void {
    this._ensureStorageDirs();
    
    try {
      const filePath = this._getSessionFilePath(session.id);
      const data = JSON.stringify(session, null, 2);
      fs.writeFileSync(filePath, data, 'utf-8');
      
      // Update the index
      const index = this._loadSessionsIndex();
      const existingIndex = index.findIndex(s => s.id === session.id);
      
      const sessionInIndex: ChatSession = {
        id: session.id,
        title: session.title,
        created: session.created,
        updated: session.updated,
        messages: [], // Don't store messages in index
        isActive: session.isActive
      };
      
      if (existingIndex >= 0) {
        index[existingIndex] = sessionInIndex;
      } else {
        index.push(sessionInIndex);
      }
      
      this._saveSessionsIndex(index);
    } catch (error) {
      console.warn(`Failed to save session ${session.id}:`, error);
    }
  }

   /**
    * Atomically delete a session file and update the sessions index.
    * Returns true if both operations succeed, false otherwise.
    */
   private _deleteSessionAtomically(sessionId: string): boolean {
     this._ensureStorageDirs();
     
     try {
       // 1. First load the current index to verify the session exists
       const indexPath = this._getSessionsIndexPath();
       console.log(`[DELETE_SESSION] Loading sessions index from: ${indexPath}`);
       
       let index: ChatSession[] = [];
       if (fs.existsSync(indexPath)) {
         try {
           const data = fs.readFileSync(indexPath, 'utf-8');
           index = JSON.parse(data);
           if (!Array.isArray(index)) {
             console.warn(`[DELETE_SESSION] Index file contains invalid data, resetting to empty array`);
             index = [];
           }
         } catch (error) {
           console.warn(`[DELETE_SESSION] Failed to load sessions index:`, error);
           index = [];
         }
       }
       
       // 2. Check if session exists in index
       const sessionExistsInIndex = index.some(s => s.id === sessionId);
       console.log(`[DELETE_SESSION] Session ${sessionId} exists in index: ${sessionExistsInIndex}`);
       
       // 3. Delete session file
       const filePath = this._getSessionFilePath(sessionId);
       console.log(`[DELETE_SESSION] Attempting to delete session file: ${filePath}`);
       console.log(`[DELETE_SESSION] File exists: ${fs.existsSync(filePath)}`);
       
       if (fs.existsSync(filePath)) {
         fs.unlinkSync(filePath);
         console.log(`[DELETE_SESSION] Successfully deleted session file: ${filePath}`);
       } else {
         console.log(`[DELETE_SESSION] Session file not found, continuing with index update`);
       }
       
       // 4. Update index (remove the deleted session)
       const filteredIndex = index.filter(s => s.id !== sessionId);
       console.log(`[DELETE_SESSION] Index before: ${index.length} sessions, after: ${filteredIndex.length} sessions`);
       
       // Save the updated index
       const data = JSON.stringify(filteredIndex, null, 2);
       fs.writeFileSync(indexPath, data, 'utf-8');
       console.log(`[DELETE_SESSION] Index updated and saved successfully`);
       
       // 5. Also check for orphaned files (cleanup)
       if (sessionExistsInIndex && !fs.existsSync(filePath)) {
         console.log(`[DELETE_SESSION] Note: Session ${sessionId} was in index but file was already missing`);
       }
       
       return true;
     } catch (error) {
       console.error(`[DELETE_SESSION] Failed to delete session ${sessionId} atomically:`, error);
       return false;
     }
   }

   // Keep old method for backward compatibility (deprecated)
   private _deleteSessionFile(sessionId: string): boolean {
     console.warn(`_deleteSessionFile is deprecated, use _deleteSessionAtomically instead`);
     return this._deleteSessionAtomically(sessionId);
   }

  private _migrateFromGlobalState(): void {
    try {
      const saved = this._context.globalState.get<string>('chatSessions');
      if (!saved) {
        return;
      }
      
      const sessions = JSON.parse(saved);
      if (!Array.isArray(sessions)) {
        return;
      }
      
      sessions.forEach(session => {
        if (session.id && session.messages) {
          this._saveSession(session);
        }
      });
      
      console.log(`Migrated ${sessions.length} sessions to file system storage`);
    } catch (error) {
      console.warn('Failed to migrate sessions from globalState:', error);
    }
  }

  private _loadSessions() {
    try {
      // First try to load from file system
      this._ensureStorageDirs();
      
      const index = this._loadSessionsIndex();
      this._sessions = index;
      
      if (index.length > 0) {
        // Find active session or create default one
        const activeSession = index.find(s => s.isActive);
        if (activeSession) {
          const loadedSession = this._loadSession(activeSession.id);
          if (loadedSession) {
            this._currentSessionId = loadedSession.id;
            this._messages = loadedSession.messages;
          } else {
            this._createDefaultSession();
          }
        } else {
          // Load the first session
          const firstSession = this._loadSession(index[0].id);
          if (firstSession) {
            this._currentSessionId = firstSession.id;
            this._messages = firstSession.messages;
          } else {
            this._createDefaultSession();
          }
        }
      } else {
        // Check globalState for migration
        const hasGlobalStateData = this._context.globalState.get<string>('chatSessions');
        if (hasGlobalStateData) {
          this._migrateFromGlobalState();
          // Reload after migration
          const newIndex = this._loadSessionsIndex();
          if (newIndex.length > 0) {
            const firstSession = this._loadSession(newIndex[0].id);
            if (firstSession) {
              this._currentSessionId = firstSession.id;
              this._messages = firstSession.messages;
              this._sessions = newIndex;
            } else {
              this._createDefaultSession();
            }
          } else {
            this._createDefaultSession();
          }
        } else {
          this._createDefaultSession();
        }
      }
    } catch (error) {
      console.warn('Failed to load sessions:', error);
      this._createDefaultSession();
    }
  }

  private _createDefaultSession() {
    const defaultSession: ChatSession = {
      id: 'default',
      title: 'New Conversation',
      created: Date.now(),
      updated: Date.now(),
      messages: [],
      isActive: true
    };
    
    this._saveSession(defaultSession);
    this._sessions = this._loadSessionsIndex();
    this._currentSessionId = 'default';
    this._messages = [];
  }

  private _saveSessions() {
    try {
      // Update current session
      const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
      if (currentSession) {
        currentSession.messages = this._messages;
        currentSession.updated = Date.now();
        // Ensure only one active session
        this._sessions.forEach(s => s.isActive = s.id === this._currentSessionId);
      }
      
      // Save all sessions to file system
      this._sessions.forEach(session => {
        // For index sessions (without messages), we need to get the full session
        if (session.messages === undefined || session.messages.length === 0) {
          const fullSession = this._loadSession(session.id);
          if (fullSession) {
            session.messages = fullSession.messages;
          } else {
            session.messages = [];
          }
        }
        this._saveSession(session);
      });
      
      // Also update globalState for backward compatibility
      this._context.globalState.update('chatSessions', JSON.stringify(this._sessions));
    } catch (error) {
      console.warn('Failed to save sessions:', error);
    }
  }

  private _addMessage(message: ChatMessage) {
    this._messages.push(message);
    this._saveCurrentSession();
  }

  /** 仅持久化当前 session（比 _saveSessions 快得多，避免遍历全部 session）。 */
  private _saveCurrentSession() {
    try {
      const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
      if (currentSession) {
        currentSession.messages = this._messages;
        currentSession.updated = Date.now();
        this._sessions.forEach(s => s.isActive = s.id === this._currentSessionId);
        this._saveSession(currentSession);
        // 同步 globalState（兼容旧逻辑，不读磁盘）
        this._context.globalState.update('chatSessions', JSON.stringify(this._sessions));
      }
    } catch (error) {
      console.warn('Failed to save current session:', error);
    }
  }

  private _getApiConfig(): ApiConfig {
    const cfg = vscode.workspace.getConfiguration('vibe-coding');
    const apiKey = cfg.get<string>('apiKey', '');
    if (!apiKey) {
      throw new Error('API key not configured. Please set vibe-coding.apiKey in Settings.');
    }
    return {
      baseUrl: cfg.get<string>('apiBaseUrl', 'https://api.openai.com/v1'),
      apiKey,
      model: cfg.get<string>('model', 'gpt-4o'),
      confirmChanges: cfg.get<boolean>('confirmChanges', true),
      maxInteractions: cfg.get<number>('maxInteractions', -1),
      maxSequenceLength: cfg.get<number>('maxSequenceLength', 2000),
    };
  }

  public clearHistory() {
    this._messages = [];
    this._todoList = null;
    // Update current session messages
    const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
    if (currentSession) {
      currentSession.messages = [];
      currentSession.updated = Date.now();
      this._saveSessions();
    }
  }

  private async _createNewSession() {
    this._todoList = null;
    const newSession: ChatSession = {
      id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: `New Conversation ${this._sessions.length + 1}`,
      created: Date.now(),
      updated: Date.now(),
      messages: [],
      isActive: false
    };
    
    // Save the new session to file system
    this._saveSession(newSession);
    
    // Update sessions list
    this._sessions = this._loadSessionsIndex();
    await this._switchSession(newSession.id);
  }

  private async _switchSession(sessionId: string, skipSavingCurrent: boolean = false) {
    // Save current session messages before switching (unless skipped)
    if (this._currentSessionId && !skipSavingCurrent) {
      const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
      if (currentSession) {
        currentSession.messages = this._messages;
        currentSession.updated = Date.now();
        currentSession.isActive = false;
        this._saveSession(currentSession);
      }
    }

    // Switch to new session
    const newSession = this._sessions.find(s => s.id === sessionId);
    if (newSession) {
      this._currentSessionId = sessionId;
      
      // Load messages from file system
      const loadedSession = this._loadSession(sessionId);
      if (loadedSession) {
        this._messages = loadedSession.messages;
      } else {
        this._messages = [];
        console.warn(`Failed to load session ${sessionId} from file system`);
      }
      
      newSession.isActive = true;
      
      // Update all sessions in index to reflect active state
      this._sessions.forEach(s => s.isActive = s.id === sessionId);
      
      // Only save sessions if we're not skipping saving (like during deletion)
      if (!skipSavingCurrent) {
        this._saveSessions();
      }
      
      // Update UI
      this._post({ type: 'clearMessages' });
      this._postSessionsList();
       for (const saved of this._messages) {
          if (saved.role === 'user') {
            this._post({
              type: 'addMessage',
              message: { role: saved.role, content: saved.content },
            });
          } else if (saved.role === 'assistant' && saved.tool_calls) {
            // 处理包含 tool_calls 的助手消息
            // 先显示助手的内容（如果有）
            if (saved.content) {
              this._post({
                type: 'addMessage',
                message: { role: saved.role, content: saved.content },
              });
            }
            // 为每个 tool call 发送 toolCall 消息
            for (const toolCall of saved.tool_calls) {
              const name = toolCall.function.name;
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(toolCall.function.arguments);
              } catch {
                // keep empty
              }
              this._post({
                type: 'toolCall',
                name,
                args,
              });
            }
          } else if (saved.role === 'assistant' && saved.content) {
            // 普通助手消息
            this._post({
              type: 'addMessage',
              message: { role: saved.role, content: saved.content },
            });
          } else if (saved.role === 'tool' && saved.tool_call_id && saved.content) {
            // 处理 tool 角色消息，发送 toolResult 消息
            let toolName = 'unknown';
            // 向后查找最近的助手消息中的 tool_call
            for (let i = this._messages.indexOf(saved) - 1; i >= 0; i--) {
              const prevMsg = this._messages[i];
              if (prevMsg.role === 'assistant' && prevMsg.tool_calls) {
                const matchingCall = prevMsg.tool_calls.find(
                  tc => tc.id === saved.tool_call_id
                );
                if (matchingCall) {
                  toolName = matchingCall.function.name;
                  break;
                }
              }
            }
            this._post({
              type: 'toolResult',
              name: toolName,
              result: saved.content,
            });
          }
        }
    }
  }

   /**
    * Delete a session with comprehensive error handling and atomic operations.
    * This method ensures that the file system and memory states remain consistent.
    */
   private async _deleteSession(sessionId: string): Promise<void> {
     try {
       // 1. Validate input and check constraints
       if (!sessionId || sessionId.trim() === '') {
         vscode.window.showErrorMessage('Cannot delete: Invalid session ID');
         return;
       }
       
       if (this._sessions.length <= 1) {
         vscode.window.showWarningMessage('Cannot delete the only conversation');
         return;
       }
       
       // 2. Find the session to delete
       const sessionToDelete = this._sessions.find(s => s.id === sessionId);
       if (!sessionToDelete) {
         console.warn(`[DELETE] Session ${sessionId} not found in memory`);
         vscode.window.showWarningMessage('Conversation not found');
         return;
       }

       // Confirm deletion
       const answer = await vscode.window.showWarningMessage(
         `Delete conversation "${sessionToDelete.title}"? This cannot be undone.`,
         { modal: true },
         'Delete'
       );
       if (answer !== 'Delete') return;
       
       console.log(`[DELETE] Deleting session: id=${sessionId}, title="${sessionToDelete.title}"`);
       console.log(`[DELETE] Current session: ${this._currentSessionId}, deleting current: ${sessionId === this._currentSessionId}`);
       
       // 3. If deleting current session, switch to another one first
       let sessionSwitchSuccess = true;
       if (sessionId === this._currentSessionId) {
         console.log(`[DELETE] Deleting current session, looking for alternative...`);
         const otherSession = this._sessions.find(s => s.id !== sessionId);
         if (otherSession) {
           console.log(`[DELETE] Switching to session: ${otherSession.id} (${otherSession.title})`);
           try {
             await this._switchSession(otherSession.id, true);
           } catch (switchError) {
             console.error(`[DELETE] Failed to switch session:`, switchError);
             sessionSwitchSuccess = false;
             vscode.window.showErrorMessage('Cannot delete current conversation: Failed to switch to another session');
             return;
           }
         } else {
           vscode.window.showErrorMessage('Cannot delete current conversation: No other conversation available');
           return;
         }
       }
       
       // 4. Perform atomic deletion (file + index) BEFORE updating memory
       console.log(`[DELETE] Performing atomic deletion...`);
       const deletionSuccessful = this._deleteSessionAtomically(sessionId);
       
       if (!deletionSuccessful) {
         throw new Error('Failed to delete conversation files');
       }
       
       // 5. Update memory state only after successful file system operation
       const originalSessionCount = this._sessions.length;
       this._sessions = this._sessions.filter(s => s.id !== sessionId);
       
       // 6. Update globalState for backward compatibility
       try {
         this._context.globalState.update('chatSessions', JSON.stringify(this._sessions));
       } catch (globalStateError) {
         console.warn(`[DELETE] Failed to update globalState:`, globalStateError);
         // Continue since file system operation already succeeded
       }
       
       // 7. Update UI
       this._postSessionsList();
       
       // 8. Show success message
       console.log(`[DELETE] Session ${sessionId} deleted successfully. Remaining: ${this._sessions.length}/${originalSessionCount} sessions`);
       vscode.window.showInformationMessage(`Conversation "${sessionToDelete.title}" deleted`);
       
      } catch (error: any) {
        // 9. Comprehensive error handling
        console.error(`[DELETE] Failed to delete session ${sessionId}:`, error);
        
        // Provide user-friendly error message
        let errorMessage = 'Failed to delete conversation';
        if (error.code === 'ENOENT') {
          errorMessage = 'Conversation file not found';
        } else if (error.code === 'EACCES') {
          errorMessage = 'Permission denied: Unable to delete conversation';
        } else if (error.message) {
          errorMessage = `Failed to delete conversation: ${error.message}`;
        }
        
        // Show detailed error in chat for better debugging
        this._post({
          type: 'addMessage',
          message: {
            role: 'system',
            content: `❌ Error: ${errorMessage} (session: ${sessionId})`
          }
        });
        
        // Also show error notification
        vscode.window.showErrorMessage(errorMessage);
        
        // Try to restore UI consistency by refreshing session list
        try {
          // Reload sessions from file system to ensure consistency
          const reloadedSessions = this._loadSessionsIndex();
          if (reloadedSessions.length > 0) {
            this._sessions = reloadedSessions;
            this._postSessionsList();
          }
        } catch (reloadError) {
          console.warn(`[DELETE] Failed to reload sessions after error:`, reloadError);
        }
      }
   }

  private async _updateSessionTitle(sessionId: string, title: string) {
    const session = this._sessions.find(s => s.id === sessionId);
    if (session) {
      session.title = title || session.title;
      session.updated = Date.now();
      this._saveSessions();
      this._postSessionsList();
    }
  }

  private _postSessionsList() {
    console.log(`[DEBUG] Posting ${this._sessions.length} sessions to UI`);
    this._sessions.forEach((s, i) => {
      console.log(`  [${i}] id=${s.id}, title="${s.title}", messages=${s.messages?.length || 0}, active=${s.id === this._currentSessionId}`);
    });
    
    this._post({
      type: 'sessionsList',
      sessions: this._sessions.map(s => ({
        id: s.id,
        title: s.title,
        created: s.created,
        updated: s.updated,
        messageCount: s.messages ? s.messages.filter(m => m.role === 'user').length : 0,
        isActive: s.id === this._currentSessionId
      }))
    });
  }

  private _post(msg: unknown) {
    this._view?.webview.postMessage(msg);
  }
  // ─── HTML ──────────────────────────────────────────────────────────────────

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vibe Coding Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    overflow: hidden;
  }

  #chat-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 8px;
    gap: 8px;
  }

  #messages {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 2px;
  }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
  }

  .message-row { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
  .message-row.user  { align-items: flex-end; }
  .message-row.assistant { align-items: flex-start; }

  .message-role {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 0 4px;
  }

  .bubble {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .user .bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 4px;
  }
  .assistant .bubble {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-bottom-left-radius: 4px;
  }
  .message-row.system { align-items: flex-start; }
  .system .bubble {
    background: #1a4a1a;
    color: #fff;
    border-radius: 4px;
    font-size: 11px;
    max-width: 100%;
  }

  /* Tool call cards */
  .tool-card {
    max-width: 90%;
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 8px;
    overflow: hidden;
    font-size: 12px;
    flex-shrink: 0;
  }
  .tool-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    cursor: pointer;
    user-select: none;
  }
  .tool-header .tool-icon { font-size: 14px; }
  .tool-header .tool-name { font-weight: 600; flex: 1; }
  .tool-header .tool-status { font-size: 11px; opacity: 0.8; }
  .tool-body {
    padding: 6px 10px;
    background: var(--vscode-editor-background);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 180px;
    overflow-y: auto;
    display: none; /* collapsed by default */
  }
  .tool-body::-webkit-scrollbar { width: 6px; height: 6px; }
  .tool-body::-webkit-scrollbar-track { background: transparent; }
  .tool-body::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.5));
    border-radius: 3px;
  }
  .tool-body::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.75));
  }
  .tool-card.expanded .tool-body { display: block; }
  /* done: solid green — avoid semi-transparent gutter variables */
  .tool-card.done .tool-header {
    background: var(--vscode-testing-runAction, #388a34);
    color: #fff;
  }
  /* error: solid red */
  .tool-card.error .tool-header {
    background: var(--vscode-inputValidation-errorBorder, #be1100);
    color: #fff;
  }

  /* Input area */
  .input-area { display: flex; gap: 6px; align-items: flex-end; }
  #input {
    flex: 1;
    padding: 8px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px;
    resize: none;
    font-family: inherit;
    font-size: inherit;
    line-height: 1.4;
    max-height: 120px;
    overflow-y: auto;
  }
  #input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    border-color: transparent;
  }
  .chat-button {
    padding: 7px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    flex-shrink: 0;
    font-family: inherit;
    font-size: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
  }
  .chat-button:hover { background: var(--vscode-button-hoverBackground); }
  .chat-button:disabled { opacity: 0.45; cursor: not-allowed; }
  #send { background: var(--vscode-testing-runAction, #388a34); }
  #send:hover { background: var(--vscode-testing-runAction, #4aa844); }
  #stop { background: var(--vscode-errorForeground, #be1100); }
  #stop:hover { background: var(--vscode-errorForeground, #d52222); }

  .loading {
    font-size: 12px;
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    padding: 2px 4px;
  }
  .error-msg {
    font-size: 12px;
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    padding: 7px 10px;
    border-radius: 6px;
  }
  .info-msg {
    font-size: 12px;
    color: var(--vscode-sideBarTitle-foreground, #888);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 7px 10px;
    border-radius: 6px;
  }
  .token-usage {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    text-align: right;
    padding: 0 4px 2px;
    opacity: 0.7;
  }

   /* Session sidebar */
  #session-sidebar {
    position: fixed;
    left: -250px;
    top: 0;
    width: 250px;
    height: 100vh;
    background: var(--vscode-sideBar-background);
    border-right: 1px solid var(--vscode-sideBar-border, transparent);
    transition: left 0.2s ease;
    z-index: 100;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #session-sidebar.open {
    left: 0;
  }
  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-sideBar-border, transparent);
  }
  .sidebar-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-sideBarTitle-foreground);
  }
  .sidebar-close {
    background: transparent;
    border: none;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    font-size: 18px;
    line-height: 1;
  }
  .sidebar-close:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  #sessions-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
  .session-item {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
    border-left: 3px solid transparent;
    transition: background 0.15s;
  }
  .session-item:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .session-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    border-left-color: var(--vscode-list-activeSelectionBorder);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .session-item-content {
    flex: 1;
    min-width: 0;
  }
  .session-title {
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
  }
  .session-meta {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    justify-content: space-between;
  }
  .session-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .session-item:hover .session-actions {
    opacity: 0.7;
  }
  .session-btn {
    background: transparent;
    border: none;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
    padding: 2px;
    border-radius: 2px;
    font-size: 12px;
    line-height: 1;
  }
  .session-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .add-session-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 12px;
    margin: 8px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  .add-session-btn:hover {
    background: var(--vscode-button-hoverBackground);
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }
  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #toggle-sidebar {
    background: transparent;
    border: none;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  #toggle-sidebar:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  #clear {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    font-size: 11px;
    font-family: inherit;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 0.15s, border-color 0.15s;
  }
  #clear:hover {
    opacity: 1;
    border-color: var(--vscode-input-border, #555);
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1));
  }
  #clear:active { opacity: 0.6; }
</style>
</head>
  <div id="session-sidebar">
    <div class="sidebar-header">
      <div class="sidebar-title">Conversations</div>
      <button class="sidebar-close" title="Close sidebar">×</button>
    </div>
    <div id="sessions-list"></div>
    <button id="add-session" class="add-session-btn">
      <span>+</span> New Conversation
    </button>
  </div>
  
  <div id="chat-container">
    <div class="toolbar">
      <div class="toolbar-left">
        <button id="toggle-sidebar" title="Show conversations">
          <span>☰</span> Conversations
        </button>
      </div>
      <div class="toolbar-right">
        <button id="clear" title="Clear conversation history">🗑 Clear</button>
      </div>
    </div>
    <div id="messages"></div>
    <div class="input-area">
      <textarea id="input" rows="3" placeholder="Describe what you want to change…"></textarea>
      <button id="send" class="chat-button" title="Send message">▶</button>
      <button id="stop" class="chat-button" title="Stop current operation" disabled>■</button>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const messagesDiv = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const clearBtn = document.getElementById('clear');
  const TOOL_ICONS = {
    read_file: '📄',
    find_in_file: '🔍',
    edit: '✏️',
    create_directory: '📁',
    get_workspace_info: '📂',
  };

  // Pending tool card awaiting its result
  let pendingToolCard = null;

  function addMessage(role, content) {
    const row = document.createElement('div');
    row.className = 'message-row ' + role;

    if (role !== 'system') {
      const label = document.createElement('div');
      label.className = 'message-role';
      label.textContent = role === 'user' ? 'You' : 'Assistant';
      row.appendChild(label);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;

    row.appendChild(bubble);
    messagesDiv.appendChild(row);
    scrollBottom();
  }

   function addToolCall(name, args) {\n     const card = document.createElement('div');\n     card.className = 'tool-card'; // Default collapsed, not expanded\n\n     // Use friendly display name\n     const displayName = name === 'replace_lines' ? 'edit' : name;\n     const icon = TOOL_ICONS[name] || '🔧';\n     const argsStr = JSON.stringify(args, null, 2);\n\n     card.innerHTML =\n       '<div class=\"tool-header\">' +\n         '<span class=\"tool-icon\">' + icon + '</span>' +\n         '<span class=\"tool-name\">' + displayName + '</span>' +\n         '<span class=\"tool-status\">running…</span>' +\n       '</div>' +\n       '<div class=\"tool-body\">' + escHtml(argsStr) + '</div>';\n\n     card.querySelector('.tool-header').addEventListener('click', () => {\n       card.classList.toggle('expanded');\n     });\n\n     messagesDiv.appendChild(card);\n     scrollBottom();\n     pendingToolCard = card;\n     return card;\n   }

   function resolveToolCard(result) {\n     // Find the most recent tool card that is still in running state\n     let card = pendingToolCard;\n     \n     if (!card) {\n       // If no pendingToolCard, look for any running tool card\n       const allCards = document.querySelectorAll('.tool-card');\n       for (let i = allCards.length - 1; i >= 0; i--) {\n         const c = allCards[i];\n         if (!c.classList.contains('done') && !c.classList.contains('error')) {\n           card = c;\n           break;\n         }\n       }\n     }\n     \n     pendingToolCard = null;\n     if (!card) { return; }\n\n     let parsed;\n     try { parsed = JSON.parse(result); } catch { parsed = { raw: result }; }\n\n     const isError = parsed && (parsed.error || parsed.success === false);\n     card.classList.remove('expanded');\n     card.classList.add(isError ? 'error' : 'done');\n\n     const statusEl = card.querySelector('.tool-status');\n     if (statusEl) {\n       statusEl.textContent = isError\n         ? ('error: ' + (parsed.error || parsed.message || '?'))\n         : (parsed.message || 'done');\n     }\n\n     const body = card.querySelector('.tool-body');\n     if (body) {\n       body.textContent = JSON.stringify(parsed, null, 2);\n     }\n     scrollBottom();\n   }

  function showLoading(show) {
    let el = document.getElementById('loading');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'loading';
        el.className = 'loading';
        el.textContent = 'Thinking…';
        messagesDiv.appendChild(el);
      }
      scrollBottom();
      sendBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      if (el) { el.remove(); }
      sendBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  function setRunningState(running) {
    sendBtn.disabled = running;
    stopBtn.disabled = !running;
  }

  function showInfo(msg) {
    const el = document.createElement('div');
    el.className = 'info-msg';
    el.textContent = msg;
    messagesDiv.appendChild(el);
    scrollBottom();
    setTimeout(() => el.remove(), 5000);
  }

  function showError(msg) {
    const el = document.createElement('div');
    el.className = 'error-msg';
    el.textContent = msg;
    messagesDiv.appendChild(el);
    scrollBottom();
    setTimeout(() => el.remove(), 8000);
  }

  function scrollBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showTokenUsage(usage) {
    const el = document.createElement('div');
    el.className = 'token-usage';
    el.textContent =
      '↑ ' + usage.prompt_tokens +
      '  ↓ ' + usage.completion_tokens +
      '  Σ ' + usage.total_tokens + ' tokens';
    messagesDiv.appendChild(el);
    scrollBottom();
  }

   function formatTime(timestamp) {
     const date = new Date(timestamp);
     const now = new Date();
     const diff = now - date;
     
     if (diff < 24 * 60 * 60 * 1000) {
       // Today
       return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
     } else if (diff < 7 * 24 * 60 * 60 * 1000) {
       // Within a week
       const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
       return days[date.getDay()];
     } else {
       // Older
       return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
     }
   }

   function updateSessionsList(sessions) {
     const sessionsList = document.getElementById('sessions-list');
     sessionsList.innerHTML = '';
     
     sessions.forEach(session => {
       const item = document.createElement('div');
       item.className = 'session-item' + (session.isActive ? ' active' : '');
       item.dataset.id = session.id;
        item.innerHTML = '<div class="session-item-content">' +
          '<div class="session-title">' + escHtml(session.title) + '</div>' +
          '<div class="session-meta">' +
          '<span>' + session.messageCount + ' messages</span>' +
          '<span>' + formatTime(session.updated) + '</span>' +
          '</div>' +
          '</div>' +
          '<div class="session-actions">' +
          '<button class="session-btn edit-btn" title="Rename">✏️</button>' +
          '<button class="session-btn delete-btn" title="Delete">🗑</button>' +
          '</div>';
       
       // Session click
       item.addEventListener('click', (e) => {
         if (!e.target.closest('.session-actions')) {
           vscode.postMessage({ type: 'switchSession', sessionId: session.id });
         }
       });
       
       // Edit button
       const editBtn = item.querySelector('.edit-btn');
       editBtn.addEventListener('click', (e) => {
         e.stopPropagation();
         vscode.postMessage({ type: 'renameSession', sessionId: session.id, currentTitle: session.title });
       });
       
       // Delete button
       const deleteBtn = item.querySelector('.delete-btn');
       deleteBtn.addEventListener('click', (e) => {
         e.stopPropagation();
         vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
       });
       
       sessionsList.appendChild(item);
     });
   }

   // Toggle sidebar
   const sidebar = document.getElementById('session-sidebar');
   const toggleBtn = document.getElementById('toggle-sidebar');
   const closeBtn = document.querySelector('.sidebar-close');
   const addSessionBtn = document.getElementById('add-session');
   
   toggleBtn.addEventListener('click', () => {
     sidebar.classList.add('open');
   });
   
   closeBtn.addEventListener('click', () => {
     sidebar.classList.remove('open');
   });
   
   addSessionBtn.addEventListener('click', () => {
     vscode.postMessage({ type: 'newSession' });
   });

    // Notify extension that the webview is ready
    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'addMessage':   addMessage(msg.message.role, msg.message.content); break;
        case 'toolCall':     addToolCall(msg.name, msg.args); break;
        case 'toolResult':   resolveToolCard(msg.result); break;
        case 'loading':      showLoading(msg.loading); break;
        case 'error':        showError(msg.message); break;
        case 'tokenUsage':   showTokenUsage(msg.usage); break;
        case 'setRunning':   setRunningState(msg.running); break;
        case 'info':         showInfo(msg.message); break;
        case 'clearMessages':
          messagesDiv.innerHTML = '';
          pendingToolCard = null;
          break;
        case 'sessionsList':
          updateSessionsList(msg.sessions);
          break;
      }
    });

   sendBtn.addEventListener('click', () => {
     const text = input.value.trim();
     input.value = '';
     input.style.height = 'auto';
     vscode.postMessage({ type: 'sendMessage', text });
   });

   stopBtn.addEventListener('click', () => {
     vscode.postMessage({ type: 'stopOperation' });
   });

   clearBtn.addEventListener('click', () => {
     vscode.postMessage({ type: 'clearHistory' });
   });

   input.addEventListener('keydown', e => {
     if (e.key === 'Enter' && !e.shiftKey) {
       e.preventDefault();
       sendBtn.click();
     }
   });

   // Auto-grow textarea
   input.addEventListener('input', () => {
     input.style.height = 'auto';
     input.style.height = Math.min(input.scrollHeight, 120) + 'px';
   });
</script>
 </body>
</html>`;
  }
}