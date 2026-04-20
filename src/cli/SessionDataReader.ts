import * as fs from 'fs';
import * as path from 'path';
import { ChatSession, ChatMessage } from './types';

export class SessionDataReader {
  protected sessionsDir: string;

  constructor(workspaceRoot?: string) {
    const root = workspaceRoot || process.cwd();
    const upper = path.join(root, '.OpenVibe', 'sessions');
    const lower = path.join(root, '.openvibe', 'sessions');
    // Prefer current canonical lowercase path; keep compatibility with legacy uppercase path.
    this.sessionsDir = fs.existsSync(lower) ? lower : upper;
  }

  /**
   * 检查会话目录是否存在
   */
  public hasSessionData(): boolean {
    const indexFile = path.join(this.sessionsDir, 'index.json');
    return fs.existsSync(this.sessionsDir) && fs.existsSync(indexFile);
  }

  /**
   * 获取所有会话
   */
  public getAllSessions(): ChatSession[] {
    try {
      const indexFile = path.join(this.sessionsDir, 'index.json');
      if (!fs.existsSync(indexFile)) {
        console.warn(`Session index file not found: ${indexFile}`);
        return [];
      }

      const data = fs.readFileSync(indexFile, 'utf-8');
      const sessions = JSON.parse(data) as ChatSession[];
      
      // 对会话按更新时间排序（最新的在前）
      return sessions.sort((a, b) => b.updated - a.updated);
    } catch (error) {
      console.error('Failed to read sessions:', error);
      return [];
    }
  }

  /**
   * 获取特定会话
   */
  public getSession(sessionId: string): ChatSession | null {
    const sessions = this.getAllSessions();
    return sessions.find(s => s.id === sessionId) || null;
  }

  /**
   * 获取当前活跃会话
   */
  public getActiveSession(): ChatSession | null {
    const sessions = this.getAllSessions();
    return sessions.find(s => s.isActive) || sessions[0] || null;
  }

  /**
   * 统计会话信息
   */
  public getSessionStats(): {
    total: number;
    active: number;
    totalMessages: number;
    latestUpdated: Date | null;
  } {
    const sessions = this.getAllSessions();
    const totalMessages = sessions.reduce((sum, session) => sum + (session.messages?.length || 0), 0);
    const activeSessions = sessions.filter(s => s.isActive).length;
    const latestSession = sessions[0]; // 已经按更新时间排序

    return {
      total: sessions.length,
      active: activeSessions,
      totalMessages,
      latestUpdated: latestSession ? new Date(latestSession.updated) : null
    };
  }

  /**
   * 格式化消息内容以便在终端显示
   */
  public formatMessageForTerminal(message: ChatMessage): string {
    const { role, content, tool_calls } = message;
    
    let result = '';
    
    // 角色标识
    const rolePrefix = role === 'user' ? 'User:' :
                      role === 'assistant' ? 'Assistant:' :
                      role === 'tool' ? 'Tool:' :
                      'System:';
    
    result += `${rolePrefix}\n`;
    
    // 内容
    if (content && content.trim()) {
      // 如果是JSON内容，尝试格式化
      if (content.startsWith('{') || content.startsWith('[')) {
        try {
          const parsed = JSON.parse(content);
          result += JSON.stringify(parsed, null, 2) + '';
        } catch {
          result += content + '';
        }
      } else {
        result += content + '';
      }
    }
    
    // 工具调用
    if (tool_calls && tool_calls.length > 0) {
      result += `Tools called: ${tool_calls.length}\n`;
      tool_calls.forEach((call, index) => {
        result += `  ${index + 1}. ${call.function.name}\n`;
        try {
          const args = JSON.parse(call.function.arguments);
          result += `     Args: ${JSON.stringify(args, null, 2)}\n`;
        } catch {
          result += `     Args: ${call.function.arguments}\n`;
        }
      });
    }
    
    return result;
  }

  /**
   * 获取会话中的用户消息（过滤掉工具调用和系统消息）
   */
  public getUserMessages(session: ChatSession): string[] {
    return session.messages
      .filter(msg => msg.role === 'user' && msg.content && !msg.content.includes('[继续]'))
      .map(msg => msg.content!.trim());
  }

  /**
   * 搜索会话内容
   */
  public searchSessions(query: string): Array<{session: ChatSession, matches: number}> {
    const sessions = this.getAllSessions();
    const results: Array<{session: ChatSession, matches: number}> = [];
    
    const lowerQuery = query.toLowerCase();
    
    for (const session of sessions) {
      let matchCount = 0;
      
      // 检查会话标题
      if (session.title.toLowerCase().includes(lowerQuery)) {
        matchCount++;
      }
      
      // 检查消息内容
      for (const message of session.messages) {
        if (message.content && message.content.toLowerCase().includes(lowerQuery)) {
          matchCount++;
        }
        
        // 检查工具调用
        if (message.tool_calls) {
          for (const call of message.tool_calls) {
            if (call.function.name.toLowerCase().includes(lowerQuery)) {
              matchCount++;
            }
            if (call.function.arguments.toLowerCase().includes(lowerQuery)) {
              matchCount++;
            }
          }
        }
      }
      
      if (matchCount > 0) {
        results.push({ session, matches: matchCount });
      }
    }
    
    // 按匹配数量排序
    return results.sort((a, b) => b.matches - a.matches);
  }
}
