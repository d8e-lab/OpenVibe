import * as fs from 'fs';
import * as path from 'path';
import { ChatSession, ChatMessage } from './types';
import { SessionDataReader } from './SessionDataReader';

export class SessionDataWriter extends SessionDataReader {
  /**
   * 创建新会话
   */
  public createSession(title?: string): ChatSession {
    const sessions = this.getAllSessions();
    const newSession: ChatSession = {
      id: this.generateSessionId(),
      title: title || `Session ${sessions.length + 1}`,
      created: Date.now(),
      updated: Date.now(),
      messages: [],
      isActive: false
    };

    sessions.push(newSession);
    this.saveSessions(sessions);
    return newSession;
  }

  /**
   * 更新会话标题
   */
  public updateSessionTitle(sessionId: string, title: string): boolean {
    const sessions = this.getAllSessions();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    
    if (sessionIndex === -1) {
      return false;
    }

    sessions[sessionIndex].title = title;
    sessions[sessionIndex].updated = Date.now();
    this.saveSessions(sessions);
    return true;
  }

  /**
   * 添加消息到会话
   */
  public addMessage(sessionId: string, message: ChatMessage): boolean {
    const sessions = this.getAllSessions();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    
    if (sessionIndex === -1) {
      return false;
    }

    sessions[sessionIndex].messages.push(message);
    sessions[sessionIndex].updated = Date.now();
    this.saveSessions(sessions);
    return true;
  }

  /**
   * 设置会话为活跃状态
   */
  public setActiveSession(sessionId: string): boolean {
    const sessions = this.getAllSessions();
    
    // 清除所有会话的活跃状态
    sessions.forEach(session => {
      session.isActive = false;
    });

    // 设置指定会话为活跃
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    if (sessionIndex === -1) {
      return false;
    }

    sessions[sessionIndex].isActive = true;
    sessions[sessionIndex].updated = Date.now();
    this.saveSessions(sessions);
    return true;
  }

  /**
   * 删除会话
   */
  public deleteSession(sessionId: string): boolean {
    const sessions = this.getAllSessions();
    const initialLength = sessions.length;
    
    const filteredSessions = sessions.filter(s => s.id !== sessionId);
    
    if (filteredSessions.length === initialLength) {
      return false; // 没有删除任何会话
    }

    this.saveSessions(filteredSessions);
    return true;
  }

  /**
   * 清除会话中的所有消息
   */
  public clearSessionMessages(sessionId: string): boolean {
    const sessions = this.getAllSessions();
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    
    if (sessionIndex === -1) {
      return false;
    }

    sessions[sessionIndex].messages = [];
    sessions[sessionIndex].updated = Date.now();
    this.saveSessions(sessions);
    return true;
  }

  /**
   * 导出会话到文件
   */
  public exportSessionToFile(sessionId: string, filePath: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }

    try {
      const data = JSON.stringify(session, null, 2);
      fs.writeFileSync(filePath, data, 'utf-8');
      return true;
    } catch (error) {
      console.error('Failed to export session:', error);
      return false;
    }
  }

  /**
   * 从文件导入会话
   */
  public importSessionFromFile(filePath: string): ChatSession | null {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const session = JSON.parse(data) as ChatSession;
      
      // 验证会话结构
      if (!session.id || !session.title || !session.messages) {
        console.error('Invalid session format');
        return null;
      }

      // 生成新ID以避免冲突
      session.id = this.generateSessionId();
      session.created = Date.now();
      session.updated = Date.now();
      
      const sessions = this.getAllSessions();
      sessions.push(session);
      this.saveSessions(sessions);
      
      return session;
    } catch (error) {
      console.error('Failed to import session:', error);
      return null;
    }
  }

  /**
   * 保存会话列表到文件
   */
  private saveSessions(sessions: ChatSession[]): void {
    try {
      // 确保目录存在
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }

      const indexFile = path.join(this.sessionsDir, 'index.json');
      const data = JSON.stringify(sessions, null, 2);
      fs.writeFileSync(indexFile, data, 'utf-8');
    } catch (error) {
      console.error('Failed to save sessions:', error);
      throw error;
    }
  }

  /**
   * 生成唯一的会话ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 监听会话文件变化
   */
  public watchSessions(callback: (sessions: ChatSession[]) => void): fs.FSWatcher {
    const indexFile = path.join(this.sessionsDir, 'index.json');
    
    return fs.watch(indexFile, (eventType) => {
      if (eventType === 'change') {
        try {
          const sessions = this.getAllSessions();
          callback(sessions);
        } catch (error) {
          console.error('Error reading sessions after change:', error);
        }
      }
    });
  }

  /**
   * 获取文件最后修改时间
   */
  public getFileLastModified(): Date | null {
    const indexFile = path.join(this.sessionsDir, 'index.json');
    
    try {
      const stats = fs.statSync(indexFile);
      return stats.mtime;
    } catch {
      return null;
    }
  }

  /**
   * 检查文件是否有变化
   */
  public hasFileChanged(since: Date): boolean {
    const lastModified = this.getFileLastModified();
    if (!lastModified) {
      return false;
    }
    return lastModified > since;
  }
}