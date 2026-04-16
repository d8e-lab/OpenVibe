import { getAgentRuntimeContextBlock } from '../agentRuntimeContext';
import { sendChatMessage } from '../api';
import type { ApiConfig, ChatMessage } from '../types';
export interface ShellCommandReviewSettings {
  enabled: boolean;
  maxAttempts: number;
  reviewTimeoutMs: number;
  editorTimeoutMs: number;
}

export type ShellReviewDecision = 'PASS' | 'FAIL';

export interface ShellReviewAgentResult {
  decision: ShellReviewDecision;
  notes: string[];
  summary: string;
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

function parseShellReviewResult(content: string | null): ShellReviewAgentResult {
  if (!content?.trim()) {
    return {
      decision: 'FAIL',
      notes: ['Review agent returned empty content.'],
      summary: 'Empty review response',
    };
  }
  try {
    const raw = extractJsonObject(content) as Record<string, unknown>;
    const d = String(raw.decision || '').toUpperCase();
    const decision: ShellReviewDecision = d === 'PASS' ? 'PASS' : 'FAIL';
    let notes: string[] = [];
    if (Array.isArray(raw.notes)) {
      notes = raw.notes.map((x) => String(x));
    } else if (typeof raw.notes === 'string' && raw.notes.trim()) {
      notes = [raw.notes.trim()];
    }
    const summary = typeof raw.summary === 'string' ? raw.summary : '';
    if (notes.length === 0 && summary) {
      notes = [summary];
    }
    return { decision, notes, summary: summary || (decision === 'PASS' ? 'OK' : 'Issues found') };
  } catch {
    return {
      decision: 'FAIL',
      notes: ['Review agent output was not valid JSON; treating as FAIL.'],
      summary: 'Invalid review JSON',
    };
  }
}

function parseEditorCommand(content: string | null): { command: string } {
  if (!content?.trim()) {
    throw new Error('Empty model response for shell command JSON');
  }
  const raw = extractJsonObject(content) as Record<string, unknown>;
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';
  if (!command) {
    throw new Error('command missing or empty in JSON');
  }
  return { command };
}

async function chatJson(
  messages: ChatMessage[],
  apiConfig: ApiConfig,
  timeoutMs: number
): Promise<string | null> {
  const res = await sendChatMessage(messages, apiConfig, undefined, undefined, { timeoutMs });
  return res.content;
}

const EDITOR_SYSTEM_INITIAL = `You are the shell command editor agent for run_shell_command in a VS Code workspace.
The main assistant chose a command line; your job is to return exactly ONE shell command to run with workspace root as cwd.

Rules:
- Output ONLY JSON: {"command":"..."} — one string, no markdown fences.
- Keep a single logical command line (use && or | within the line if needed; avoid embedding raw newlines).
- Prefer conventional tooling (npm, pnpm, git, pytest, cargo, etc.) when appropriate.
- Do NOT use shell file-editing tricks to change source files (e.g. sed -i, tee, echo >, PowerShell Set-Content/Out-File, vim/nano batch) when ordinary code changes should go through the edit tool — suggest a read-only or build/test command instead, or refuse risky edits by returning a safe alternative that matches the user request.
- If the proposed command is already appropriate, you may return it unchanged.`;

const EDITOR_SYSTEM_REVISE = `You are revising a shell command after an independent safety review rejected the prior candidate.
Output ONLY JSON: {"command":"..."} — no markdown fences.

Address every reviewer note. Stay aligned with the user's request. Same rules as initial editing: one line, workspace cwd, no source-file bypass via shell where edit tool applies.`;

const REVIEW_SYSTEM = `You are an independent review agent for run_shell_command (terminal command in the workspace).
You MUST NOT execute commands or modify files. Output JSON only.

Scope rules (CRITICAL):
- Review ONLY whether THIS ONE command is appropriate as the current step, not whether it completes the entire end-to-end goal.
- The user may be working incrementally; DO NOT fail merely because this command isn't \"one shot\".

Evaluate the proposed command:
1) **Safety**: obvious destructive risk (e.g. rm -rf on broad paths), arbitrary remote code execution, piping curl/wget to shell, disabling security, etc.
2) **Edit-tool bypass**: shell-based file edits to project source/config (sed/awk/perl one-liners, tee, redirection, PowerShell Set-Content/Out-File) when the task is ordinary code editing — those should use read_file + edit instead. Read-only git/status/log commands are usually fine.
3) **Fit**: matches the user request and the current step context; reasonable scope.
4) **No-shell-for-context (CRITICAL)**: Reject commands whose purpose is to view/search/harvest file contents or enumerate the workspace. The workspace provides dedicated tools for that.
   - Reject examples: cat/type/Get-Content/more/less/head/tail, dir /s, Get-ChildItem -Recurse, find/grep/rg/Select-String used to inspect project files.
   - If the user needs context, instruct them to use read_file / find_in_file instead (do NOT approve a shell workaround).
5) **Alignment & drift**: The candidate must remain aligned with the user's request and the current todo context. If the candidate looks unrelated, adds extra scripts, or appears to be a different action than what was requested, FAIL.
6) **Evidence-driven & anti-repeat**: If you PASS a build/test command, state what evidence is expected (exit code / error code / key output). If the same command was already run recently without new changes, prefer FAIL with a note to avoid redundant reruns.

Output strictly one JSON object:
{"decision":"PASS"|"FAIL","notes":["string", ...],"summary":"one short sentence"}`;

export async function shellEditorCandidate(params: {
  apiConfig: ApiConfig;
  userRequest: string;
  relatedContext: string;
  projectConstraints: string;
  proposedFromTool: string;
  priorCandidate: string;
  reviewNotes: string[];
  editorTimeoutMs: number;
}): Promise<{ command: string }> {
  const isRevise = params.reviewNotes.length > 0;
  const userMsg = isRevise
    ? `## User request\n${params.userRequest || '(none)'}\n\n` +
      `## Related context\n${params.relatedContext || '(none)'}\n\n` +
      `## Main assistant proposed (original tool argument)\n${params.proposedFromTool}\n\n` +
      `## Prior candidate (rejected)\n${params.priorCandidate}\n\n` +
      `## Reviewer notes (must address)\n${
        params.reviewNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')
      }\n\n` +
      `## Project constraints (memory excerpt)\n${params.projectConstraints}\n`
    : `## User request\n${params.userRequest || '(none)'}\n\n` +
      `## Related context\n${params.relatedContext || '(none)'}\n\n` +
      `## Main assistant proposed command (tool argument)\n${params.proposedFromTool}\n\n` +
      `## Project constraints (memory excerpt)\n${params.projectConstraints}\n`;

  const content = await chatJson(
    [
      {
        role: 'system',
        content: (isRevise ? EDITOR_SYSTEM_REVISE : EDITOR_SYSTEM_INITIAL) + '\n\n' + getAgentRuntimeContextBlock(),
      },
      { role: 'user', content: userMsg },
    ],
    params.apiConfig,
    params.editorTimeoutMs
  );
  return parseEditorCommand(content);
}

export async function reviewShellCommand(params: {
  apiConfig: ApiConfig;
  userRequest: string;
  relatedContext: string;
  projectConstraints: string;
  command: string;
  proposedFromTool: string;
  reviewTimeoutMs: number;
}): Promise<ShellReviewAgentResult> {
  const userMsg =
    `## User request\n${params.userRequest || '(none)'}\n\n` +
    `## Related context\n${params.relatedContext || '(none)'}\n\n` +
    `## Original tool argument from main assistant\n${params.proposedFromTool}\n\n` +
    `## Candidate command after shell editor agent\n${params.command}\n\n` +
    `## Project constraints (memory excerpt)\n${params.projectConstraints}\n`;

  const content = await chatJson(
    [
      { role: 'system', content: REVIEW_SYSTEM + '\n\n' + getAgentRuntimeContextBlock() },
      { role: 'user', content: userMsg },
    ],
    params.apiConfig,
    params.reviewTimeoutMs
  );
  return parseShellReviewResult(content);
}
