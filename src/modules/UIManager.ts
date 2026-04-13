import * as vscode from 'vscode';
import { ApiConfig } from '../types';
import { ReplaceCheckContext } from '../tools';
import { sendChatMessage } from '../api';
export class UIManager {
  private _view?: vscode.WebviewView;
  private _outputChannel?: vscode.OutputChannel;
  private _abortController: AbortController = new AbortController();

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
      maxInteractions: cfg.get<number>('maxInteractions', -1),
      maxSequenceLength: cfg.get<number>('maxSequenceLength', 2000),
    };
  }

  public async llmCheckReplace(ctx: ReplaceCheckContext): Promise<boolean> {
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
        { role: 'user' as const, content: prompt },
      ];
      // Use the same API but without tools so we get a plain text answer
      const response = await sendChatMessage(checkMessages, apiConfig, undefined, this._abortController.signal);
      reply = (response.content ?? '').trim().toUpperCase();
    } catch {
      // If the check call itself fails, default to rejecting to stay safe
      return false;
    }

    const approved = reply.startsWith('CONFIRM');

    // Surface the LLM's verdict in the chat UI as a check card
    const reason = reply.slice(approved ? 7 : 6).trim() || '(no reason given)';
    this.post({
      type: 'addCheckCard',
      data: {
        filePath: ctx.filePath,
        startLine: ctx.startLine,
        endLine: ctx.endLine,
        verdict: approved ? 'CONFIRMED' : 'REJECTED',
        reason: reason,
        timestamp: Date.now(),
      },
    });

    return approved;
  }

  public async userConfirmReplace(ctx: ReplaceCheckContext): Promise<boolean> {
    const title = `Replace lines ${ctx.startLine}-${ctx.endLine} in ${ctx.filePath}`;
    
    const choices = [
      'Yes, apply the change',
      'No, keep the original',
    ];
    
    const result = await vscode.window.showInformationMessage(
      title,
      { modal: true, detail: `Check the chat for the full before/after context.` },
      ...choices
    );
    
    return result === choices[0];
  }
}