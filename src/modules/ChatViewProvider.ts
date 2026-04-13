import * as vscode from 'vscode';
import { MessageHandler } from './MessageHandler';
import { ToolExecutor } from './ToolExecutor';
import { SessionManager } from './SessionManager';
import { UIManager } from './UIManager';
import { ChatMessage, ChatSession, ToolCall } from '../types';
import { TOOL_DEFINITIONS, SYSTEM_PROMPT } from '../toolDefinitions';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vibeCodingChat';
  
  private _messageHandler: MessageHandler;
  private _toolExecutor: ToolExecutor;
  private _sessionManager: SessionManager;
  private _uiManager: UIManager;
  private _todoList: { goal: string; items: { text: string; done: boolean }[] } | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    // 初始化UIManager
    this._uiManager = new UIManager(_context, _extensionUri);
    
    // 初始化SessionManager
    this._sessionManager = new SessionManager(_context, (msg: string) => this._uiManager.post(msg));
    
    // 初始化ToolExecutor
    this._toolExecutor = new ToolExecutor({
      post: (msg) => this._uiManager.post(msg),
      llmCheckReplace: (ctx) => this._uiManager.llmCheckReplace(ctx),
      userConfirmReplace: (ctx) => this._uiManager.userConfirmReplace(ctx),
      getApiConfig: () => this._uiManager.getApiConfig(),
    });

    // 初始化MessageHandler
    this._messageHandler = new MessageHandler({
      getApiConfig: () => this._uiManager.getApiConfig(),
      post: (msg) => this._uiManager.post(msg),
      getCurrentMessages: () => this._sessionManager.getCurrentMessages(),
      addMessage: (msg) => this._sessionManager.addMessage(msg),
      getCurrentSessionId: () => this._sessionManager.getCurrentSessionId(),
      saveCurrentSession: () => this._sessionManager.saveCurrentSession(),
      sanitizeIncompleteToolCalls: () => this._sanitizeIncompleteToolCalls(),
      executeTool: (name, args) => this._toolExecutor.executeTool(name, args),
      compactHistory: (triggeredByTokenLimit) => this._compactHistory(triggeredByTokenLimit),
    });
  }

  public setOutputChannel(channel: vscode.OutputChannel): void {
    this._uiManager.setOutputChannel(channel);
  }

  // ─── WebviewViewProvider ───────────────────────────────────────────────────
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._uiManager.setView(webviewView);

    webviewView.webview.options = {
      enableScripts: true,
      enableCommandUris: true,  // 允许命令URI，用于调用VSCode命令
      localResourceRoots: [
        this._extensionUri,
        // 允许访问工作区根目录
        ...(vscode.workspace.workspaceFolders?.map(f => f.uri) || []),
        // 允许访问用户主目录（用于临时文件）
        vscode.Uri.file(require('os').homedir())
      ],
    };
    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'sendMessage') {
        await this._messageHandler.handleUserMessage(msg.text);
      }
      if (msg.type === 'ready') {
        this._uiManager.sendWorkspaceBanner();
        this._sessionManager.postSessionsList();
        this._replaySessionMessages();
      }
      if (msg.type === 'stopOperation') {
        this._messageHandler.stopCurrentOperation();
      }
      if (msg.type === 'clearHistory') {
        this.clearHistory();
        this._uiManager.post({ type: 'clearMessages' });
      }
      if (msg.type === 'newSession') {
        await this._createNewSession();
      }
      if (msg.type === 'switchSession') {
        await this._sessionManager.switchSession(msg.sessionId);
      }
      if (msg.type === 'deleteSession') {
        await this._sessionManager.deleteSession(msg.sessionId);
      }
      if (msg.type === 'updateSessionTitle') {
        await this._updateSessionTitle(msg.sessionId, msg.title);
      }
      // 其他消息处理...
    });
  }

  private _sanitizeIncompleteToolCalls(): void {
    const messages = this._sessionManager.getCurrentMessages();
    let changed = false;
    const clean: ChatMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const requiredIds = new Set(msg.tool_calls.map((tc: ToolCall) => tc.id));
        const rest = messages.slice(i + 1);
        const respondedIds = new Set(
          rest
            .filter((m: ChatMessage) => m.role === 'tool' && m.tool_call_id)
            .map((m: ChatMessage) => m.tool_call_id!)
        );

        if (!Array.from(requiredIds).every(id => respondedIds.has(id))) {
          // Drop this assistant message AND any immediately-following
          // partial tool messages, then resume from the next non-tool message.
          changed = true;
          let j = i + 1;
          while (j < messages.length && messages[j].role === 'tool') {
            j++;
          }
          i = j - 1; // loop will i++ → resumes at j
          continue;
        }
      }

      clean.push(msg);
    }

    if (changed) {
      this._sessionManager.setMessages(clean);
      this._sessionManager.saveCurrentSession();
    }
  }

  private async _compactHistory(triggeredByTokenLimit = false): Promise<string> {
    // 这个方法应该在MessageHandler中实现，这里为了完整性暂时放置
    // TODO: 将实际的压缩逻辑移到MessageHandler中
    return JSON.stringify({ success: true, message: 'Compact feature not yet implemented' });
  }

  private _replaySessionMessages(): void {
    const messages = this._sessionManager.getCurrentMessages();
    // 重放消息到UI的逻辑
    // TODO: 从SessionManager中提取这个逻辑
  }

  private async _createNewSession(): Promise<void> {
    const newSession = await this._sessionManager.createSession();
    // 更新UI等其他逻辑
  }

  private async _updateSessionTitle(sessionId: string, title: string): Promise<void> {
    // 更新会话标题的逻辑
    // TODO: 实现会话标题更新
  }

  public clearHistory(): void {
    this._todoList = null;
    this._sessionManager.clearHistory();
  }

  private _getHtml(): string {
    // 从原ChatViewProvider中复制HTML代码
    // 这里需要原chatView.ts的HTML内容
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vibe Coding Chat</title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <!-- CSS 和 JS 代码 -->
  </head>
  <body>
    <!-- HTML 结构 -->
  </body>
</html>`;
  }
}