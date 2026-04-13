import * as vscode from 'vscode';
import { MessageHandler } from './MessageHandler';
import { ToolExecutor } from './ToolExecutor';
import { SessionManager } from './SessionManager';
import { UIManager } from './UIManager';
import { ConversationService } from './ConversationService';
import { gitRollbackTool, listGitSnapshotsTool } from '../tools';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vibeCodingChat';

  private _messageHandler: MessageHandler;
  private _toolExecutor: ToolExecutor;
  private _sessionManager: SessionManager;
  private _uiManager: UIManager;
  private _conversation: ConversationService;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {
    this._uiManager = new UIManager(_context);

    this._sessionManager = new SessionManager(_context, (msg: any) => this._uiManager.post(msg));

    this._conversation = new ConversationService(
      this._sessionManager,
      () => this._uiManager.getApiConfig(),
      (msg) => this._uiManager.post(msg)
    );

    this._toolExecutor = new ToolExecutor({
      post: (msg) => this._uiManager.post(msg),
      llmCheckReplace: (ctx) => this._uiManager.llmCheckReplace(ctx),
      userConfirmReplace: (ctx) => this._uiManager.userConfirmReplace(ctx),
      getApiConfig: () => this._uiManager.getApiConfig(),
    });

    this._messageHandler = new MessageHandler({
      getApiConfig: () => this._uiManager.getApiConfig(),
      post: (msg) => this._uiManager.post(msg),
      buildMessagesForLlm: (systemPrompt) => this._conversation.buildMessagesForLlm(systemPrompt),
      addMessage: (msg) => this._conversation.addMessage(msg),
      getCurrentSessionId: () => this._conversation.getCurrentSessionId(),
      saveCurrentSession: () => this._conversation.saveCurrentSession(),
      sanitizeIncompleteToolCalls: () => this._conversation.sanitizeIncompleteToolCalls(),
      executeTool: (name, args) => this._toolExecutor.executeTool(name, args),
      compactHistory: (triggeredByTokenLimit) => this._conversation.compactHistory(triggeredByTokenLimit),
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
        this._replayWebview();
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
        this._uiManager.post({ type: 'clearMessages' });
        this._replayWebview();
      }
      if (msg.type === 'deleteSession') {
        const wasCurrent = this._sessionManager.getCurrentSessionId() === msg.sessionId;
        const deleted = await this._sessionManager.deleteSession(msg.sessionId);
        if (deleted && wasCurrent) {
          this._uiManager.post({ type: 'clearMessages' });
          this._replayWebview();
        }
      }
      if (msg.type === 'updateSessionTitle') {
        await this._updateSessionTitle(msg.sessionId, msg.title);
      }
      if (msg.type === 'renameSession') {
        const newTitle = await vscode.window.showInputBox({
          title: 'Rename conversation',
          value: msg.currentTitle ?? '',
          validateInput: (v) => (v?.trim() ? undefined : 'Title cannot be empty'),
        });
        if (newTitle?.trim()) {
          this._sessionManager.updateSessionTitle(msg.sessionId, newTitle.trim());
          this._sessionManager.postSessionsList();
        }
      }
      if (msg.type === 'showSnapshots') {
        await this._showGitSnapshots();
      }
      if (msg.type === 'rollbackToSnapshot') {
        await this._rollbackToSnapshot(msg.snapshot);
      }
    });
  }

  private _replayWebview(): void {
    this._conversation.replaySessionToWebview((m) => this._uiManager.post(m));
  }

  private async _createNewSession(): Promise<void> {
    await this._sessionManager.createSession();
    this._uiManager.post({ type: 'clearMessages' });
    this._replayWebview();
  }

  private async _updateSessionTitle(sessionId: string, title: string): Promise<void> {
    this._sessionManager.updateSessionTitle(sessionId, title);
    this._sessionManager.postSessionsList();
  }

  private async _showGitSnapshots(): Promise<void> {
    try {
      const result = listGitSnapshotsTool();
      const parsed = JSON.parse(result);

      if (parsed.error) {
        this._uiManager.post({ type: 'info', message: `Failed to list snapshots: ${parsed.error}` });
        return;
      }

      this._uiManager.post({
        type: 'snapshotsList',
        snapshots: parsed.snapshots ?? [],
      });
    } catch (error: any) {
      this._uiManager.post({ type: 'info', message: `Error showing snapshots: ${error.message}` });
    }
  }

  private async _rollbackToSnapshot(snapshot: {
    tag: string;
    snapshotId: string;
    userInstruction: string;
  }): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      `Roll back to before: "${snapshot.userInstruction}"?

Uncommitted changes will be lost.`,
      { modal: true },
      'Roll back',
      'Cancel'
    );

    if (confirmation !== 'Roll back') {
      return;
    }

    try {
      const result = gitRollbackTool({
        snapshotId: snapshot.snapshotId,
        sessionId: this._sessionManager.getCurrentSessionId(),
      });

      const parsed = JSON.parse(result);

      if (!parsed.success) {
        this._uiManager.post({ type: 'error', message: `Rollback failed: ${parsed.error}` });
        return;
      }

      const instruction = snapshot.userInstruction;
      this._conversation.truncateBeforeUserMessage(instruction);

      this._uiManager.post({ type: 'clearMessages' });
      this._replayWebview();

      this._uiManager.post({
        type: 'info',
        message: `✅ Rolled back to before: "${instruction.substring(0, 60)}${instruction.length > 60 ? '…' : ''}"`,
      });
    } catch (error: any) {
      this._uiManager.post({ type: 'error', message: `Rollback error: ${error.message}` });
    }
  }

  public clearHistory(): void {
    this._toolExecutor.clearTodoList();
    this._sessionManager.clearHistory();
  }

  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vibe Coding Chat</title>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
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
  }
  .bubble p { margin: 8px 0; }
  .bubble p:first-child { margin-top: 0; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble code {
    background-color: var(--vscode-textCodeBlock-background);
    color: var(--vscode-textPreformat-foreground);
    padding: 2px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
    font-size: 0.9em;
  }
  .bubble pre {
    background-color: var(--vscode-textCodeBlock-background);
    color: var(--vscode-textPreformat-foreground);
    padding: 8px 12px;
    border-radius: 4px;
    overflow-x: auto;
    margin: 8px 0;
    font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
    font-size: 0.9em;
  }
  .bubble pre code { background-color: transparent; padding: 0; border-radius: 0; font-size: 1em; }
  .bubble ul, .bubble ol { padding-left: 24px; margin: 8px 0; }
  .bubble li { margin: 4px 0; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6 { margin: 16px 0 8px 0; font-weight: 600; }
  .bubble h1 { font-size: 1.5em; }
  .bubble h2 { font-size: 1.3em; }
  .bubble h3 { font-size: 1.2em; }
  .bubble h4 { font-size: 1.1em; }
  .bubble h5, .bubble h6 { font-size: 1em; }
  .bubble blockquote {
    border-left: 3px solid var(--vscode-input-border);
    margin: 8px 0; padding-left: 12px;
    color: var(--vscode-descriptionForeground); font-style: italic;
  }
  .bubble table { border-collapse: collapse; margin: 8px 0; width: 100%; }
  .bubble th, .bubble td { border: 1px solid var(--vscode-input-border); padding: 6px 8px; text-align: left; }
  .bubble th { background-color: var(--vscode-list-hoverBackground); font-weight: 600; }
  .bubble a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .bubble a:hover { text-decoration: underline; }

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
    background: #1a4a1a; color: #fff;
    border-radius: 4px; font-size: 11px; max-width: 100%;
  }

  /* Tool call cards */
  .tool-card {
    max-width: 90%;
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 8px; overflow: hidden; font-size: 12px; flex-shrink: 0;
  }
  .tool-header {
    display: flex; align-items: center; gap: 6px; padding: 5px 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    cursor: pointer; user-select: none;
  }
  .tool-header .tool-icon { font-size: 14px; }
  .tool-header .tool-name { font-weight: 600; flex: 1; }
  .tool-header .tool-status { font-size: 11px; opacity: 0.8; }
  .tool-body {
    padding: 6px 10px;
    background: var(--vscode-editor-background);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; white-space: pre-wrap; word-break: break-all;
    max-height: 180px; overflow-y: auto; display: none;
  }
  .tool-body::-webkit-scrollbar { width: 6px; height: 6px; }
  .tool-body::-webkit-scrollbar-track { background: transparent; }
  .tool-body::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.5));
    border-radius: 3px;
  }
  .tool-card.expanded .tool-body { display: block; }
  .tool-card.done .tool-header { background: var(--vscode-testing-runAction, #388a34); color: #fff; }
  .tool-card.error .tool-header { background: var(--vscode-inputValidation-errorBorder, #be1100); color: #fff; }

  /* Check cards */
  .check-card {
    max-width: 90%;
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 8px; overflow: hidden; font-size: 12px; flex-shrink: 0; margin: 8px 0;
  }
  .check-card.confirmed .check-header { background: var(--vscode-testing-runAction, #388a34); color: #fff; }
  .check-card.rejected .check-header { background: var(--vscode-inputValidation-errorBorder, #be1100); color: #fff; }
  .check-header {
    display: flex; align-items: center; gap: 6px; padding: 5px 10px;
    cursor: pointer; user-select: none;
  }
  .check-header .check-icon { font-size: 14px; }
  .check-header .check-title { font-weight: 600; flex: 1; }
  .check-header .check-status { font-size: 11px; opacity: 0.9; }
  .check-meta {
    display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 10px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: 10px; border-top: 1px solid var(--vscode-input-border, transparent);
  }
  .check-meta .file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .check-body { padding: 8px 10px; background: var(--vscode-editor-background); font-size: 11px; line-height: 1.4; display: none; }
  .check-card.expanded .check-body { display: block; }
  .reason-section { margin-bottom: 8px; }
  .reason-section strong { display: inline-block; margin-right: 4px; }

  /* Input area */
  .input-area { display: flex; gap: 6px; align-items: flex-end; }
  #input {
    flex: 1; padding: 8px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px; resize: none; font-family: inherit; font-size: inherit;
    line-height: 1.4; max-height: 120px; overflow-y: auto;
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
  .chat-button {
    padding: 7px 14px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; cursor: pointer; flex-shrink: 0;
    font-family: inherit; font-size: inherit;
    display: flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
  }
  .chat-button:hover { background: var(--vscode-button-hoverBackground); }
  .chat-button:disabled { opacity: 0.45; cursor: not-allowed; }
  #send { background: var(--vscode-testing-runAction, #388a34); }
  #send:hover { background: var(--vscode-testing-runAction, #4aa844); }
  #stop { background: var(--vscode-errorForeground, #be1100); }
  #stop:hover { background: var(--vscode-errorForeground, #d52222); }

  .loading { font-size: 12px; font-style: italic; color: var(--vscode-descriptionForeground); padding: 2px 4px; }
  .error-msg {
    font-size: 12px; color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    padding: 7px 10px; border-radius: 6px;
  }
  .info-msg {
    font-size: 12px; color: var(--vscode-sideBarTitle-foreground, #888);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-input-border, #555);
    padding: 7px 10px; border-radius: 6px;
  }
  .token-usage {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    text-align: right; padding: 0 4px 2px; opacity: 0.7;
  }

  /* Session sidebar */
  #session-sidebar {
    position: fixed; left: -250px; top: 0; width: 250px; height: 100vh;
    background: var(--vscode-sideBar-background);
    border-right: 1px solid var(--vscode-sideBar-border, transparent);
    transition: left 0.2s ease; z-index: 100;
    display: flex; flex-direction: column; overflow: hidden;
  }
  #session-sidebar.open { left: 0; }
  .sidebar-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-sideBar-border, transparent);
  }
  .sidebar-title { font-size: 13px; font-weight: 600; color: var(--vscode-sideBarTitle-foreground); }
  .sidebar-close {
    background: transparent; border: none; color: var(--vscode-icon-foreground);
    cursor: pointer; padding: 4px; border-radius: 4px; font-size: 18px; line-height: 1;
  }
  .sidebar-close:hover { background: var(--vscode-toolbar-hoverBackground); }
  #sessions-list { flex: 1; overflow-y: auto; padding: 8px 0; }
  .session-item {
    display: flex; align-items: center; padding: 8px 12px;
    cursor: pointer; user-select: none;
    border-left: 3px solid transparent; transition: background 0.15s;
  }
  .session-item:hover { background: var(--vscode-list-hoverBackground); }
  .session-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    border-left-color: var(--vscode-list-activeSelectionBorder);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .session-item-content { flex: 1; min-width: 0; }
  .session-title { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
  .session-meta { font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; justify-content: space-between; }
  .session-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s; }
  .session-item:hover .session-actions { opacity: 0.7; }
  .session-btn {
    background: transparent; border: none; color: var(--vscode-icon-foreground);
    cursor: pointer; padding: 2px; border-radius: 2px; font-size: 12px; line-height: 1;
  }
  .session-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .add-session-btn {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 8px 12px; margin: 8px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; cursor: pointer; font-size: 12px;
  }
  .add-session-btn:hover { background: var(--vscode-button-hoverBackground); }

  /* Toolbar */
  .toolbar { display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
  .toolbar-left { display: flex; align-items: center; gap: 8px; }
  .toolbar-right { display: flex; align-items: center; gap: 8px; }
  #toggle-sidebar {
    background: transparent; border: none; color: var(--vscode-icon-foreground);
    cursor: pointer; padding: 4px 8px; border-radius: 4px;
    display: flex; align-items: center; gap: 6px; font-size: 13px;
  }
  #toggle-sidebar:hover { background: var(--vscode-toolbar-hoverBackground); }
  #clear, #snapshots {
    display: flex; align-items: center; gap: 4px; padding: 3px 8px;
    font-size: 11px; font-family: inherit;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: 1px solid transparent; border-radius: 4px; cursor: pointer;
    opacity: 0.7; transition: opacity 0.15s, border-color 0.15s;
  }
  #clear:hover, #snapshots:hover {
    opacity: 1; border-color: var(--vscode-input-border, #555);
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1));
  }

  /* Snapshot panel */
  .snapshot-panel {
    border: 1px solid var(--vscode-input-border, #555); border-radius: 6px;
    margin: 8px 0; overflow-y: auto; background: var(--vscode-editor-background);
    max-height: 300px; min-height: 100px; flex-shrink: 0;
  }
  .snapshot-panel-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 12px;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.1));
    font-size: 12px; font-weight: 600; color: var(--vscode-foreground);
  }
  .snapshot-panel-close {
    background: none; border: none; color: var(--vscode-descriptionForeground);
    cursor: pointer; font-size: 14px; line-height: 1; padding: 0 2px;
  }
  .snapshot-panel-close:hover { color: var(--vscode-foreground); }
  .snapshot-empty { padding: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
  .snapshot-item {
    display: flex; align-items: center; gap: 10px; padding: 8px 12px;
    border-top: 1px solid var(--vscode-input-border, #444); font-size: 12px;
  }
  .snapshot-item:hover { background: var(--vscode-list-hoverBackground); }
  .snapshot-meta { flex: 1; min-width: 0; }
  .snapshot-time { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 2px; }
  .snapshot-instruction { color: var(--vscode-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .snapshot-rollback-btn {
    flex-shrink: 0; padding: 3px 10px; font-size: 11px; font-family: inherit;
    background: var(--vscode-button-secondaryBackground, #3a3a3a);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 4px;
    cursor: pointer; white-space: nowrap;
  }
  .snapshot-rollback-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, #4a4a4a);
    border-color: var(--vscode-focusBorder, #007acc);
  }
</style>
</head>
<body>
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
        <button id="snapshots" title="View and rollback to Git snapshots">⏮️ Snapshots</button>
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
  const snapshotsBtn = document.getElementById('snapshots');
  const TOOL_ICONS = {
    read_file: '📄',
    find_in_file: '🔍',
    edit: '✏️',
    create_directory: '📁',
    get_workspace_info: '📂',
  };

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
    if (typeof marked !== 'undefined') {
      try {
        bubble.innerHTML = marked.parse(content);
      } catch (e) {
        bubble.textContent = content;
      }
    } else {
      bubble.textContent = content;
    }
    row.appendChild(bubble);
    messagesDiv.appendChild(row);
    scrollBottom();
  }

  function addCheckCard(data) {
    const card = document.createElement('div');
    card.className = 'check-card ' + data.verdict.toLowerCase();
    const icon = data.verdict === 'CONFIRMED' ? '✅' : '❌';
    const timeStr = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    card.innerHTML =
      '<div class="check-header">' +
        '<span class="check-icon">' + icon + '</span>' +
        '<span class="check-title">Replace check</span>' +
        '<span class="check-status">' + data.verdict + '</span>' +
      '</div>' +
      '<div class="check-meta">' +
        '<span class="file-path">' + escHtml(data.filePath) + '</span>' +
        '<span class="line-range">lines ' + data.startLine + '–' + data.endLine + '</span>' +
        '<span class="check-time">' + timeStr + '</span>' +
      '</div>' +
      '<div class="check-body">' +
        '<div class="reason-section"><strong>LLM Reason:</strong> ' + escHtml(data.reason) + '</div>' +
      '</div>';
    card.querySelector('.check-header').addEventListener('click', () => card.classList.toggle('expanded'));
    messagesDiv.appendChild(card);
    scrollBottom();
  }

  function addToolCall(name, args) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    const displayName = name === 'replace_lines' ? 'edit' : name;
    const icon = TOOL_ICONS[name] || '🔧';
    const argsStr = JSON.stringify(args, null, 2);
    card.innerHTML =
      '<div class="tool-header">' +
        '<span class="tool-icon">' + icon + '</span>' +
        '<span class="tool-name">' + escHtml(displayName) + '</span>' +
        '<span class="tool-status">running…</span>' +
      '</div>' +
      '<div class="tool-body">' + escHtml(argsStr) + '</div>';
    card.querySelector('.tool-header').addEventListener('click', () => card.classList.toggle('expanded'));
    messagesDiv.appendChild(card);
    scrollBottom();
    pendingToolCard = card;
    return card;
  }

  function resolveToolCard(result) {
    let card = pendingToolCard;
    if (!card) {
      const allCards = document.querySelectorAll('.tool-card');
      for (let i = allCards.length - 1; i >= 0; i--) {
        const c = allCards[i];
        if (!c.classList.contains('done') && !c.classList.contains('error')) {
          card = c; break;
        }
      }
    }
    pendingToolCard = null;
    if (!card) { return; }
    let parsed;
    try { parsed = JSON.parse(result); } catch { parsed = { raw: result }; }
    const isError = parsed && (parsed.error || parsed.success === false);
    card.classList.remove('expanded');
    card.classList.add(isError ? 'error' : 'done');
    const statusEl = card.querySelector('.tool-status');
    if (statusEl) { statusEl.textContent = isError ? ('error: ' + (parsed.error || parsed.message || '?')) : (parsed.message || 'done'); }
    const body = card.querySelector('.tool-body');
    if (body) { body.textContent = JSON.stringify(parsed, null, 2); }
    scrollBottom();
  }

  function showLoading(show) {
    let el = document.getElementById('loading');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'loading'; el.className = 'loading'; el.textContent = 'Thinking…';
        messagesDiv.appendChild(el);
      }
      scrollBottom(); sendBtn.disabled = true; stopBtn.disabled = false;
    } else {
      if (el) { el.remove(); }
      sendBtn.disabled = false; stopBtn.disabled = true;
    }
  }

  function setRunningState(running) { sendBtn.disabled = running; stopBtn.disabled = !running; }

  function showSnapshotsList(snapshots) {
    const old = messagesDiv.querySelector('.snapshot-panel');
    if (old) { old.remove(); }
    const panel = document.createElement('div');
    panel.className = 'snapshot-panel';
    const header = document.createElement('div');
    header.className = 'snapshot-panel-header';
    header.innerHTML = '<span>⏮️ Git Snapshots (' + snapshots.length + ')</span><button class="snapshot-panel-close" title="Close">×</button>';
    header.querySelector('.snapshot-panel-close').addEventListener('click', () => panel.remove());
    panel.appendChild(header);
    if (snapshots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'snapshot-empty';
      empty.textContent = 'No snapshots yet.';
      panel.appendChild(empty);
    } else {
      const sorted = [...snapshots].sort((a, b) => b.timestamp - a.timestamp);
      sorted.forEach(snapshot => {
        const item = document.createElement('div');
        item.className = 'snapshot-item';
        const date = new Date(snapshot.timestamp);
        const timeStr = date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const instruction = snapshot.userInstruction || snapshot.subject || snapshot.snapshotId;
        const truncated = instruction.length > 80 ? instruction.slice(0, 80) + '…' : instruction;
        item.innerHTML =
          '<div class="snapshot-meta">' +
            '<div class="snapshot-time">' + escHtml(timeStr) + ' · ' + escHtml((snapshot.commitHash || '').slice(0, 7)) + '</div>' +
            '<div class="snapshot-instruction" title="' + escHtml(instruction) + '">' + escHtml(truncated) + '</div>' +
          '</div>' +
          '<button class="snapshot-rollback-btn">↩ Rollback</button>';
        item.querySelector('.snapshot-rollback-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'rollbackToSnapshot', snapshot: { tag: snapshot.tag, snapshotId: snapshot.snapshotId, userInstruction: instruction } });
          panel.remove();
        });
        panel.appendChild(item);
      });
    }
    messagesDiv.appendChild(panel);
    scrollBottom();
  }

  function showInfo(msg) {
    const el = document.createElement('div');
    el.className = 'info-msg'; el.textContent = msg;
    messagesDiv.appendChild(el); scrollBottom();
    setTimeout(() => el.remove(), 5000);
  }

  function showError(msg) {
    const el = document.createElement('div');
    el.className = 'error-msg'; el.textContent = msg;
    messagesDiv.appendChild(el); scrollBottom();
    setTimeout(() => el.remove(), 8000);
  }

  function scrollBottom() { messagesDiv.scrollTop = messagesDiv.scrollHeight; }

  function escHtml(str) {
    if (str === null || str === undefined) { return ''; }
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showTokenUsage(usage) {
    const el = document.createElement('div');
    el.className = 'token-usage';
    el.textContent = '↑ ' + usage.prompt_tokens + '  ↓ ' + usage.completion_tokens + '  Σ ' + usage.total_tokens + ' tokens';
    messagesDiv.appendChild(el); scrollBottom();
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 24 * 60 * 60 * 1000) { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    if (diff < 7 * 24 * 60 * 60 * 1000) { return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]; }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function updateSessionsList(sessions) {
    const sessionsList = document.getElementById('sessions-list');
    sessionsList.innerHTML = '';
    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = 'session-item' + (session.isActive ? ' active' : '');
      item.dataset.id = session.id;
      item.innerHTML =
        '<div class="session-item-content">' +
          '<div class="session-title">' + escHtml(session.title) + '</div>' +
          '<div class="session-meta">' +
            '<span>' + (session.messageCount || 0) + ' messages</span>' +
            '<span>' + formatTime(session.updated) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="session-actions">' +
          '<button class="session-btn edit-btn" title="Rename">✏️</button>' +
          '<button class="session-btn delete-btn" title="Delete">🗑</button>' +
        '</div>';
      item.addEventListener('click', (e) => {
        if (!e.target.closest('.session-actions')) {
          vscode.postMessage({ type: 'switchSession', sessionId: session.id });
        }
      });
      item.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'renameSession', sessionId: session.id, currentTitle: session.title });
      });
      item.querySelector('.delete-btn').addEventListener('click', (e) => {
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

  toggleBtn.addEventListener('click', () => sidebar.classList.add('open'));
  closeBtn.addEventListener('click', () => sidebar.classList.remove('open'));
  addSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));

  // Notify extension that the webview is ready
  vscode.postMessage({ type: 'ready' });

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'snapshotsList':  showSnapshotsList(msg.snapshots); break;
      case 'addMessage':     addMessage(msg.message.role, msg.message.content); break;
      case 'addCheckCard':   addCheckCard(msg.data); break;
      case 'toolCall':       addToolCall(msg.name, msg.args); break;
      case 'toolResult':     resolveToolCard(msg.result); break;
      case 'loading':        showLoading(msg.loading); break;
      case 'error':          showError(msg.message); break;
      case 'tokenUsage':     showTokenUsage(msg.usage); break;
      case 'setRunning':     setRunningState(msg.running); break;
      case 'info':           showInfo(msg.message); break;
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
    input.value = ''; input.style.height = 'auto';
    vscode.postMessage({ type: 'sendMessage', text });
  });

  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stopOperation' }));
  clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearHistory' }));
  snapshotsBtn.addEventListener('click', () => vscode.postMessage({ type: 'showSnapshots' }));

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
</script>
</body>
</html>`;
  }
}