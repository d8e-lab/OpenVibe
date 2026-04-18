import {
  readFileTool,
  findInFileTool,
  replaceLinesTool,
  getWorkspaceInfoTool,
  createDirectoryTool,
  getDiagnosticsTool,
  getFileInfoTool,
  showTextDiffTool,
  showNotificationTool,
  getThemeInfoTool,
  runShellCommandTool,
  gitSnapshotTool,
  gitRollbackTool,
  listGitSnapshotsTool
} from '../tools';
import type { ReplaceCheckContext, ReplaceCheckResult } from '../tools';
import type { ApiConfig, AgentLogEntry } from '../types';
import type { TodolistReviewSettings, TodoState } from './todolistReview';
import {
  applyExpandToClone,
  editorExpandCandidate,
  loadMemoryExcerpt,
  mergeReviewNotes,
  regenerateGenerateCandidate,
  reviewTodolistEdit,
  reviewTodolistGenerate,
} from './todolistReview';
import type { ShellCommandReviewSettings } from './shellCommandReview';
import { reviewShellCommand, shellEditorCandidate } from './shellCommandReview';
import type { ShellReviewAgentResult } from './shellCommandReview';

function detectShellFileOpBypass(command: string): string | null {
  const c = command.trim();
  // Obvious shell write/edit primitives (cross-shell).
  if (/(^|[;&|])\s*(sed|perl|python|node)\b/i.test(c) && /-i\b/.test(c)) {
    return 'Detected in-place editing via scripting tool (e.g. sed -i / perl -pi). Use read_file + edit instead.';
  }
  if (/(^|[;&|])\s*(tee)\b/i.test(c)) {
    return 'Detected tee-based file writes. Use read_file + edit instead.';
  }
  if (/[^\S\r\n]>\s*\S/.test(c) || /[^\S\r\n]>>\s*\S/.test(c)) {
    return 'Detected output redirection (>, >>). Do not write files via shell; use edit/create_directory tools.';
  }
  // PowerShell write primitives.
  if (/\b(Set-Content|Add-Content|Out-File)\b/i.test(c)) {
    return 'Detected PowerShell file write command. Use read_file + edit instead.';
  }
  // Common batch editors.
  if (/\b(vim|nvim|nano)\b/i.test(c)) {
    return 'Detected interactive editor usage. Use read_file + edit tools instead.';
  }
  return null;
}

