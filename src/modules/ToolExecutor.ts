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

export class ToolExecutor {
  private _todoList: { goal: string; items: { text: string; done: boolean }[] } | null = null;

  constructor(
    private readonly _context: {
      post: (message: any) => void;
      llmCheckReplace: (ctx: ReplaceCheckContext) => Promise<boolean>;
      userConfirmReplace: (ctx: ReplaceCheckContext) => Promise<boolean>;
      getApiConfig: () => { confirmChanges?: boolean };
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

      case 'create_todo_list': {
        const goal = args['goal'] as string;
        const items = (args['items'] as string[]) || [];
        const expandIndex = args['expandIndex'] as number | undefined;

        // 处理扩展模式
        if (this._todoList && expandIndex !== undefined) {
          if (expandIndex < 0 || expandIndex >= this._todoList.items.length) {
            return JSON.stringify({ error: `Expand index ${expandIndex} is out of range (0–${this._todoList.items.length - 1}).` });
          }
          
          const newItems = items.map(text => ({ text, done: false }));
          this._todoList.items.splice(expandIndex, 1, ...newItems);
          
          const list = this._todoList.items
            .map((item, i) => `${i + 1}. [${item.done ? 'x' : ' '}] ${item.text}`)
            .join('\n');
          const remaining = this._todoList.items.filter(i => !i.done).length;
          const result = JSON.stringify({
            success: true,
            message: `Todo list expanded at index ${expandIndex} with ${items.length} items.`,
            goal: this._todoList.goal,
            items: list,
            remaining,
          });
          
          const todoListDisplay = `Todo list expanded:

**Goal**: ${this._todoList.goal}

**Items**:
${list}

**Remaining**: ${remaining} item(s)`;
          this._context.post({ type: 'addMessage', message: { role: 'assistant', content: todoListDisplay } });
          
          return result;
        }
        
        // 创建新列表
        this._todoList = {
          goal,
          items: items.map(text => ({ text, done: false })),
        };
        const list = items.map((item, i) => `${i + 1}. [ ] ${item}`).join('\n');
        const result = JSON.stringify({
          success: true,
          message: `Todo list created with ${items.length} items.`,
          goal,
          items: list,
        });
        
        const todoListDisplay = `Todo list created:

**Goal**: ${goal}

**Items**:
${list}`;
        this._context.post({ type: 'addMessage', message: { role: 'assistant', content: todoListDisplay } });
        
        return result;
      }

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
}