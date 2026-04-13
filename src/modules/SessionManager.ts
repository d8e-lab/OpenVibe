import * as vscode from 'vscode';
import { ChatMessage, ChatSession } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export class SessionManager {
  private _currentSessionId: string = 'default';
  private _sessions: ChatSession[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _post: (msg: any) => void
  ) {
    this._loadSessions();
  }

  private _ensureSessionsDir(): string {
    const sessionsDir = path.join(this._context.globalStorageUri.fsPath, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    return sessionsDir;
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
      const indexFile = path.join(sessionsDir, 'index.json');
      if (fs.existsSync(indexFile)) {
        const indexContent = fs.readFileSync(indexFile, 'utf-8');
        this._sessions = JSON.parse(indexContent);
      }
    } catch (err) {
      this._post({ type: 'error', message: `Failed to load sessions: ${err}` });
    }
  }

  private _saveSessions(): void {
    try {
      const sessionsDir = this._ensureSessionsDir();
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