function detectShellContextHarvest(command: string): string | null {
  const c = command.trim();
  // Read/show file contents.
  const readCmd = /\b(cat|type|more|less|head|tail|Get-Content)\b/i;
  if (readCmd.test(c)) {
    // Allow reading a single, clearly non-code file when it's scoped (no pipes) and not under src/.
    const m = c.match(/\b(?:cat|type|more|less|head|tail|Get-Content)\b\s+("?)([^\s"|;&]+)\1/i);
    const rawPath = (m?.[2] ?? '').trim();
    const pathLower = rawPath.replace(/^["']|["']$/g, '').toLowerCase();
    const ext = pathLower.includes('.') ? pathLower.slice(pathLower.lastIndexOf('.')) : '';
    const isInSrc = /(^|[\\/])src[\\/]/i.test(pathLower);
    const hasPipe = /[|]/.test(c);
    const allowedNonCodeExt = new Set([
      '.md',
      '.txt',
      '.log',
      '.csv',
      '.tsv',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.ini',
      '.cfg',
      '.conf',
    ]);
    const disallowedCodeExt = new Set([
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.rs',
      '.cpp',
      '.c',
      '.h',
      '.hpp',
      '.sh',
      '.ps1',
      '.bat',
      '.cmd',
    ]);
    const isEnv = ext === '.env' || pathLower.endsWith('.env.local') || pathLower.endsWith('.env.production');

    if (!hasPipe && rawPath && !isInSrc && !isEnv && (allowedNonCodeExt.has(ext) || (ext && !disallowedCodeExt.has(ext)))) {
      return null;
    }
    return 'Shell read of workspace files is restricted. Prefer read_file. If you must read via shell, keep it to a single non-code artifact (e.g. .log/.txt) outside src/ with no pipes.';
  }
  // Workspace enumeration/search (especially recursive).
  if (/\b(dir|ls|tree|Get-ChildItem)\b/i.test(c) && /\b(-Recurse|\/s)\b/i.test(c)) {
    return 'Command appears to recursively enumerate the workspace via shell. Use get_workspace_info / read_file / find_in_file instead.';
  }
  if (/\b(find|grep|rg|Select-String)\b/i.test(c)) {
    return 'Command appears to search files via shell. Use find_in_file instead.';
  }
  // Non-recursive listing can still be context-harvesting; treat as disallowed under current policy.
  if (/\b(dir|ls|tree|Get-ChildItem)\b/i.test(c)) {
    return 'Command appears to enumerate workspace files via shell. Use get_file_info + read_file instead (and prefer adding a dedicated tool if directory listing is needed).';
  }
  return null;
}

function shouldEarlyStopOnShellReviewFail(review: ShellReviewAgentResult): boolean {
  if (review.decision === 'PASS') return false;
  const text = `${review.summary || ''}\n${(review.notes || []).join('\n')}`.toLowerCase();
  // If the reviewer is telling us the action itself is inappropriate for shell,
  // further attempts will be wasted (the assistant should switch to tools).
  return (
    text.includes('no-shell-for-context') ||
    text.includes('use read_file') ||
    text.includes('use find_in_file') ||
    text.includes('use edit') ||
    text.includes('do not use shell') ||
    text.includes('do not approve a shell workaround') ||
    text.includes('enumerate') ||
    text.includes('view/search/harvest') ||
    text.includes('shell-based file edits') ||
    text.includes('edit-tool bypass')
  );
}

export class ToolExecutor {
  private _todoList: { goal: string; items: { text: string; done: boolean }[] } | null = null;
  private _lastShellExecutions: { command: string; at: number }[] = [];

  /** Edit permission state - controls whether edit tools can be used */
  private _editPermissionEnabled: boolean = true;

  /** Increments per `edit` LLM check in the current user turn (shown on Replace check cards). */
  private _editReviewRound = 0;
   constructor(
     private readonly _context: {
       post: (message: any) => void;
       llmCheckReplace: (ctx: ReplaceCheckContext) => Promise<ReplaceCheckResult>;
       userConfirmReplace: (ctx: ReplaceCheckContext) => Promise<boolean>;
       userConfirmShellCommand: (command: string) => Promise<boolean>;
       getApiConfig: () => ApiConfig;
       getLastUserTextForTools: () => string;
       getRelatedContextForTodolistReview: () => string;
       getTodolistReviewSettings: () => TodolistReviewSettings;
       getShellCommandReviewSettings: () => ShellCommandReviewSettings;
       /** Check if edit permission is enabled */
       getEditPermissionEnabled: () => boolean;
       /** Update edit permission state */
       setEditPermissionEnabled: (enabled: boolean) => void;
       isStopped?: () => boolean;
       signal?: () => AbortSignal;
       log?: (entry: AgentLogEntry) => void;
     }
   ) {}
    } catch {
      return false;
    }
  }

  private _signal(): AbortSignal | undefined {
    try {
      return this._context.signal?.();
    } catch {
      return undefined;
    }
  }

  private _log(agent: string, stage: string, data: any): void {
    try {
      this._context.log?.({ at: Date.now(), agent, stage, data });
    } catch {
      // ignore
    }
  }

  /** Call when the user sends a new message (not empty "continue") so edit check numbering restarts. */
  public resetReviewUiCounters(): void {
    this._editReviewRound = 0;
  }

  /** Next sequence number for Replace check cards this turn. */
  public nextEditReviewRound(): number {
    this._editReviewRound += 1;
    return this._editReviewRound;
  }

   public async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
     // Check if the tool requires edit permission
     const editTools = ['edit', 'create_directory'];
     if (editTools.includes(name) && !this._context.getEditPermissionEnabled()) {
       const message = `Edit permission is currently disabled. The ${name} tool cannot be used while edit permission is turned off. Please enable edit permission or use read-only tools only.`;
       this._context.post({ type: 'addMessage', message: { role: 'assistant', content: message } });
       return JSON.stringify({ error: message });
     }
     
     switch (name) {
      case 'get_workspace_info':
        return getWorkspaceInfoTool();

      case 'read_file':
        return readFileTool({
          filePath: args.filePath as string,
          startLine: args.startLine as number | undefined,
          endLine: args.endLine as number | undefined,
        });

      case 'find_in_file':
        return findInFileTool({
          filePath: args.filePath as string,
          searchString: args.searchString as string,
          contextBefore: args.contextBefore as number | undefined,
          contextAfter: args.contextAfter as number | undefined,
          occurrence: args.occurrence as number | undefined,
        });

      case 'edit':
        return replaceLinesTool(
          {
            filePath: args.filePath as string,
            startLine: args.startLine as number,
            endLine: args.endLine as number,
            newContent: args.newContent as string,
            raw: args['__mmRaw'] === true,
          },
          (ctx) => this._context.llmCheckReplace(ctx),
          this._context.getApiConfig().confirmChanges !== false ? (ctx) => this._context.userConfirmReplace(ctx) : undefined
        );

      case 'create_directory':
        return createDirectoryTool({
          dirPath: args.dirPath as string,
          recursive: args.recursive as boolean | undefined,
        });

      case 'task_complete': {
        const summary = (args['summary'] as string) || '';
        if (summary.trim()) {
          this._context.post({ type: 'addMessage', message: { role: 'assistant', content: summary.trim() } });
        }
        // task_complete 被调用后直接结束，不返回任何信息给LLM
        return JSON.stringify({ success: true, message: 'Task marked complete.', _immediate_end: true });
      }

      case 'create_todo_list':
        return await this._handleCreateTodoList(args);

      case 'complete_todo_item': {
        const idx = args['index'] as number;
        const summary = (args['summary'] as string) || '';
        if (!this._todoList) {
          return JSON.stringify({ error: 'No todo list exists. Call create_todo_list first.' });
        }
        if (idx < 0 || idx >= this._todoList.items.length) {
          return JSON.stringify({ error: `Index ${idx} is out of range (0–${this._todoList.items.length - 1}).` });
        }
        this._todoList.items[idx].done = true;
        const list = this._todoList.items
          .map((item, i) => `${i + 1}. [${item.done ? 'x' : ' '}] ${item.text}`)
          .join('\n');
        const remaining = this._todoList.items.filter(i => !i.done).length;
        const result = JSON.stringify({
          success: true,
          message: summary ? `Item ${idx + 1} complete: ${summary}` : `Item ${idx + 1} marked complete.`,
          remaining,
          todoList: list,
        });
        
        // 向用户显示更新后的todo list
        const todoListDisplay = `Todo list updated:

**Items**:
${list}

**Remaining**: ${remaining} item(s)`;
        this._context.post({ type: 'addMessage', message: { role: 'assistant', content: todoListDisplay } });
        
        return result;
      }

      case 'get_diagnostics': {
        return getDiagnosticsTool({
          uri: args.uri as string | undefined,
          filePath: args.filePath as string | undefined,
        });
      }

      case 'get_file_info':
        return getFileInfoTool({ filePath: args.filePath as string });

      case 'show_text_diff':
        return await showTextDiffTool({
          title: args.title as string,
          leftContent: args.leftContent as string,
          rightContent: args.rightContent as string,
          languageId: args.languageId as string | undefined,
        });

      case 'show_notification':
        return await showNotificationTool({
          message: args.message as string,
          severity: args.severity as 'info' | 'warning' | 'error' | undefined,
        });

      case 'get_theme_info':
        return getThemeInfoTool();

      case 'run_shell_command':
        return await this._handleRunShellCommand(args);

      case 'git_snapshot': {
        return gitSnapshotTool({
          sessionId: args.sessionId as string,
          userInstruction: args.userInstruction as string,
          description: args.description as string | undefined,
        });
      }

      case 'git_rollback': {
        return gitRollbackTool({
          snapshotId: args.snapshotId as string,
          sessionId: args.sessionId as string,
        });
      }

      case 'list_git_snapshots': {
        return listGitSnapshotsTool();
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  private async _handleRunShellCommand(args: Record<string, unknown>): Promise<string> {
    const proposedFromTool = String(args.command ?? '').trim();
    if (!proposedFromTool) {
      return JSON.stringify({ error: 'command is empty' });
    }
    if (this._stopped()) {
      return JSON.stringify({ success: false, operation: 'run_shell_command', error: 'Operation stopped by user.' });
    }

    const cfg = this._context.getShellCommandReviewSettings();
    const apiConfig = this._context.getApiConfig();
    const confirmShell = apiConfig.confirmShellCommand !== false;

    if (!cfg.enabled) {
      if (confirmShell) {
        const approved = await this._context.userConfirmShellCommand(proposedFromTool);
        if (!approved) {
          return JSON.stringify({ success: false, error: 'User cancelled shell command' });
        }
      }
      return await runShellCommandTool({ command: proposedFromTool });
    }

    // Fast preflight: avoid expensive multi-round LLM review for commands that are policy-rejected anyway.
    // This fixes cases like "dir src/webview /B" where shell review is guaranteed to FAIL (no-shell-for-context).
    const bypass = detectShellFileOpBypass(proposedFromTool);
    if (bypass) {
      return JSON.stringify({
        success: false,
        operation: 'run_shell_command',
        error: 'Shell command rejected (file operation via shell).',
        reviewNotesAccumulated: [bypass],
        originalToolCommand: proposedFromTool,
      });
    }
    const harvest = detectShellContextHarvest(proposedFromTool);
    if (harvest) {
      return JSON.stringify({
        success: false,
        operation: 'run_shell_command',
        error: 'Shell command rejected (no-shell-for-context).',
        reviewNotesAccumulated: [harvest],
        originalToolCommand: proposedFromTool,
      });
    }

    const userRequest = this._context.getLastUserTextForTools();
    const relatedContextBase = this._context.getRelatedContextForTodolistReview();
    const memoryExcerpt = loadMemoryExcerpt();

    const todoInfo = this.getTodoControlInfo();
    const todoBlock = todoInfo
      ? `## Todo context\n**Goal**: ${todoInfo.goal}\n\n**Items**:\n${todoInfo.list}\n\n**Remaining**: ${todoInfo.remaining}\n`
      : `## Todo context\n(none)\n`;

    const recentShell =
      this._lastShellExecutions.length > 0
        ? `## Recent shell commands (most recent first)\n${this._lastShellExecutions
            .slice(0, 5)
            .map((x, i) => `${i + 1}. ${x.command}`)
            .join('\n')}\n`
        : `## Recent shell commands\n(none)\n`;

    const relatedContext = `${relatedContextBase || '(none)'}\n\n${todoBlock}\n${recentShell}`;

    let reviewNotes: string[] = [];
    let commandCandidate = proposedFromTool;

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      if (this._stopped()) {
        return JSON.stringify({ success: false, operation: 'run_shell_command', error: 'Operation stopped by user.' });
      }
      try {
        this._log('shellEditor', 'request', { attempt, proposedFromTool, priorCandidate: commandCandidate, reviewNotes });
        const edited = await shellEditorCandidate({
          apiConfig,
          userRequest,
          relatedContext,
          projectConstraints: memoryExcerpt,
          proposedFromTool,
          priorCandidate: commandCandidate,
          reviewNotes,
          editorTimeoutMs: cfg.editorTimeoutMs,
          signal: this._signal(),
          log: (e) => this._context.log?.(e),
        });
        commandCandidate = edited.command;
        this._log('shellEditor', 'response', { attempt, command: commandCandidate });
      } catch (e: any) {
        if (e?.name === 'AbortError' || this._stopped()) {
          return JSON.stringify({ success: false, operation: 'run_shell_command', error: 'Operation stopped by user.' });
        }
        this._log('shellEditor', 'error', { attempt, error: e?.message ?? String(e) });
        return JSON.stringify({
          success: false,
          operation: 'run_shell_command',
          error: `Shell editor agent failed: ${e.message}`,
          reviewNotesAccumulated: reviewNotes,
        });
      }

      if (this._stopped()) {
        return JSON.stringify({ success: false, operation: 'run_shell_command', error: 'Operation stopped by user.' });
      }
      this._log('shellReview', 'request', { attempt, command: commandCandidate, proposedFromTool });
      let review;
      try {
        review = await reviewShellCommand({
          apiConfig,
          userRequest,
          relatedContext,
          projectConstraints: memoryExcerpt,
          command: commandCandidate,
          proposedFromTool,
          reviewTimeoutMs: cfg.reviewTimeoutMs,
          signal: this._signal(),
          log: (e) => this._context.log?.(e),
        });
      } catch (e: any) {
        if (e?.name === 'AbortError' || this._stopped()) {
          return JSON.stringify({ success: false, operation: 'run_shell_command', error: 'Operation stopped by user.' });
        }
        return JSON.stringify({
          success: false,
          operation: 'run_shell_command',
          error: `Shell review agent failed: ${e?.message ?? String(e)}`,
          reviewNotesAccumulated: reviewNotes,
        });
      }
      this._log('shellReview', 'response', { attempt, decision: review.decision, summary: review.summary, notes: review.notes });

      if (review.decision === 'PASS') {
        if (attempt > 1) {
          this._context.post({
            type: 'addMessage',
            message: {
              role: 'assistant',
              content:
                `✅ **Shell review** · passed on round **${attempt}/${cfg.maxAttempts}** (command was refined until review passed).`,
            },
          });
        }
        if (confirmShell) {
          if (this._stopped()) {
            return JSON.stringify({ success: false, operation: 'run_shell_command', error: 'Operation stopped by user.' });
          }
          const approved = await this._context.userConfirmShellCommand(commandCandidate);
          if (!approved) {
            return JSON.stringify({
              success: false,
              error: 'User cancelled shell command',
              reviewedCommand: commandCandidate,
            });
          }
        }
        if (this._stopped()) {
          return JSON.stringify({ success: false, operation: 'run_shell_command', error: 'Operation stopped by user.' });
        }
        const execResult = await runShellCommandTool({ command: commandCandidate });
        // Record recent executions to help the reviewer avoid redundant reruns.
        this._lastShellExecutions.unshift({ command: commandCandidate, at: Date.now() });
        if (this._lastShellExecutions.length > 20) {
          this._lastShellExecutions.length = 20;
        }
        try {
          const parsed = JSON.parse(execResult) as Record<string, unknown>;
          return JSON.stringify({
            ...parsed,
            shellReviewAttempts: attempt,
            reviewedCommand: commandCandidate,
            originalToolCommand: proposedFromTool,
          });
        } catch {
          return execResult;
        }
      }

      // If the reviewer indicates the shell approach is fundamentally wrong for this step,
      // stop immediately rather than burning more LLM rounds.
      if (shouldEarlyStopOnShellReviewFail(review)) {
        reviewNotes = mergeReviewNotes(reviewNotes, review.notes);
        return JSON.stringify({
          success: false,
          operation: 'run_shell_command',
          error: 'run_shell_command: reviewer indicates this should not be done via shell; stopping retries.',
          reviewNotesAccumulated: reviewNotes,
          lastCandidateCommand: commandCandidate,
          shellReviewAttempts: attempt,
          reviewedCommand: commandCandidate,
          originalToolCommand: proposedFromTool,
          message: 'No command was executed. Follow reviewer guidance (use workspace tools instead) and retry only if the goal truly requires shell.',
        });
      }

      reviewNotes = mergeReviewNotes(reviewNotes, review.notes);
      if (attempt >= cfg.maxAttempts) {
        return JSON.stringify({
          success: false,
          operation: 'run_shell_command',
          error: `run_shell_command: review did not pass after ${cfg.maxAttempts} attempt(s).`,
          reviewNotesAccumulated: reviewNotes,
          lastCandidateCommand: commandCandidate,
          message: 'No command was executed. Adjust the request or tool arguments from reviewer feedback and retry.',
        });
      }

      this._context.post({
        type: 'addMessage',
        message: {
          role: 'assistant',
          content:
            `🔁 **Shell review** · round **${attempt}/${cfg.maxAttempts}** — not passed\n\n` +
            `${review.summary || 'See tool result for reviewer notes.'}\n\n` +
            `_Regenerating command…_`,
        },
      });
    }

    return JSON.stringify({
      success: false,
      operation: 'run_shell_command',
      error: 'Unexpected shell command review loop exit.',
    });
  }

  /** `compact` is handled in MessageHandler and delegated to ConversationService.compactHistory. */

  public clearTodoList(): void {
    this._todoList = null;
  }

  /**
   * Lightweight todo state for the main loop to decide whether to keep going.
   * Returns null when no todo list exists.
   */
  public getTodoControlInfo(): { goal: string; list: string; remaining: number } | null {
    if (!this._todoList) {
      return null;
    }
    const { list, remaining } = this._todoMarkdown(this._todoList.goal, this._todoList.items);
    return { goal: this._todoList.goal, list, remaining };
  }

  private _cloneTodoState(): TodoState | null {
    if (!this._todoList) {
      return null;
    }
    return {
      goal: this._todoList.goal,
      items: this._todoList.items.map((i) => ({ ...i })),
    };
  }

  private _todoMarkdown(goal: string, items: { text: string; done: boolean }[]): { list: string; remaining: number } {
    const list = items.map((item, i) => `${i + 1}. [${item.done ? 'x' : ' '}] ${item.text}`).join('\n');
    const remaining = items.filter((i) => !i.done).length;
    return { list, remaining };
  }

  private _postTodoDisplay(kind: 'created' | 'expanded', goal: string, list: string, remaining: number): void {
    if (kind === 'expanded') {
      this._context.post({
        type: 'addMessage',
        message: {
          role: 'assistant',
          content: `Todo list expanded:\n\n**Goal**: ${goal}\n\n**Items**:\n${list}\n\n**Remaining**: ${remaining} item(s)`,
        },
      });
    } else {
      this._context.post({
        type: 'addMessage',
        message: { role: 'assistant', content: `Todo list created:\n\n**Goal**: ${goal}\n\n**Items**:\n${list}` },
      });
    }
  }

  /** Legacy path when todolist review is disabled in settings. */
  private _createTodoListWithoutReview(
    goal: string,
    items: string[],
    expandIndex: number | undefined
  ): string {
    if (this._todoList && expandIndex !== undefined) {
      if (expandIndex < 0 || expandIndex >= this._todoList.items.length) {
        return JSON.stringify({
          error: `Expand index ${expandIndex} is out of range (0–${this._todoList.items.length - 1}).`,
        });
      }
      const newItems = items.map((text) => ({ text, done: false }));
      this._todoList.items.splice(expandIndex, 1, ...newItems);
      const { list, remaining } = this._todoMarkdown(this._todoList.goal, this._todoList.items);
      const result = JSON.stringify({
        success: true,
        message: `Todo list expanded at index ${expandIndex} with ${items.length} items.`,
        goal: this._todoList.goal,
        items: list,
        remaining,
      });
      this._postTodoDisplay('expanded', this._todoList.goal, list, remaining);
      return result;
    }

    this._todoList = { goal, items: items.map((text) => ({ text, done: false })) };
    const { list } = this._todoMarkdown(goal, this._todoList.items);
    const result = JSON.stringify({
      success: true,
      message: `Todo list created with ${items.length} items.`,
      goal,
      items: list,
    });
    this._postTodoDisplay('created', goal, list, this._todoList.items.filter((i) => !i.done).length);
    return result;
  }

  private async _handleCreateTodoList(args: Record<string, unknown>): Promise<string> {
    const goal = args['goal'] as string;
    const items = (args['items'] as string[]) || [];
    const expandIndex = args['expandIndex'] as number | undefined;
    const cfg = this._context.getTodolistReviewSettings();
    const apiConfig = this._context.getApiConfig();

    if (!cfg.enabled) {
      return this._createTodoListWithoutReview(goal, items, expandIndex);
    }
    if (this._stopped()) {
      return JSON.stringify({ success: false, operation: 'create_todo_list', error: 'Operation stopped by user.' });
    }

    const userRequest = this._context.getLastUserTextForTools();
    const relatedContext = this._context.getRelatedContextForTodolistReview();
    const memoryExcerpt = loadMemoryExcerpt();

    if (this._todoList && expandIndex !== undefined) {
      if (expandIndex < 0 || expandIndex >= this._todoList.items.length) {
        return JSON.stringify({
          error: `Expand index ${expandIndex} is out of range (0–${this._todoList.items.length - 1}).`,
        });
      }
      if (!items.length) {
        return JSON.stringify({ error: 'todolist.edit requires a non-empty items array for expansion.' });
      }

      const baselineFrozen = this._cloneTodoState()!;
      const intentReplacement = items.map((t) => String(t));
      let replacementSlice = [...intentReplacement];
      let reviewNotes: string[] = [];

      for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        if (this._stopped()) {
          return JSON.stringify({ success: false, operation: 'todolist.edit', error: 'Operation stopped by user.' });
        }
        const baselineForApply: TodoState = baselineFrozen;
        let modified: TodoState;
        try {
          modified = applyExpandToClone(baselineForApply, expandIndex, replacementSlice);
        } catch (e: any) {
          return JSON.stringify({ success: false, operation: 'todolist.edit', error: e.message });
        }

        const changeSummary = `Replace item ${expandIndex} with ${replacementSlice.length} new step(s). Tool goal: ${goal}`;
        this._log('todolistReview', 'request', { operation: 'edit', attempt, expandIndex, changeSummary });
        let review;
        try {
          review = await reviewTodolistEdit({
            apiConfig,
            userRequest,
            operationGoal: goal,
            baseline: baselineFrozen,
            modified,
            expandIndex,
            changeSummary,
            projectConstraints: memoryExcerpt,
            relatedContext,
            reviewNotesAccumulated: reviewNotes,
            reviewTimeoutMs: cfg.reviewTimeoutMs,
            signal: this._signal(),
            log: (e) => this._context.log?.(e),
          });
        } catch (e: any) {
          if (e?.name === 'AbortError' || this._stopped()) {
            return JSON.stringify({ success: false, operation: 'todolist.edit', error: 'Operation stopped by user.' });
          }
          return JSON.stringify({ success: false, operation: 'todolist.edit', error: `Review agent failed: ${e?.message ?? String(e)}` });
        }
        this._log('todolistReview', 'response', { operation: 'edit', attempt, decision: review.decision, summary: review.summary, notes: review.notes });

        if (review.decision === 'PASS') {
          this._todoList = {
            goal: modified.goal,
            items: modified.items.map((x) => ({ ...x })),
          };
          const { list, remaining } = this._todoMarkdown(this._todoList.goal, this._todoList.items);
          const result = JSON.stringify({
            success: true,
            operation: 'todolist.edit',
            message: `Todo list expanded at index ${expandIndex} with ${replacementSlice.length} items.`,
            goal: this._todoList.goal,
            items: list,
            remaining,
            reviewAttempts: attempt,
          });
          this._postTodoDisplay('expanded', this._todoList.goal, list, remaining);
          if (attempt > 1) {
            this._context.post({
              type: 'addMessage',
              message: {
                role: 'assistant',
                content:
                  `✅ **Todo list (expand) review** · passed on round **${attempt}/${cfg.maxAttempts}**.`,
              },
            });
          }
          return result;
        }

        reviewNotes = mergeReviewNotes(reviewNotes, review.notes);
        if (attempt >= cfg.maxAttempts) {
          return JSON.stringify({
            success: false,
            operation: 'todolist.edit',
            error: `todolist.edit: review did not pass after ${cfg.maxAttempts} attempt(s).`,
            reviewNotesAccumulated: reviewNotes,
            message: 'No changes were applied. Adjust create_todo_list (expand) from reviewer feedback and retry.',
          });
        }

        this._context.post({
          type: 'addMessage',
          message: {
            role: 'assistant',
            content:
              `🔁 **Todo list (expand) review** · round **${attempt}/${cfg.maxAttempts}** — not passed\n\n` +
              `${review.summary || 'See reviewer notes in tool result.'}\n\n` +
              `_Regenerating expanded items…_`,
          },
        });

        try {
          this._log('todolistWriter', 'request', { operation: 'edit', attempt, expandIndex, proposedNewItems: intentReplacement, reviewNotes });
          const edited = await editorExpandCandidate({
            apiConfig,
            userRequest,
            baseline: baselineFrozen,
            expandIndex,
            proposedNewItems: intentReplacement,
            reviewNotes,
            projectConstraints: memoryExcerpt,
            editorTimeoutMs: cfg.editorTimeoutMs,
            signal: this._signal(),
            log: (e) => this._context.log?.(e),
          });
          replacementSlice = edited.replacementItems;
          this._log('todolistWriter', 'response', { operation: 'edit', attempt, replacementItems: replacementSlice });
        } catch (e: any) {
          this._log('todolistWriter', 'error', { operation: 'edit', attempt, error: e?.message ?? String(e) });
          return JSON.stringify({
            success: false,
            operation: 'todolist.edit',
            error: `Editor agent failed: ${e.message}`,
            reviewNotesAccumulated: reviewNotes,
          });
        }
      }

      return JSON.stringify({ success: false, operation: 'todolist.edit', error: 'Unexpected edit review loop exit.' });
    }

    let reviewNotes: string[] = [];
    let cg = goal;
    let ci = items.map((t) => String(t));
    const operationGoal = goal;

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      if (this._stopped()) {
        return JSON.stringify({ success: false, operation: 'todolist.generate', error: 'Operation stopped by user.' });
      }
      this._log('todolistReview', 'request', { operation: 'generate', attempt, candidateGoal: cg, candidateItems: ci });
      let review;
      try {
        review = await reviewTodolistGenerate({
          apiConfig,
          userRequest,
          operationGoal,
          candidateGoal: cg,
          candidateItems: ci,
          projectConstraints: memoryExcerpt,
          relatedContext,
          reviewTimeoutMs: cfg.reviewTimeoutMs,
          signal: this._signal(),
          log: (e) => this._context.log?.(e),
        });
      } catch (e: any) {
        if (e?.name === 'AbortError' || this._stopped()) {
          return JSON.stringify({ success: false, operation: 'todolist.generate', error: 'Operation stopped by user.' });
        }
        return JSON.stringify({ success: false, operation: 'todolist.generate', error: `Review agent failed: ${e?.message ?? String(e)}` });
      }
      this._log('todolistReview', 'response', { operation: 'generate', attempt, decision: review.decision, summary: review.summary, notes: review.notes });

      if (review.decision === 'PASS') {
        this._todoList = { goal: cg, items: ci.map((text) => ({ text, done: false })) };
        const { list, remaining } = this._todoMarkdown(cg, this._todoList.items);
        const result = JSON.stringify({
          success: true,
          operation: 'todolist.generate',
          message: `Todo list created with ${ci.length} items.`,
          goal: cg,
          items: list,
          reviewAttempts: attempt,
        });
        this._postTodoDisplay('created', cg, list, remaining);
        if (attempt > 1) {
          this._context.post({
            type: 'addMessage',
            message: {
              role: 'assistant',
              content:
                `✅ **Todo list (generate) review** · passed on round **${attempt}/${cfg.maxAttempts}**.`,
            },
          });
        }
        return result;
      }

      reviewNotes = mergeReviewNotes(reviewNotes, review.notes);
      if (attempt >= cfg.maxAttempts) {
        return JSON.stringify({
          success: false,
          operation: 'todolist.generate',
          error: `todolist.generate: review did not pass after ${cfg.maxAttempts} attempt(s).`,
          reviewNotesAccumulated: reviewNotes,
          message: 'No todo list was saved. Revise create_todo_list from reviewer feedback and retry.',
        });
      }

      this._context.post({
        type: 'addMessage',
        message: {
          role: 'assistant',
          content:
            `🔁 **Todo list (generate) review** · round **${attempt}/${cfg.maxAttempts}** — not passed\n\n` +
            `${review.summary || 'See reviewer notes in tool result.'}\n\n` +
            `_Regenerating goal and items…_`,
        },
      });

      try {
        this._log('todolistWriter', 'request', { operation: 'generate', attempt, priorGoal: cg, priorItems: ci, reviewNotes });
        const next = await regenerateGenerateCandidate({
          apiConfig,
          userRequest,
          priorGoal: cg,
          priorItems: ci,
          reviewNotes,
          projectConstraints: memoryExcerpt,
          reviewTimeoutMs: cfg.reviewTimeoutMs,
          signal: this._signal(),
          log: (e) => this._context.log?.(e),
        });
        cg = next.goal;
        ci = next.items;
        this._log('todolistWriter', 'response', { operation: 'generate', attempt, goal: cg, items: ci });
      } catch (e: any) {
        this._log('todolistWriter', 'error', { operation: 'generate', attempt, error: e?.message ?? String(e) });
        return JSON.stringify({
          success: false,
          operation: 'todolist.generate',
          error: `Regeneration failed: ${e.message}`,
          reviewNotesAccumulated: reviewNotes,
        });
      }
    }

    return JSON.stringify({ success: false, operation: 'todolist.generate', error: 'Unexpected generate review loop exit.' });
  }
}