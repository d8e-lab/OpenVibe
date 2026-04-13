import * as vscode from 'vscode';
import { ChatMessage, ChatSession } from '../types';
import * as fs from 'fs';
import * as path from 'path';

export class SessionManager {
  private _currentSessionId: string = 'default';
  private _sessions: ChatSession[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _post: (msg: string) => void
  ) {
    this._loadSessions();
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
      const sessionsDir = path.join(this._context.globalStorageUri.fsPath, 'sessions');
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
        return;
      }
      
      const indexFile = path.join(sessionsDir, 'index.json');
      if (fs.existsSync(indexFile)) {
        const indexContent = fs.readFileSync(indexFile, 'utf-8');
        this._sessions = JSON.parse(indexContent);
      }
    } catch (err) {
      this._post(`Failed to load sessions: ${err}`);
    }
  }

  private _saveSessions(): void {
    try {
      const sessionsDir = path.join(this._context.globalStorageUri.fsPath, 'sessions');
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }
      
      const indexFile = path.join(sessionsDir, 'index.json');
      fs.writeFileSync(indexFile, JSON.stringify(this._sessions, null, 2));
    } catch (err) {
      this._post(`Failed to save sessions: ${err}`);
    }
  }
}