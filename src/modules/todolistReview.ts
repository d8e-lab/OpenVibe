import * as fs from 'fs';
import { getAgentRuntimeContextBlock } from '../agentRuntimeContext';
import { sendChatMessage } from '../api';
import type { ApiConfig, ChatMessage, AgentLogEntry } from '../types';
import { getMemoryFilePath } from '../tools';

export interface TodolistReviewSettings {
  enabled: boolean;
  maxAttempts: number;
  reviewTimeoutMs: number;
  editorTimeoutMs: number;
}

export type TodoItem = { text: string; done: boolean };
export type TodoState = { goal: string; items: TodoItem[] };

export type ReviewDecision = 'PASS' | 'FAIL';

export interface ReviewAgentResult {
  decision: ReviewDecision;
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

function parseReviewAgentResult(content: string | null): ReviewAgentResult {
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
    const decision: ReviewDecision = d === 'PASS' ? 'PASS' : 'FAIL';
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

function parseGoalItems(content: string | null): { goal: string; items: string[] } {
  if (!content?.trim()) {
    throw new Error('Empty model response for goal/items JSON');
  }
  const raw = extractJsonObject(content) as Record<string, unknown>;
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  if (!goal) {
    throw new Error('Missing goal in JSON');
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error('Missing or empty items array in JSON');
  }
  const items = raw.items.map((x) => String(x).trim()).filter(Boolean);
  if (items.length === 0) {
    throw new Error('All items were empty after trim');
  }
  return { goal, items };
}

export function mergeReviewNotes(acc: string[], newNotes: string[]): string[] {
  const out = [...acc];
  for (const n of newNotes) {
    const t = n.trim();
    if (!t) {
      continue;
    }
    const key = t.toLowerCase().slice(0, 120);
    if (!out.some((o) => o.toLowerCase().slice(0, 120) === key)) {
      out.push(t);
    }
  }
  return out;
}

export function loadMemoryExcerpt(maxChars = 12000): string {
  try {
    const p = getMemoryFilePath();
    if (!fs.existsSync(p)) {
      return '(memory.md not found; no project_constraints extracted)';
    }
    const text = fs.readFileSync(p, 'utf-8');
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars) + '\n\n[… truncated for review context …]';
  } catch {
    return '(could not read memory.md — workspace may be closed)';
  }
}

export function formatTodoStateForPrompt(state: TodoState): string {
  const lines = state.items.map(
    (item, i) => `${i + 1}. [${item.done ? 'x' : ' '}] ${item.text}`
  );
  return `Goal: ${state.goal}\nItems:\n${lines.join('\n')}`;
}

async function chatJson(
  messages: ChatMessage[],
  apiConfig: ApiConfig,
  timeoutMs: number,
  signal?: AbortSignal,
  log?: (e: AgentLogEntry) => void,
  agent?: string
): Promise<string | null> {
  try {
    log?.({ at: Date.now(), agent: agent || 'agent', stage: 'request', data: { timeoutMs, messages } });
  } catch {
    /* ignore */
  }
  const res = await sendChatMessage(messages, apiConfig, undefined, signal, { timeoutMs });
  try {
    log?.({ at: Date.now(), agent: agent || 'agent', stage: 'response', data: { content: res.content } });
  } catch {
    /* ignore */
  }
  return res.content;
}

const REVIEW_SYSTEM_GENERATE = `You are an independent review agent for the tool todolist.generate (create/replace the assistant's structured todo list in the IDE).
You MUST NOT modify any code or files. You only output JSON.

Your ONLY job: decide whether the proposed todo list is consistent with the user's stated request and boundaries.
- If the user asked for planning only / a todo list only, the list must not imply unrelated execution (e.g. do not sneak in "modify codebase" steps unless the user clearly asked).
- The list should reflect the user's intent, scope, and emphasis (e.g. if the user stressed "plan first", items should stay plan-aligned).
- Ignore code quality; do NOT review programming correctness.

Output strictly one JSON object:
{"decision":"PASS"|"FAIL","notes":["string", ...],"summary":"one short sentence"}`;

const REVIEW_SYSTEM_EDIT = `You are an independent review agent for the tool todolist.edit (expand one todo item into multiple sub-items, replacing that item).
You MUST NOT modify any code or files. You only output JSON.

Evaluate:
- The result matches the stated edit goal and user request.
- The expansion is coherent: the new items belong to the expanded slot; ordering is sensible; the rest of the list is preserved logically.
- No obvious contradictions with project_constraints / memory excerpt when provided.

Output strictly one JSON object:
{"decision":"PASS"|"FAIL","notes":["string", ...],"summary":"one short sentence"}`;

const WRITER_SYSTEM_GENERATE = `You are the main planning agent revising a todo list for todolist.generate.
Return ONLY one JSON object (no markdown fences): {"goal":"...","items":["step 1", ...]}
Rules:
- Address every MUST note from the reviewer; stay aligned with the user's request.
- Items must be concrete, ordered steps.
- Do not add unrelated work.`;

const WRITER_SYSTEM_EDIT = `You are the main planning agent revising a todo list edit for todolist.edit (expand one item into multiple sub-steps).
Return ONLY one JSON object (no markdown fences): {"replacementItems":["new step a", "new step b", ...]}
Rules:
- Address reviewer notes; stay aligned with the user's request and operation goal.
- The replacementItems array is ONLY the new lines that replace the single item at expandIndex (in order).
- Do not add unrelated work.`;

function parseReplacementItems(content: string | null): { replacementItems: string[] } {
  if (!content?.trim()) {
    throw new Error('Empty model response');
  }
  const raw = extractJsonObject(content) as Record<string, unknown>;
  if (!Array.isArray(raw.replacementItems)) {
    throw new Error('JSON must include replacementItems[]');
  }
  const replacementItems = raw.replacementItems.map((x) => String(x).trim()).filter(Boolean);
  if (replacementItems.length === 0) {
    throw new Error('replacementItems empty');
  }
  return { replacementItems };
}

export async function reviewTodolistGenerate(params: {
  apiConfig: ApiConfig;
  userRequest: string;
  operationGoal: string;
  candidateGoal: string;
  candidateItems: string[];
  projectConstraints: string;
  relatedContext: string;
  reviewTimeoutMs: number;
  signal?: AbortSignal;
  log?: (e: AgentLogEntry) => void;
}): Promise<ReviewAgentResult> {
  const candidateBody = `Goal: ${params.candidateGoal}\nItems:\n${params.candidateItems
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n')}`;

  const userMsg =
    `## User request (from chat)\n${params.userRequest || '(none)'}\n\n` +
    `## Operation goal (tool argument goal)\n${params.operationGoal}\n\n` +
    `## Proposed todo list (todolist.generate)\n${candidateBody}\n\n` +
    `## Related context\n${params.relatedContext || '(none)'}\n\n` +
    `## Project constraints (memory excerpt)\n${params.projectConstraints}\n`;

  const content = await chatJson(
    [
      { role: 'system', content: REVIEW_SYSTEM_GENERATE + '\n\n' + getAgentRuntimeContextBlock() },
      { role: 'user', content: userMsg },
    ],
    params.apiConfig,
    params.reviewTimeoutMs,
    params.signal,
    params.log,
    'todolistReview'
  );
  return parseReviewAgentResult(content);
}

export async function reviewTodolistEdit(params: {
  apiConfig: ApiConfig;
  userRequest: string;
  operationGoal: string;
  baseline: TodoState;
  modified: TodoState;
  expandIndex: number;
  changeSummary: string;
  projectConstraints: string;
  relatedContext: string;
  reviewNotesAccumulated: string[];
  reviewTimeoutMs: number;
  signal?: AbortSignal;
  log?: (e: AgentLogEntry) => void;
}): Promise<ReviewAgentResult> {
  const userMsg =
    `## User request\n${params.userRequest || '(none)'}\n\n` +
    `## Operation goal\n${params.operationGoal}\n\n` +
    `## Expand index (0-based)\n${params.expandIndex}\n\n` +
    `## Change summary (from editor/tool)\n${params.changeSummary}\n\n` +
    `## Baseline todo list\n${formatTodoStateForPrompt(params.baseline)}\n\n` +
    `## Modified todo list (candidate)\n${formatTodoStateForPrompt(params.modified)}\n\n` +
    `## Prior review notes (dedupe overlaps)\n${
      params.reviewNotesAccumulated.length
        ? params.reviewNotesAccumulated.map((n, i) => `${i + 1}. ${n}`).join('\n')
        : '(none)'
    }\n\n` +
    `## Related context\n${params.relatedContext || '(none)'}\n\n` +
    `## Project constraints (memory excerpt)\n${params.projectConstraints}\n`;

  const content = await chatJson(
    [
      { role: 'system', content: REVIEW_SYSTEM_EDIT + '\n\n' + getAgentRuntimeContextBlock() },
      { role: 'user', content: userMsg },
    ],
    params.apiConfig,
    params.reviewTimeoutMs,
    params.signal,
    params.log,
    'todolistReview'
  );
  return parseReviewAgentResult(content);
}

export async function regenerateGenerateCandidate(params: {
  apiConfig: ApiConfig;
  userRequest: string;
  priorGoal: string;
  priorItems: string[];
  reviewNotes: string[];
  projectConstraints: string;
  reviewTimeoutMs: number;
  signal?: AbortSignal;
  log?: (e: AgentLogEntry) => void;
}): Promise<{ goal: string; items: string[] }> {
  const userMsg =
    `User request:\n${params.userRequest || '(none)'}\n\n` +
    `Prior goal:\n${params.priorGoal}\n\n` +
    `Prior items:\n${params.priorItems.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n` +
    `Reviewer notes (must fix):\n${params.reviewNotes.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\n` +
    `Project constraints:\n${params.projectConstraints}\n\n` +
    `Return revised goal + items as JSON.`;

  const content = await chatJson(
    [
      { role: 'system', content: WRITER_SYSTEM_GENERATE + '\n\n' + getAgentRuntimeContextBlock() },
      { role: 'user', content: userMsg },
    ],
    params.apiConfig,
    params.reviewTimeoutMs,
    params.signal,
    params.log,
    'todolistWriter'
  );
  return parseGoalItems(content);
}

export async function editorExpandCandidate(params: {
  apiConfig: ApiConfig;
  userRequest: string;
  baseline: TodoState;
  expandIndex: number;
  proposedNewItems: string[];
  reviewNotes: string[];
  projectConstraints: string;
  editorTimeoutMs: number;
  signal?: AbortSignal;
  log?: (e: AgentLogEntry) => void;
}): Promise<{ replacementItems: string[] }> {
  const userMsg =
    `User request:\n${params.userRequest || '(none)'}\n\n` +
    `Baseline list:\n${formatTodoStateForPrompt(params.baseline)}\n\n` +
    `Expand index (0-based): ${params.expandIndex}\n` +
    `Proposed replacement item texts (in order):\n${params.proposedNewItems.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n` +
    `Reviewer notes to address:\n${
      params.reviewNotes.length ? params.reviewNotes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(none)'
    }\n\n` +
    `Project constraints:\n${params.projectConstraints}\n\n` +
    `Return JSON with replacementItems only.`;

  const content = await chatJson(
    [
      { role: 'system', content: WRITER_SYSTEM_EDIT + '\n\n' + getAgentRuntimeContextBlock() },
      { role: 'user', content: userMsg },
    ],
    params.apiConfig,
    params.editorTimeoutMs,
    params.signal,
    params.log,
    'todolistWriter'
  );
  return parseReplacementItems(content);
}

export function applyExpandToClone(
  baseline: TodoState,
  expandIndex: number,
  newItemTexts: string[],
  goalOverride?: string
): TodoState {
  const items = baseline.items.map((x) => ({ ...x }));
  if (expandIndex < 0 || expandIndex >= items.length) {
    throw new Error(`expandIndex ${expandIndex} out of range`);
  }
  const injected = newItemTexts.map((text) => ({ text, done: false }));
  items.splice(expandIndex, 1, ...injected);
  return { goal: goalOverride ?? baseline.goal, items };
}

export function todoItemsToStrings(items: TodoItem[]): string[] {
  return items.map((i) => i.text);
}
