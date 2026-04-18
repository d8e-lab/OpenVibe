import * as vscode from 'vscode';
import { getAgentRuntimeContextBlock } from '../agentRuntimeContext';
import { ApiConfig } from '../types';
import { ReplaceCheckContext, ReplaceCheckResult } from '../tools';
import { sendChatMessage } from '../api';

/** Avoid oversized webview payloads; editor open uses the same trimmed text. */
const MAX_REPLACE_CHECK_CONTEXT_CHARS = 120_000;

function languageIdFromPath(filePath: string): string {
  const i = filePath.lastIndexOf('.');
  const ext = i >= 0 ? filePath.slice(i + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'shellscript',
    ps1: 'powershell',
    cs: 'csharp',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'cpp',
    c: 'c',
  };
  return map[ext] || 'plaintext';
}

function trimForWebview(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_REPLACE_CHECK_CONTEXT_CHARS) {
    return { text: s, truncated: false };
  }
  return {
    text: s.slice(0, MAX_REPLACE_CHECK_CONTEXT_CHARS) + '\n\n… [truncated for chat view]',
    truncated: true,
  };
}

export class UIManager {
  private _view?: vscode.WebviewView;
  private _outputChannel?: vscode.OutputChannel;
  private _abortController: AbortController = new AbortController();
   private _pendingReplaceConfirms: Map<string, (approved: boolean) => void> = new Map();
   private _pendingShellConfirms: Map<string, (approved: boolean) => void> = new Map();
   private _editPermissionEnabled: boolean = true;

   constructor(private readonly _context: vscode.ExtensionContext) {}

   public setView(view: vscode.WebviewView | undefined): void {
     this._view = view;
   }

   public setOutputChannel(channel: vscode.OutputChannel): void {
     this._outputChannel = channel;
   }

   public post(message: any): void {
     this._view?.webview.postMessage(message);
   }

   public getEditPermissionEnabled(): boolean {
     return this._editPermissionEnabled;
   }

   public setEditPermissionEnabled(enabled: boolean): void {
     this._editPermissionEnabled = enabled;
   }

   public sendWorkspaceBanner(): void {
     const workspace = vscode.workspace.workspaceFolders?.[0];
     const name = workspace?.name || 'No workspace open';
     const path = workspace?.uri.fsPath || '';
     const text = `Workspace: ${name} (${path})`;
     this.post({ type: 'addMessage', message: { role: 'system', content: text } });
   }

  public getApiConfig(): ApiConfig {
    const cfg = vscode.workspace.getConfiguration('vibe-coding');
    const apiKey = cfg.get<string>('apiKey', '');
    if (!apiKey) {
      throw new Error('API key not configured. Please set vibe-coding.apiKey in Settings.');
    }
    return {
      baseUrl: cfg.get<string>('apiBaseUrl', 'https://api.openai.com/v1'),
      apiKey,
      model: cfg.get<string>('model', 'gpt-4o'),
      confirmChanges: cfg.get<boolean>('confirmChanges', true),
      confirmShellCommand: cfg.get<boolean>('confirmShellCommand', true),
      maxInteractions: cfg.get<number>('maxInteractions', -1),
      maxSequenceLength: cfg.get<number>('maxSequenceLength', 2000),
    };
  }

