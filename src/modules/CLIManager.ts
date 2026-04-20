import * as readline from 'readline';
import { stdin as defaultIn, stdout as defaultOut } from 'process';

type CliMessageRole = 'user' | 'assistant' | 'system';

interface CliManagerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  workspaceName?: string;
  workspacePath?: string;
}

interface ChatLikeMessage {
  role: CliMessageRole;
  content: string | null;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  fgWhite: '\x1b[37m',
  fgGray: '\x1b[90m',
  fgRed: '\x1b[31m',
  fgYellow: '\x1b[33m',
  bgGray: '\x1b[48;5;238m',
};

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return 80;
  }
  return Math.max(40, Math.min(120, width));
}

function formatTime(now: Date): string {
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function wrapText(text: string, width: number): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const wrapped: string[] = [];
  for (const line of lines) {
    if (!line) {
      wrapped.push('');
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      wrapped.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    wrapped.push(rest);
  }
  return wrapped;
}

export class CLIManager {
  private readonly _input: NodeJS.ReadableStream;
  private readonly _output: NodeJS.WritableStream;
  private readonly _rl: readline.Interface;
  private _isRunning = false;
  private _pendingConfirm:
    | { kind: 'replace'; resolve: (approved: boolean) => void }
    | { kind: 'shell'; resolve: (approved: boolean) => void }
    | null = null;

  constructor(private readonly _options: CliManagerOptions = {}) {
    this._input = _options.input ?? defaultIn;
    this._output = _options.output ?? defaultOut;
    this._rl = readline.createInterface({
      input: this._input,
      output: this._output,
      terminal: true,
    });
  }

  public close(): void {
    this._rl.close();
  }

  public sendWorkspaceBanner(): void {
    const name = this._options.workspaceName || 'workspace';
    const path = this._options.workspacePath || '';
    const pathSuffix = path ? ` (${path})` : '';
    this._writeLine(`${ANSI.dim}Workspace: ${name}${pathSuffix}${ANSI.reset}`);
  }

  public async readUserInput(prompt = 'You > '): Promise<string> {
    const answer = await this._question(prompt);
    const text = answer.trim();
    if (text) {
      this.renderUserBubble(text);
    }
    return text;
  }

  public post(message: any): void {
    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'addMessage': {
        const msg = message.message as ChatLikeMessage | undefined;
        if (!msg) {
          return;
        }
        this._renderChatMessage(msg);
        return;
      }
      case 'toolCall': {
        const name = String(message.name || 'tool');
        this._writeLine(`${ANSI.dim}[tool] start ${name}${ANSI.reset}`);
        return;
      }
      case 'toolResult': {
        const name = String(message.name || 'tool');
        const result = typeof message.result === 'string' ? message.result : JSON.stringify(message.result);
        this._writeLine(`${ANSI.dim}[tool] done ${name}${ANSI.reset}`);
        this._writeLine(this._compactJson(result));
        return;
      }
      case 'loading': {
        if (message.loading) {
          this._writeLine(`${ANSI.dim}thinking...${ANSI.reset}`);
        }
        return;
      }
      case 'setRunning': {
        this._isRunning = !!message.running;
        return;
      }
      case 'info': {
        this._writeLine(`${ANSI.fgGray}${String(message.message || '')}${ANSI.reset}`);
        return;
      }
      case 'error': {
        this._writeLine(`${ANSI.fgRed}${String(message.message || '')}${ANSI.reset}`);
        return;
      }
      case 'requestReplaceConfirm': {
        const request = message.data as { filePath?: string; startLine?: number; endLine?: number } | undefined;
        const target = request?.filePath || 'unknown file';
        const range =
          typeof request?.startLine === 'number' && typeof request?.endLine === 'number'
            ? ` lines ${request.startLine}-${request.endLine}`
            : '';
        this._writeLine(`${ANSI.fgYellow}Confirm edit:${ANSI.reset} ${target}${range}`);
        return;
      }
      case 'requestShellConfirm': {
        const cmd = String(message.data?.command || '');
        this._writeLine(`${ANSI.fgYellow}Confirm shell command:${ANSI.reset} ${cmd}`);
        return;
      }
      default:
        return;
    }
  }

  public async userConfirmReplace(): Promise<boolean> {
    if (this._pendingConfirm) {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      this._pendingConfirm = { kind: 'replace', resolve };
      this._question('Apply edit? [y/N] ').then((v) => {
        const approved = /^y(es)?$/i.test(v.trim());
        this._pendingConfirm = null;
        resolve(approved);
      });
    });
  }

  public async userConfirmShellCommand(command: string): Promise<boolean> {
    if (this._pendingConfirm) {
      return false;
    }
    this._writeLine(`${ANSI.dim}Command: ${command}${ANSI.reset}`);
    return await new Promise<boolean>((resolve) => {
      this._pendingConfirm = { kind: 'shell', resolve };
      this._question('Run command? [y/N] ').then((v) => {
        const approved = /^y(es)?$/i.test(v.trim());
        this._pendingConfirm = null;
        resolve(approved);
      });
    });
  }

  public renderUserBubble(text: string): void {
    const width = clampWidth((this._output as any).columns || 80) - 8;
    const lines = wrapText(text, Math.max(10, width));
    const padWidth = Math.max(...lines.map((l) => l.length), 10);
    const horizontal = ' '.repeat(padWidth + 2);
    this._writeLine(`${ANSI.bgGray}${horizontal}${ANSI.reset}`);
    for (const line of lines) {
      const padded = `${line}${' '.repeat(padWidth - line.length)}`;
      this._writeLine(`${ANSI.bgGray} ${padded} ${ANSI.reset}`);
    }
    this._writeLine(`${ANSI.bgGray}${horizontal}${ANSI.reset}`);
  }

  private _renderChatMessage(msg: ChatLikeMessage): void {
    const content = msg.content ?? '';
    if (!content) {
      return;
    }

    if (msg.role === 'user') {
      this.renderUserBubble(content);
      return;
    }

    const time = formatTime(new Date());
    if (msg.role === 'assistant') {
      this._writeLine(`${ANSI.bold}Assistant${ANSI.reset} ${ANSI.dim}${time}${ANSI.reset}`);
      this._writeLine(content);
      return;
    }

    this._writeLine(`${ANSI.dim}${content}${ANSI.reset}`);
  }

  private _writeLine(line: string): void {
    this._output.write(line + '\n');
  }

  private _compactJson(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }

  private async _question(prompt: string): Promise<string> {
    return await new Promise<string>((resolve) => {
      this._rl.question(prompt, (answer) => resolve(answer));
    });
  }
}

