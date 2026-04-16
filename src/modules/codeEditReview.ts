import * as vscode from 'vscode';
import { getAgentRuntimeContextBlock } from '../agentRuntimeContext';
import { sendChatMessage } from '../api';
import type { ApiConfig, ChatMessage, AgentLogEntry } from '../types';
import type { ReplaceCheckContext, ReplaceCheckResult } from '../tools';
import { loadMemoryExcerpt } from './todolistReview';

/** Avoid oversized webview payloads; mirror UIManager behavior. */
const MAX_CONTEXT_CHARS = 120_000;

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
  if (s.length <= MAX_CONTEXT_CHARS) {
    return { text: s, truncated: false };
  }
  return { text: s.slice(0, MAX_CONTEXT_CHARS) + '\n\n… [truncated for chat view]', truncated: true };
}

function readEditReviewSettings(): { enabled: boolean; timeoutMs: number } {
  const c = vscode.workspace.getConfiguration('vibe-coding');
  return {
    enabled: c.get<boolean>('editReview.enabled', true) !== false,
    timeoutMs: Math.max(5000, c.get<number>('editReview.timeoutMs', 120000)),
  };
}

function extractJsonObject(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(t.slice(start, end + 1));
  }
  throw new Error('No JSON object in model output');
}

function parseIndependentReview(content: string | null): { ok: boolean; reason: string; notes: string[] } {
  if (!content?.trim()) {
    return { ok: false, reason: 'Empty review response', notes: ['Review agent returned empty content.'] };
  }
  try {
    const raw = extractJsonObject(content) as Record<string, unknown>;
    const decision = String(raw.decision || '').toUpperCase();
    const ok = decision === 'CONFIRM';
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    const notes = Array.isArray(raw.notes) ? raw.notes.map((x) => String(x)) : [];
    return { ok, reason: reason || (ok ? 'OK' : 'Rejected'), notes };
  } catch {
    return { ok: false, reason: 'Invalid review JSON', notes: ['Review agent output was not valid JSON.'] };
  }
}

const REVIEW_SYSTEM = `You are an independent review agent for a SINGLE code edit about to be applied in a VS Code workspace.
You MUST NOT modify any files. You only output JSON.

Scope rules (CRITICAL):
- Review ONLY the specific replacement shown (this one tool step), not whether the entire user goal is fully completed.
- The user may be working in multiple steps; DO NOT reject merely because this edit is not \"end-to-end\".

Evaluate ONLY whether this replacement is consistent with the user's request and the current step context (when provided), and safe to apply in isolation.
- Pay attention to explicit boundaries (e.g. plan-only, do not modify files, change scope).
- Check for obvious logic errors or broken references in the shown context window.

Output exactly one JSON object:
{"decision":"CONFIRM"|"REJECT","reason":"one short sentence","notes":["string", ...]}`;

export async function llmIndependentEditReview(params: {
  ctx: ReplaceCheckContext;
  apiConfig: ApiConfig;
  userRequest: string;
  relatedContext: string;
  post: (msg: any) => void;
  /** 1-based index of this Replace check in the current user instruction (shown on the card). */
  reviewRound?: number;
  signal?: AbortSignal;
  log?: (e: AgentLogEntry) => void;
}): Promise<ReplaceCheckResult> {
  const settings = readEditReviewSettings();
  if (!settings.enabled) {
    // fall back to legacy UIManager check by returning ok and letting UIManager handle display upstream
    return { ok: true, reason: 'Independent edit review disabled', notes: [] };
  }

  const memoryExcerpt = loadMemoryExcerpt();
  const userMsg =
    `User request:\n${params.userRequest || '(none)'}\n\n` +
    `Related context:\n${params.relatedContext || '(none)'}\n\n` +
    `File: ${params.ctx.filePath} | lines ${params.ctx.startLine}–${params.ctx.endLine}\n\n` +
    `## BEFORE\n\`\`\`\n${params.ctx.beforeContext}\n\`\`\`\n\n` +
    `## AFTER\n\`\`\`\n${params.ctx.afterContext}\n\`\`\`\n\n` +
    `## Project constraints (memory excerpt)\n${memoryExcerpt}\n`;

  let content: string | null = null;
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: REVIEW_SYSTEM + '\n\n' + getAgentRuntimeContextBlock() },
      { role: 'user', content: userMsg },
    ];
    try {
      params.log?.({ at: Date.now(), agent: 'codeEditReview', stage: 'request', data: { messages } });
    } catch {
      /* ignore */
    }
    const res = await sendChatMessage(messages, params.apiConfig, undefined, params.signal, {
      timeoutMs: settings.timeoutMs,
    });
    content = res.content;
    try {
      params.log?.({ at: Date.now(), agent: 'codeEditReview', stage: 'response', data: { content } });
    } catch {
      /* ignore */
    }
  } catch {
    try {
      params.log?.({ at: Date.now(), agent: 'codeEditReview', stage: 'error', data: { error: 'request failed' } });
    } catch {
      /* ignore */
    }
    content = null;
  }

  const parsed = parseIndependentReview(content);

  // Surface verdict in UI as a check card (same shape as UIManager.llmCheckReplace).
  const reason = parsed.reason || '(no reason given)';
  const unifiedT = trimForWebview(params.ctx.unifiedDiff || '');
  params.post({
    type: 'addCheckCard',
    data: {
      filePath: params.ctx.filePath,
      startLine: params.ctx.startLine,
      endLine: params.ctx.endLine,
      verdict: parsed.ok ? 'CONFIRMED' : 'REJECTED',
      reason,
      timestamp: Date.now(),
      unifiedDiff: unifiedT.text,
      contextTruncated: unifiedT.truncated,
      languageId: languageIdFromPath(params.ctx.filePath),
      reviewRound: params.reviewRound,
    },
  });

  return { ok: parsed.ok, reason, notes: parsed.notes };
}