  public async llmCheckReplace(ctx: ReplaceCheckContext): Promise<ReplaceCheckResult> {
    const apiConfig = this.getApiConfig();

    const prompt =
      `You are a code-review assistant. A replace_lines operation is about to be applied.
` +
      `File: ${ctx.filePath}  |  lines ${ctx.startLine}–${ctx.endLine}

` +
      `## BEFORE (lines marked >>> will be replaced)
\`\`\`
${ctx.beforeContext}
\`\`\`

` +
      `## AFTER (lines marked >>> are the new content)
\`\`\`
${ctx.afterContext}
\`\`\`

` +
      `Focus on comparing the before/after code sections for semantic consistency and logical correctness. ` +
      `Tool call success determination is handled automatically by program logic; ` +
      `evaluate only whether the code change itself is correct and safe. Does this replacement look correct and safe to apply? ` +
      `Reply with exactly one word: CONFIRM or REJECT, followed by a brief reason.`;

    let reply: string;
    try {
      const checkMessages = [
        { role: 'system' as const, content: getAgentRuntimeContextBlock() },
        { role: 'user' as const, content: prompt },
      ];
      // Use the same API but without tools so we get a plain text answer
      const response = await sendChatMessage(checkMessages, apiConfig, undefined, this._abortController.signal);
      reply = (response.content ?? '').trim().toUpperCase();
    } catch {
      // If the check call itself fails, default to rejecting to stay safe
      return { ok: false, reason: 'Check call failed', notes: [] };
    }

    const approved = reply.startsWith('CONFIRM');

    // Surface the LLM's verdict in the chat UI as a check card
    const reason = reply.slice(approved ? 7 : 6).trim() || '(no reason given)';
    const unifiedT = trimForWebview(ctx.unifiedDiff || '');
    this.post({
      type: 'addCheckCard',
      data: {
        filePath: ctx.filePath,
        startLine: ctx.startLine,
        endLine: ctx.endLine,
        verdict: approved ? 'CONFIRMED' : 'REJECTED',
        reason: reason,
        timestamp: Date.now(),
        unifiedDiff: unifiedT.text,
        contextTruncated: unifiedT.truncated,
        languageId: languageIdFromPath(ctx.filePath),
      },
    });

    return { ok: approved, reason, notes: [] };
  }

  public async userConfirmReplace(ctx: ReplaceCheckContext): Promise<boolean> {
    if (!this._view) {
      // No UI surface to ask the user; stay safe.
      return false;
    }

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const unifiedT = trimForWebview(ctx.unifiedDiff || '');

    this.post({
      type: 'requestReplaceConfirm',
      data: {
        requestId,
        filePath: ctx.filePath,
        startLine: ctx.startLine,
        endLine: ctx.endLine,
        unifiedDiff: unifiedT.text,
        contextTruncated: unifiedT.truncated,
      },
    });

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._pendingReplaceConfirms.delete(requestId);
        resolve(false);
      }, 10 * 60 * 1000);

      this._pendingReplaceConfirms.set(requestId, (approved) => {
        clearTimeout(timer);
        this._pendingReplaceConfirms.delete(requestId);
        resolve(approved);
      });
    });
  }

  public resolveReplaceConfirm(requestId: string, approved: boolean): void {
    const resolver = this._pendingReplaceConfirms.get(requestId);
    if (resolver) {
      resolver(approved);
    }
  }

  public async userConfirmShellCommand(command: string): Promise<boolean> {
    if (!this._view) {
      // No UI surface to ask the user; stay safe.
      return false;
    }

    const cmd = (command ?? '').trim();
    if (!cmd) {
      return false;
    }

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    this.post({
      type: 'requestShellConfirm',
      data: {
        requestId,
        command: cmd,
      },
    });

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._pendingShellConfirms.delete(requestId);
        resolve(false);
      }, 10 * 60 * 1000);

      this._pendingShellConfirms.set(requestId, (approved) => {
        clearTimeout(timer);
        this._pendingShellConfirms.delete(requestId);
        resolve(approved);
      });
    });
  }

  public resolveShellConfirm(requestId: string, approved: boolean): void {
    const resolver = this._pendingShellConfirms.get(requestId);
    if (resolver) {
      resolver(approved);
    }
  }

  /** Called when the user hits Stop: resolve any pending confirms as "cancel". */
  public cancelPendingConfirms(): void {
    for (const [id, resolver] of this._pendingReplaceConfirms.entries()) {
      try { resolver(false); } catch { /* ignore */ }
      this._pendingReplaceConfirms.delete(id);
    }
    for (const [id, resolver] of this._pendingShellConfirms.entries()) {
      try { resolver(false); } catch { /* ignore */ }
      this._pendingShellConfirms.delete(id);
    }
  }
}