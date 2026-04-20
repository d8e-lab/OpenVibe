#!/usr/bin/env node

import { sendChatMessage } from '../api';
import type { ApiConfig, ChatMessage } from '../types';
import { CLIManager as SessionCLIManager } from './CLIManager';
import { SessionDataWriter } from './SessionDataWriter';
import type { ChatSession } from './types';
import { CLIManager as ChatUIManager } from '../modules/CLIManager';

interface ParsedArgs {
  command: string;
  values: string[];
  flags: Set<string>;
  flagValues: Map<string, string>;
}

const CHAT_SYSTEM_PROMPT =
  'You are OpenVibe CLI Assistant. Be concise and practical. ' +
  'When uncertain, ask one short clarifying question.';

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const values: string[] = [];
  const flags = new Set<string>();
  const flagValues = new Map<string, string>();

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        const key = token.slice(0, eq);
        const value = token.slice(eq + 1);
        flags.add(key);
        flagValues.set(key, value);
      } else {
        flags.add(token);
        const next = args[i + 1];
        if (next && !next.startsWith('-')) {
          flagValues.set(token, next);
          i += 1;
        }
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      flags.add(token);
      continue;
    }
    values.push(token);
  }

  return {
    command: values[0] || '',
    values: values.slice(1),
    flags,
    flagValues,
  };
}

function readCliConfigFromEnv(): ApiConfig {
  const apiKey = process.env.OPENVIBE_API_KEY?.trim() || '';
  if (!apiKey) {
    throw new Error('Missing OPENVIBE_API_KEY.');
  }
  return {
    baseUrl: process.env.OPENVIBE_API_BASE_URL?.trim() || 'https://api.deepseek.com',
    apiKey,
    model: process.env.OPENVIBE_MODEL?.trim() || 'deepseek-reasoner',
    maxInteractions: -1,
    maxSequenceLength: 1_000_000,
  };
}

function resolveSessionByIdOrIndex(writer: SessionDataWriter, idOrIndex: string): ChatSession | null {
  const byId = writer.getSession(idOrIndex);
  if (byId) {
    return byId;
  }
  const index = parseInt(idOrIndex, 10);
  if (!Number.isNaN(index) && index > 0) {
    const sessions = writer.getAllSessions();
    return sessions[index - 1] || null;
  }
  return null;
}

function toChatHistory(session: ChatSession): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];
  for (const m of session.messages) {
    if ((m.role === 'user' || m.role === 'assistant' || m.role === 'system') && typeof m.content === 'string') {
      const content = m.content.trim();
      if (content) {
        messages.push({ role: m.role, content });
      }
    }
  }
  return messages;
}

async function runChatMode(target?: string, forceNew = false): Promise<void> {
  const config = readCliConfigFromEnv();
  const writer = new SessionDataWriter(process.cwd());
  let session: ChatSession | null = null;

  if (forceNew) {
    session = writer.createSession(`CLI Conversation ${new Date().toLocaleString()}`);
  } else if (target) {
    session = resolveSessionByIdOrIndex(writer, target);
    if (!session) {
      throw new Error(`Session not found: ${target}`);
    }
  } else {
    session = writer.getActiveSession();
    if (!session) {
      session = writer.createSession('CLI Conversation');
    }
  }

  writer.setActiveSession(session.id);
  const history = toChatHistory(session);
  const chatUi = new ChatUIManager({
    workspaceName: 'cli',
    workspacePath: process.cwd(),
  });

  chatUi.sendWorkspaceBanner();
  chatUi.post({
    type: 'addMessage',
    message: {
      role: 'system',
      content: `Session: ${session.title} (${session.id})`,
    },
  });
  chatUi.post({
    type: 'addMessage',
    message: {
      role: 'system',
      content: 'Commands: /help /exit /reset-context',
    },
  });

  try {
    while (true) {
      const text = await chatUi.readUserInput('You > ');
      if (!text) {
        continue;
      }
      const cmd = text.trim().toLowerCase();
      if (cmd === '/exit' || cmd === '/quit') {
        break;
      }
      if (cmd === '/help') {
        chatUi.post({
          type: 'addMessage',
          message: { role: 'system', content: 'Commands: /help /exit /reset-context' },
        });
        continue;
      }
      if (cmd === '/reset-context') {
        history.length = 0;
        history.push({ role: 'system', content: CHAT_SYSTEM_PROMPT });
        chatUi.post({
          type: 'addMessage',
          message: { role: 'system', content: 'Context reset for this chat run.' },
        });
        continue;
      }

      const userMsg: ChatMessage = { role: 'user', content: text };
      history.push(userMsg);
      writer.addMessage(session.id, userMsg);
      chatUi.post({ type: 'loading', loading: true });
      try {
        const res = await sendChatMessage(history, config);
        const content = (res.content || '').trim() || '(empty response)';
        const assistantMsg: ChatMessage = { role: 'assistant', content };
        history.push(assistantMsg);
        writer.addMessage(session.id, assistantMsg);
        chatUi.post({ type: 'addMessage', message: assistantMsg });
      } catch (e: any) {
        chatUi.post({ type: 'error', message: e.message || String(e) });
      } finally {
        chatUi.post({ type: 'loading', loading: false });
      }
    }
  } finally {
    chatUi.close();
  }
}

async function main(): Promise<void> {
  const cli = new SessionCLIManager();
  const { command, values, flags, flagValues } = parseArgs(process.argv);

  if (!command) {
    cli.showWelcome();
    cli.listSessions(false);
    console.log('Use "node out/cli/cli.js help" for commands.');
    return;
  }

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      cli.showHelp();
      return;

    case 'list': {
      cli.showWelcome();
      const verbose = flags.has('--verbose') || flags.has('-v');
      cli.listSessions(verbose);
      return;
    }

    case 'show': {
      cli.showWelcome();
      const idOrIndex = values[0];
      if (!idOrIndex) {
        throw new Error('Missing argument: show <id|index>');
      }
      cli.showSession(idOrIndex);
      return;
    }

    case 'stats':
      cli.showWelcome();
      cli.showStats();
      return;

    case 'search': {
      cli.showWelcome();
      const query = values[0];
      if (!query) {
        throw new Error('Missing argument: search <query>');
      }
      cli.searchSessions(query);
      return;
    }

    case 'export': {
      const sessionId = values[0];
      if (!sessionId) {
        throw new Error('Missing argument: export <id> [--text]');
      }
      const format = flags.has('--text') || flags.has('-t') ? 'text' : 'json';
      cli.exportSession(sessionId, format);
      return;
    }

    case 'chat': {
      const target = values[0] || flagValues.get('--session');
      const createNew = flags.has('--new');
      await runChatMode(target, createNew);
      return;
    }

    default:
      throw new Error(`Invalid command: ${command}`);
  }
}

main().catch((e: any) => {
  console.error(e.message || String(e));
  process.exitCode = 1;
});
