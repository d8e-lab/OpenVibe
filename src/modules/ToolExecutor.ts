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
import type { ReplaceCheckContext } from '../tools';
import type { ApiConfig } from '../types';
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

export class ToolExecutor {
  private _todoList: { goal: string; items: { text: string; done: boolean }[] } | null = null;

  constructor(
    private readonly _context: {
      post: (message: any) => void;
      llmCheckReplace: (ctx: ReplaceCheckContext) => Promise<boolean>;
      userConfirmReplace: (ctx: ReplaceCheckContext) => Promise<boolean>;
      getApiConfig: () => ApiConfig & { confirmChanges?: boolean };
      getLastUserTextForTools: () => string;
      getRelatedContextForTodolistReview: () => string;
      getTodolistReviewSettings: () => TodolistReviewSettings;
    }
  ) {}

  public async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
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
          },
          (ctx) => this._context.llmCheckReplace(ctx),
          this._context.getApiConfig().confirmChanges !== false ? (ctx) => this._context.userConfirmReplace(ctx) : undefined
        );

      case 'create_directory':
        return createDirectoryTool({
          dirPath: args.dirPath as string,
          recursive: args.recursive as boolean | undefined,
        });

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
        return await runShellCommandTool({ command: args.command as string });

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

  /** `compact` is handled in MessageHandler and delegated to ConversationService.compactHistory. */

  public clearTodoList(): void {
    this._todoList = null;
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
      let candidateGoal = baselineFrozen.goal;
      let reviewNotes: string[] = [];

      for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        const baselineForApply: TodoState = {
          goal: candidateGoal,
          items: baselineFrozen.items.map((x) => ({ ...x })),
        };
        let modified: TodoState;
        try {
          modified = applyExpandToClone(baselineForApply, expandIndex, replacementSlice);
        } catch (e: any) {
          return JSON.stringify({ success: false, operation: 'todolist.edit', error: e.message });
        }

        const changeSummary = `Replace item ${expandIndex} with ${replacementSlice.length} new step(s). Tool goal: ${goal}`;
        const review = await reviewTodolistEdit({
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
        });

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
              type: 'info',
              message: `Todo list (edit) passed review after ${attempt} attempt(s).`,
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

        try {
          const edited = await editorExpandCandidate({
            apiConfig,
            userRequest,
            baseline: baselineFrozen,
            expandIndex,
            proposedNewItems: intentReplacement,
            reviewNotes,
            projectConstraints: memoryExcerpt,
            editorTimeoutMs: cfg.editorTimeoutMs,
          });
          replacementSlice = edited.replacementItems;
          if (edited.goal?.trim()) {
            candidateGoal = edited.goal.trim();
          }
        } catch (e: any) {
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
      const review = await reviewTodolistGenerate({
        apiConfig,
        userRequest,
        operationGoal,
        candidateGoal: cg,
        candidateItems: ci,
        projectConstraints: memoryExcerpt,
        relatedContext,
        reviewTimeoutMs: cfg.reviewTimeoutMs,
      });

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
            type: 'info',
            message: `Todo list (generate) passed review after ${attempt} attempt(s).`,
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

      try {
        const next = await regenerateGenerateCandidate({
          apiConfig,
          userRequest,
          priorGoal: cg,
          priorItems: ci,
          reviewNotes,
          projectConstraints: memoryExcerpt,
          reviewTimeoutMs: cfg.reviewTimeoutMs,
        });
        cg = next.goal;
        ci = next.items;
      } catch (e: any) {
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