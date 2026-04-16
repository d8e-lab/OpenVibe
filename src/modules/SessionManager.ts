import * as vscode from 'vscode';
import { ChatMessage, ChatSession, AgentLogEntry } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export class SessionManager {
  private _currentSessionId: string = 'default';
  private _sessions: ChatSession[] = [];
  private _currentWorkspacePath: string | null = null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _post: (msg: any) => void
  ) {
    this._loadSessions();
    this._setupWorkspaceChangeListeners();
  }
  private _ensureSessionsDir(): string | null {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      // No workspace → do not fall back to global storage.
      // Requirement: sidebar should only reflect the current workspace folder's `.openvibe`.
      return null;
    }

    const sessionsDir = path.join(workspaceRoot, '.openvibe', 'sessions');
    // Migration: older versions stored sessions under `.OpenVibe/sessions`.
    // If the new location doesn't exist but legacy index does, copy it once.
    try {
      const legacyDir = path.join(workspaceRoot, '.OpenVibe', 'sessions');
      const legacyIndex = path.join(legacyDir, 'index.json');
      const newIndex = path.join(sessionsDir, 'index.json');
      if (!fs.existsSync(sessionsDir) && fs.existsSync(legacyIndex)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
        if (!fs.existsSync(newIndex)) {
          fs.copyFileSync(legacyIndex, newIndex);
        }
      }
    } catch {
      // non-fatal
    }
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    return sessionsDir;
  }
  private _getWorkspaceRoot(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return workspaceFolders[0].uri.fsPath;
  }

  private _setupWorkspaceChangeListeners(): void {
    // 监听工作区文件夹变化
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const newRoot = this._getWorkspaceRoot();
      const changed = newRoot !== this._currentWorkspacePath;

      // 工作区发生变化时重新加载会话（来自新工作区的 .openvibe/sessions）
      if (changed) {
        // Ensure we don't carry a previous workspace's active session selection.
        this._currentSessionId = 'default';
      }
      this._loadSessions();
      this.postSessionsList();

      // Clear chat UI when switching to a different workspace folder.
      // The new workspace should not display the previous workspace's conversation.
      if (changed) {
        this._post({ type: 'clearMessages' });
        if (newRoot) {
          this._post({
            type: 'addMessage',
            message: { role: 'system', content: `Workspace changed: ${newRoot}` },
          });
        } else {
          this._post({
            type: 'addMessage',
            message: { role: 'system', content: `Workspace changed: (no workspace open)` },
          });
        }
      }
    });
  }

  private _createDefaultSession(): void {
    const defaultSession: ChatSession = {
      id: 'default',
      title: 'New Conversation',
      created: Date.now(),
      updated: Date.now(),
      messages: []
    };
    this._sessions = [defaultSession];
    this._currentSessionId = 'default';
    this._saveSessions();
  }

  public getCurrentMessages(): ChatMessage[] {
    const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
    return currentSession?.messages || [];
  }

  public getCurrentSessionId(): string {
    return this._currentSessionId;
  }

  public addMessage(msg: ChatMessage): void {
    const messages = this.getCurrentMessages();
    messages.push(msg);
    this.setCurrentMessages(messages);
  }

  public addAgentLog(entry: AgentLogEntry): void {
    let session = this._sessions.find(s => s.id === this._currentSessionId);
    if (!session) {
      session = {
        id: this._currentSessionId,
        title: 'Chat Session',
        created: Date.now(),
        updated: Date.now(),
        messages: [],
        agentLogs: [],
      };
      this._sessions.push(session);
    }
    if (!Array.isArray(session.agentLogs)) {
      session.agentLogs = [];
    }
    session.agentLogs.push(entry);
    // Keep logs bounded to avoid huge index.json growth.
    if (session.agentLogs.length > 500) {
      session.agentLogs = session.agentLogs.slice(session.agentLogs.length - 500);
    }
    session.updated = Date.now();
    this._saveSessions();
  }

  public saveCurrentSession(): void {
    this._saveSessions();
  }

  public setCurrentMessages(messages: ChatMessage[]): void {
    let session = this._sessions.find(s => s.id === this._currentSessionId);
    if (!session) {
      session = {
        id: this._currentSessionId,
        title: 'Chat Session',
        created: Date.now(),
        updated: Date.now(),
        messages: []
      };
      this._sessions.push(session);
    }
    session.messages = messages;
    session.updated = Date.now();
    this._saveSessions();
  }

  private _loadSessions(): void {
    try {
      const sessionsDir = this._ensureSessionsDir();
      const indexFile = sessionsDir ? path.join(sessionsDir, 'index.json') : null;
      
      // 重置会话列表并更新当前工作区路径
      this._sessions = [];
      this._currentWorkspacePath = this._getWorkspaceRoot();
      
      if (indexFile && fs.existsSync(indexFile)) {
        const indexContent = fs.readFileSync(indexFile, 'utf-8');
        this._sessions = JSON.parse(indexContent);
      }
      
      // 确保至少有一个默认会话
      if (this._sessions.length === 0) {
        this._createDefaultSession();
      }
    } catch (err) {
      this._post({ type: 'error', message: `Failed to load sessions: ${err}` });
    }
  }

  private _saveSessions(): void {
    try {
      const sessionsDir = this._ensureSessionsDir();
      if (!sessionsDir) {
        // No workspace open → do not persist.
        return;
      }
      const indexFile = path.join(sessionsDir, 'index.json');
      fs.writeFileSync(indexFile, JSON.stringify(this._sessions, null, 2));
    } catch (err) {
      this._post({ type: 'error', message: `Failed to save sessions: ${err}` });
    }
  }

  public postSessionsList(): void {
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

  public async switchSession(sessionId: string): Promise<void> {
    const newSession = this._sessions.find(s => s.id === sessionId);
    if (!newSession) {
      console.warn(`Session ${sessionId} not found`);
      return;
    }

    this.saveCurrentSession();
    this._currentSessionId = sessionId;
    this.postSessionsList();
  }

  public updateSessionTitle(sessionId: string, title: string): void {
    const session = this._sessions.find(s => s.id === sessionId);
    if (!session) {
      return;
    }
    session.title = title;
    session.updated = Date.now();
    this._saveSessions();
  }

  public async deleteSession(sessionId: string): Promise<boolean> {
    if (this._sessions.length <= 1) {
      console.warn('Cannot delete the only session');
      return false;
    }

    const sessionIndex = this._sessions.findIndex(s => s.id === sessionId);
    if (sessionIndex === -1) {
      console.warn(`Session ${sessionId} not found`);
      return false;
    }

    if (sessionId === this._currentSessionId) {
      const otherSession = this._sessions.find(s => s.id !== sessionId);
      if (otherSession) {
        await this.switchSession(otherSession.id);
      }
    }

    this._sessions.splice(sessionIndex, 1);
    this._saveSessions();
    this.postSessionsList();
    return true;
  }

  public async createSession(): Promise<ChatSession> {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newSession: ChatSession = {
      id: sessionId,
      title: `Conversation ${this._sessions.length + 1}`,
      created: Date.now(),
      updated: Date.now(),
      messages: [],
      isActive: true
    };
    
    // Add to sessions list
    this._sessions.push(newSession);
    
    // Save sessions
    this._saveSessions();
    
    // Switch to new session
    await this.switchSession(sessionId);
    
    return newSession;
  }

  public clearHistory(): void {
    // Clear messages in current session
    const currentSession = this._sessions.find(s => s.id === this._currentSessionId);
    if (currentSession) {
      currentSession.messages = [];
      currentSession.updated = Date.now();
      this._saveSessions();
    }
  }
}