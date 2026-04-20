import { SessionDataReader } from './SessionDataReader';
import { ChatSession } from './types';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function color(text: string, code: string): string {
  return `${code}${text}${ANSI.reset}`;
}

export class CLIManager {
  private readonly sessionReader: SessionDataReader;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot?: string) {
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.sessionReader = new SessionDataReader(this.workspaceRoot);
  }

  public isInOpenVibeWorkspace(): boolean {
    return this.sessionReader.hasSessionData();
  }

  public showWelcome(): void {
    console.log(color('OpenVibe CLI - Session History Viewer', ANSI.bold));
    console.log(color('----------------------------------------', ANSI.gray));

    if (!this.isInOpenVibeWorkspace()) {
      console.log(color('No OpenVibe session data found.', ANSI.yellow));
      console.log(color('Expected .openvibe/sessions or .OpenVibe/sessions.', ANSI.gray));
      console.log(color(`Current directory: ${this.workspaceRoot}`, ANSI.gray));
      return;
    }

    const stats = this.sessionReader.getSessionStats();
    console.log(color(`Found ${stats.total} session(s), ${stats.totalMessages} messages`, ANSI.green));
    if (stats.latestUpdated) {
      console.log(color(`Latest update: ${stats.latestUpdated.toLocaleString()}`, ANSI.gray));
    }
    console.log('');
  }

  public listSessions(verbose = false): void {
    const sessions = this.sessionReader.getAllSessions();
    if (sessions.length === 0) {
      console.log(color('No sessions found.', ANSI.yellow));
      return;
    }

    console.log(color('Sessions', ANSI.bold));
    console.log(color('----------------------------------------', ANSI.gray));

    sessions.forEach((session, index) => {
      const activeMark = session.isActive ? '*' : ' ';
      const date = new Date(session.updated).toLocaleDateString();
      const messageCount = session.messages.length;
      console.log(`${activeMark} ${index + 1}. ${color(session.title, ANSI.cyan)}`);
      console.log(`  ID: ${session.id} | Messages: ${messageCount} | Updated: ${date}`);

      if (verbose && session.messages.length > 0) {
        const last = session.messages[session.messages.length - 1];
        const preview = last.content
          ? last.content.substring(0, 60) + (last.content.length > 60 ? '...' : '')
          : '(no content)';
        console.log(`  Last(${last.role}): ${preview}`);
      }
      console.log('');
    });
  }

  public showSession(sessionIdOrIndex: string): void {
    let session: ChatSession | null = this.sessionReader.getSession(sessionIdOrIndex);

    if (!session) {
      const index = parseInt(sessionIdOrIndex, 10);
      if (!Number.isNaN(index) && index > 0) {
        const sessions = this.sessionReader.getAllSessions();
        session = sessions[index - 1] || null;
      }
    }

    if (!session) {
      console.log(color(`Session "${sessionIdOrIndex}" not found.`, ANSI.red));
      return;
    }

    console.log(color(`Session: ${session.title}`, ANSI.bold));
    console.log(color('----------------------------------------', ANSI.gray));
    console.log(`ID: ${session.id}`);
    console.log(`Created: ${new Date(session.created).toLocaleString()}`);
    console.log(`Updated: ${new Date(session.updated).toLocaleString()}`);
    console.log(`Messages: ${session.messages.length}`);
    console.log(`Active: ${session.isActive ? 'Yes' : 'No'}`);
    if (session.snapshots && session.snapshots.length > 0) {
      console.log(`Snapshots: ${session.snapshots.length}`);
    }
    console.log('');

    if (session.messages.length === 0) {
      console.log(color('No messages in this session.', ANSI.gray));
      return;
    }

    session.messages.forEach((message, idx) => {
      console.log(color(`[${idx + 1}/${session.messages.length}]`, ANSI.gray));
      const formatted = this.sessionReader.formatMessageForTerminal(message);
      if (message.role === 'user') {
        console.log(color(formatted, ANSI.cyan));
      } else if (message.role === 'assistant') {
        console.log(color(formatted, ANSI.green));
      } else if (message.role === 'tool') {
        console.log(color(formatted, ANSI.yellow));
      } else {
        console.log(color(formatted, ANSI.gray));
      }
      console.log('');
    });
  }

  public showStats(): void {
    const stats = this.sessionReader.getSessionStats();
    console.log(color('Session Statistics', ANSI.bold));
    console.log(color('----------------------------------------', ANSI.gray));
    console.log(`Total Sessions: ${stats.total}`);
    console.log(`Active Sessions: ${stats.active}`);
    console.log(`Total Messages: ${stats.totalMessages}`);
    if (stats.latestUpdated) {
      console.log(`Latest Update: ${stats.latestUpdated.toLocaleString()}`);
    }

    const sessions = this.sessionReader.getAllSessions();
    const counts = sessions.map((s) => s.messages.length);
    const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    const max = counts.length ? Math.max(...counts) : 0;
    const min = counts.length ? Math.min(...counts) : 0;

    console.log('');
    console.log('Message Distribution:');
    console.log(`  Average: ${avg.toFixed(1)}`);
    console.log(`  Min: ${min}`);
    console.log(`  Max: ${max}`);
  }

  public searchSessions(query: string): void {
    const results = this.sessionReader.searchSessions(query);
    console.log(color(`Search: "${query}"`, ANSI.bold));
    console.log(color('----------------------------------------', ANSI.gray));

    if (results.length === 0) {
      console.log(color('No matching sessions found.', ANSI.yellow));
      return;
    }

    console.log(color(`Found ${results.length} session(s)`, ANSI.green));
    console.log('');

    results.forEach((result, index) => {
      const { session, matches } = result;
      const label = matches === 1 ? '1 match' : `${matches} matches`;
      console.log(`${index + 1}. ${color(session.title, ANSI.cyan)}`);
      console.log(`  ID: ${session.id} | Messages: ${session.messages.length} | ${label}`);

      const userMessages = this.sessionReader.getUserMessages(session);
      if (userMessages.length > 0) {
        userMessages.slice(0, 2).forEach((msg) => {
          const preview = msg.length > 80 ? msg.substring(0, 80) + '...' : msg;
          console.log(`  - ${preview}`);
        });
      }
      console.log('');
    });
  }

  public exportSession(sessionId: string, format: 'json' | 'text' = 'json'): void {
    const session = this.sessionReader.getSession(sessionId);
    if (!session) {
      console.log(color(`Session "${sessionId}" not found.`, ANSI.red));
      return;
    }

    if (format === 'json') {
      console.log(JSON.stringify(session, null, 2));
      return;
    }

    console.log(`Session: ${session.title}`);
    console.log(color('----------------------------------------', ANSI.gray));
    console.log(`ID: ${session.id}`);
    console.log(`Created: ${new Date(session.created).toISOString()}`);
    console.log(`Updated: ${new Date(session.updated).toISOString()}`);
    console.log(`Messages: ${session.messages.length}`);
    console.log('');

    session.messages.forEach((message, index) => {
      console.log(`Message ${index + 1}`);
      console.log(`Role: ${message.role}`);
      if (message.content) {
        console.log(`Content: ${message.content}`);
      }
      if (message.tool_calls && message.tool_calls.length > 0) {
        console.log(`Tool Calls: ${message.tool_calls.length}`);
        message.tool_calls.forEach((call, callIndex) => {
          console.log(`  ${callIndex + 1}. ${call.function.name}`);
          console.log(`     Arguments: ${call.function.arguments}`);
        });
      }
      console.log('');
    });
  }

  public showHelp(): void {
    console.log(color('OpenVibe CLI - Help', ANSI.bold));
    console.log(color('----------------------------------------', ANSI.gray));
    console.log('');
    console.log('Commands:');
    console.log('  list                  List all sessions');
    console.log('  list --verbose        List sessions with message preview');
    console.log('  show <id|index>       Show detailed session view');
    console.log('  stats                 Show session statistics');
    console.log('  search <query>        Search sessions by content');
    console.log('  export <id> [--text]  Export session data');
    console.log('  chat [id|index]       Start/continue chat in a session');
    console.log('  chat --new            Start chat with a new session');
    console.log('  help                  Show this help message');
  }
}
