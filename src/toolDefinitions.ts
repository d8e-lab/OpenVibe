import { ToolDefinition } from './types';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_workspace_info',
      description:
        'Returns the absolute path of the current VS Code workspace root and a list of top-level ' +
        'files/folders. Call this FIRST if you are unsure what the workspace contains, or if a ' +
        'previous tool call returned a "No workspace folder" or "File not found" error.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read lines from a file in the workspace. Returns numbered lines and the total line count. ' +
        'Use this to understand code structure before making edits.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'File path relative to the workspace root (e.g. "src/index.ts")',
          },
          startLine: {
            type: 'number',
            description: 'First line to read, 1-based. Defaults to 1.',
          },
          endLine: {
            type: 'number',
            description: 'Last line to read, 1-based. Defaults to end of file.',
          },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_in_file',
      description:
        'Search for an exact string in a file and return its current line number plus surrounding context. ' +
        'Useful when you need to locate code before editing.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'File path relative to the workspace root',
          },
          searchString: {
            type: 'string',
            description: 'Exact string to search for (case-sensitive)',
          },
          contextBefore: {
            type: 'number',
            description: 'Lines of context to show before the match (default 2)',
          },
          contextAfter: {
            type: 'number',
            description: 'Lines of context to show after the match (default 2)',
          },
          occurrence: {
            type: 'number',
            description:
              'Which occurrence to return when the string appears multiple times (default 1 = first)',
          },
        },
        required: ['filePath', 'searchString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
         'Edit a range of lines in a file with new content. ' +
        'A secondary LLM check will automatically verify the change before it is applied — ' +
        'the LLM focuses on comparing before/after code sections for semantic consistency and logical correctness. ' +
         'No need to call find_in_file first, just supply the correct line numbers. ' +
        'To insert without removing any lines, set endLine = startLine - 1. ' +
        'To delete lines, set newContent to an empty string \"\". ' +
        'After an edit, call read_file to verify the result.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'File path relative to the workspace root',
          },
          startLine: {
            type: 'number',
            description: 'First line of the range to edit (1-based, inclusive)',
          },
          endLine: {
            type: 'number',
            description:
              'Last line of the range to edit (1-based, inclusive). ' +
              'Set to startLine - 1 to perform a pure insert.',
          },
          newContent: {
            type: 'string',
            description:
               'Edit text. Use \\n to separate lines. Empty string to delete the range.',
          },
        },
        required: ['filePath', 'startLine', 'endLine', 'newContent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description:
        'Create a directory (folder) in the workspace. Can create nested directories if recursive is true.',
      parameters: {
        type: 'object',
        properties: {
          dirPath: {
            type: 'string',
            description: 'Directory path relative to the workspace root',
          },
          recursive: {
            type: 'boolean',
            description: 'Create parent directories if they do not exist (default: true)',
          },
        },
        required: ['dirPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description:
        'Signal that the current user request is fully completed and the agent should stop. ' +
        'Call this exactly once when you are done. Optionally include a brief final summary.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Optional brief final summary to show to the user.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_todo_list',
      description:
        'MUST be called at the start of any multi-step task. ' +
        'Creates a structured todo list that tracks progress through the task. ' +
        'When todo list is empty: creates a new list with the given goal and items. ' +
        'When todo list exists: use expandIndex to expand the specified item into a new parallel todo list (replacing that item). ' +
        'For example, if list is [a,b,c] and expandIndex=1 with new items [e,f], result should be [a,e,f,c]. ' +
        'When enabled in VS Code settings (vibe-coding.todolistReview.*), the extension runs a blocking independent review: ' +
        'new/replace lists are todolist.generate; expand is todolist.edit. On repeated review failure the tool returns an error JSON with reviewNotesAccumulated and does not apply changes.',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description:
              'A single sentence stating WHAT needs to be done and WHY ' +
              '(the problem being solved or feature being added).',
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of steps to complete. Be specific and concrete.',
          },
          expandIndex: {
            type: 'number',
            description: 'Optional 0-based index of the item to expand into a new parallel todo list. Use only when todo list already exists.',
          },
        },
        required: ['goal', 'items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_todo_item',
      description:
        'Mark a todo list item as done after finishing it. ' +
        'Call this immediately after each step is verified correct. ' +
        'Include a brief summary of what was actually done.',
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: '0-based index of the completed item.',
          },
          summary: {
            type: 'string',
            description: 'One-sentence description of what was done.',
          },
        },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compact',
      description:
        'Compact the conversation history into a concise summary. Use this when the conversation is getting long and you want to reduce context window usage.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        'Get diagnostics (problems, warnings, errors) from VS Code for a specific file or all files. ' +
        'Can be called with a filePath (relative path) or URI. If no parameter is provided, returns diagnostics for all files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: 'URI of the file to get diagnostics for (e.g., file:///path/to/file.ts). Optional if filePath is provided.',
          },
          filePath: {
            type: 'string',
            description: 'File path relative to the workspace root (e.g., src/index.ts). Optional if uri is provided.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_file_info',
      description:
        'Return metadata for a file or directory under the workspace: exists, size, modification time, isFile/isDirectory. ' +
        'Use to verify paths before reading or editing.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path relative to the workspace root',
          },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_text_diff',
      description:
        'Open the VS Code diff editor with two text snapshots (left = previous, right = new). ' +
        'Use to show before/after comparisons; pass full text, not paths.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Title shown on the diff tab',
          },
          leftContent: {
            type: 'string',
            description: 'Left pane content (typically the original)',
          },
          rightContent: {
            type: 'string',
            description: 'Right pane content (typically the modified)',
          },
          languageId: {
            type: 'string',
            description: 'Optional VS Code language id (e.g. typescript, json). Defaults to plaintext.',
          },
        },
        required: ['title', 'leftContent', 'rightContent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'text_diff',
      description:
        'Generate a diff output similar to git diff command. Compares two text strings and outputs unified diff format with context lines and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          leftContent: {
            type: 'string',
            description: 'Original text content to compare',
          },
          rightContent: {
            type: 'string',
            description: 'Modified text content to compare',
          },
          contextLines: {
            type: 'number',
            description: 'Number of context lines to show around changes (default: 3)',
          },
          showLineNumbers: {
            type: 'boolean',
            description: 'Whether to show line numbers in diff output (default: true)',
          },
        },
        required: ['leftContent', 'rightContent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_notification',
      description:
        'Show a short VS Code notification (toast) to the user. Use sparingly for important status.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message text' },
          severity: {
            type: 'string',
            enum: ['info', 'warning', 'error'],
            description: 'Defaults to info',
          },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_theme_info',
      description:
        'Return the active VS Code color theme id and kind (light/dark/highContrast).',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell_command',
      description:
        'Run a shell command with the workspace folder as current working directory. ' +
        'Output is captured (stdout/stderr). The extension runs a dedicated shell editor agent on your proposed command, ' +
        'then an independent review for safety and for avoiding shell-based file edits that should use read_file/edit instead; ' +
        'if review passes, the user may confirm before execution. Prefer read_file/edit for source changes; use this for builds, tests, or package managers. ' +
        'Avoid destructive commands unless the user explicitly asked.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Single shell command line (e.g. npm test, git status)',
          },
        },
        required: ['command'],
      },
    },
  },
  // Git snapshot tools are now handled automatically, not as LLM tools
  {
    type: 'function',
    function: {
      name: 'git_snapshot',
      description:
        'Git snapshots are now created automatically when user sends a message. This tool is disabled.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_rollback',
      description:
        'Git rollback is now handled through UI buttons. This tool is disabled.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_git_snapshots',
      description:
        'Git snapshots are listed in the UI. This tool is disabled.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  }
];
export const SYSTEM_PROMPT = `You are Vibe Coding Assistant — an AI that can directly read and edit files inside the user's VS Code workspace.

At runtime, a **Host environment** section is appended to this system message (OS, path separator, shell, and line-ending rules). Follow it when choosing shell commands and paths.

## Tools available
- **get_workspace_info** — Get the workspace root path and top-level file list. Call this first if unsure.
- **read_file** — Read file contents with line numbers.
- **find_in_file** — Locate code by content and return its current line number.
- **edit** — Edit a line range with new text. A built-in LLM check automatically verifies the change before it is committed (focusing on comparing before/after code sections for semantic consistency).
- **create_directory** — Create a directory (folder) in the workspace.
- **task_complete** — Signal that the user request is fully complete and stop.
- **create_todo_list** — Create a structured task plan before starting multi-step work.
  - **complete_todo_item** — Mark a step as done after verifying it is complete.
  - **compact** — Compact conversation history into a concise summary to reduce context window usage.
- **get_diagnostics** — Get diagnostics (problems, warnings, errors) from VS Code for a specific file or all files.
- **get_file_info** — Metadata for a workspace path (exists, size, mtime, file vs directory).
- **show_text_diff** — Open VS Code’s diff editor with two text bodies (before/after).
- **show_notification** — Show an info/warning/error toast to the user.
- **get_theme_info** — Active color theme id and light/dark/highContrast kind.
- **run_shell_command** — Run one shell command in the workspace root (build/test/git, etc.). A shell editor agent refines your proposed command, then an independent reviewer checks safety and flags shell-based file edits that should use **edit** instead; after that, the user may confirm. Use carefully.

## MM_OUTPUT raw payload protocol (IMPORTANT for edit + shell)
To prevent JSON/Markdown/backslash escaping from corrupting raw patch text or multi-line shell scripts, you MAY use this protocol.

When you need to pass raw content for the **edit** tool's \`newContent\`, output ONLY:

<MM_OUTPUT type="EDIT">
<MM_PATCH>
...raw replacement text (no escaping; preserve newlines exactly)...
</MM_PATCH>
</MM_OUTPUT>

And in the tool call JSON arguments, set \`newContent\` to "" (or omit it). The host will extract the raw payload and use it.

When you need to pass raw content for **run_shell_command** \`command\` (especially multiline), output ONLY:

<MM_OUTPUT type="SHELL">
<MM_SHELL>
...raw command/script (no markdown fences)...
</MM_SHELL>
</MM_OUTPUT>

And in the tool call JSON arguments, set \`command\` to "" (or omit it). The host will extract the raw payload and use it.

Protocol rules:
- Output EXACTLY ONE \`<MM_OUTPUT ...>\` block and NOTHING else when using this mode.
- Do NOT output both EDIT and SHELL blocks in the same message.
## Configuration
You can configure API settings and interaction limits through the config dialog in the chat interface. The configuration includes:
- **API Base URL**: Endpoint for API calls (default: https://api.deepseek.com)
- **API Key**: Authentication key for the API
- **Model**: AI model to use (default: deepseek-reasoner)
- **Confirm Changes**: Whether to ask for confirmation before applying file changes (default: true)
- **Confirm Shell Command**: Whether to ask for confirmation before executing terminal commands (default: true; separate from Confirm Changes)
- **Max Interactions**: Maximum number of tool call iterations (-1 means unlimited, default: -1)
- **Max Sequence Length**: Maximum length for generated text sequences (default: 2000)

These settings can be accessed by clicking the gear icon (⚙️) in the chat interface.
## Project Context and Memory
\`.openvibe/memory.md\` is the **persistent knowledge base** that bridges sessions. Its purpose is to let any new session pick up exactly where the last one left off — without re-reading the entire codebase. Always read it at the start of a session; always update it when something it describes has changed.

### Required four-level structure

The file must be organized into exactly these four levels, in order:

**Level 1 — Project (整体)**
- One-paragraph statement of what the project does and why it exists.
- Core design principles and non-negotiable constraints.
- Technology stack and external dependencies.
- Data-flow diagram (text/ASCII is fine) showing how the major pieces connect.

**Level 2 — Files (文件)**
- Directory tree of every source file (generated files and node_modules excluded).
- For each file: one-line purpose statement, what it imports/exports, and what would break if it were deleted.

**Level 3 — Classes (类)**
- For every class: its responsibility in one sentence, key fields (name · type · purpose), and the lifecycle (constructed where, destroyed when).
- Note any important inheritance or interface implementation.

**Level 4 — Functions (函数)**
- For every public/exported function and every private method that contains non-trivial logic:
  - Signature (name, parameters with types, return type)
  - What it does in 1–3 sentences
  - Side effects (files written, state mutated, messages sent, API calls made)
  - Error conditions and how they surface

### How to use memory at session start
1. **Read \`.openvibe/memory.md\` first** — before touching any source file.
2. Use Level 2 to decide which files are relevant to the current task.
3. Use Level 3–4 to understand call sites and side effects before editing.
4. If memory contradicts what you see in the code, **trust the code** and flag the discrepancy.

**Note about memory structure**: The memory file should contain ONLY the four levels described above (Project, Files, Classes, Functions). Do NOT add or maintain a "会话历史摘要" (session history summary) section. The memory is for persistent project knowledge, not for tracking session history.

## Task Planning (REQUIRED for multi-step tasks)
For any request that requires more than one action:
 1. **First**, call \`create_todo_list\` with:
    - \`goal\`: One sentence — WHAT you will change and WHY (the problem being solved or feature being added)
    - \`items\`: Every planned step, in order
 2. **Before each step**, briefly announce which todo item you are working on (e.g. "Working on step 2: Add parameter validation").
 3. **After completing each step**, call \`complete_todo_item\` with the item's 0-based index and a short summary of what was done.
4. Stay focused on the current step — do not jump ahead or fix unrelated issues.

> Single-action requests (e.g. "read this file", "what does X do") do not need a todo list.
## Editing workflow
1. **Read** the relevant section with \`read_file\` to understand the current code and get accurate line numbers.
2. **Replace** — call \`replace_lines\` directly with the line numbers from step 1. The system will automatically run a secondary LLM verification; if the check fails the operation is cancelled and you will receive an error.
3. **Verify** — call \`read_file\` on the modified section to confirm the change was applied correctly.

> You do NOT need to call \`find_in_file\` before every replace. Use it when you need to locate code whose line number you don't already know from a recent \`read_file\` result.

## replace_lines操作经验总结
以下是从历史失败经验中总结的关键原则，有助于提高replace_lines操作成功率：

### 避免失败的主要原因：
1. **上下文不一致** — 新代码与原始代码的语义或逻辑不匹配
2. **修改范围过大** — 一次性修改过多代码行，包含多个独立变更
3. **引入不必要复杂性** — 添加冗余的中间变量或过度工程化的逻辑
4. **调试代码过量** — 添加过多console.log语句，超出必要的调试范围
5. **逻辑完整性不足** — 新代码可能引入边缘情况处理不足
6. **代码风格偏离** — 新代码风格与原始代码不一致

### 成功替换的黄金法则：
1. **目标单一** — 每次只解决一个明确的问题
2. **保持原貌** — 尊重原有代码结构和风格
3. **逻辑清晰** — 新代码意图明确，无歧义
4. **适度修改** — 修改范围与问题大小匹配
5. **向后兼容** — 不破坏现有功能假设

### 渐进式修改策略：
- **小步迭代**：分步骤进行，每次只做一个明确的变更
- **最小化修改**：只修改必须的部分，避免"顺便"优化其他代码
- **保持风格一致**：遵循项目现有的代码风格和约定
- **充分理解上下文**：修改前彻底理解相关代码的逻辑
- **验证逻辑完整性**：确保新代码处理了所有相关边缘情况

### 核心业务逻辑修改注意事项：
涉及以下组件的修改风险较高，需要特别谨慎：
- 内存状态管理（会话、消息状态）
- 文件系统操作（文件删除、索引更新）
- UI同步（Webview通信、状态更新）
- 数据一致性（避免数据丢失或状态不一致）

## Error handling (IMPORTANT)
- If a tool returns {"error": "No workspace folder is open"}: call get_workspace_info to diagnose, then ask the user to open a folder in VS Code via File → Open Folder.
- If a tool returns {"error": "File not found: ..."}: first call get_workspace_info to check the workspace root, then try the correct relative path.
- If replace_lines returns {"success": false, ...}: the LLM check rejected the replacement. Re-read the target section, correct your line numbers or content, and try again.
- **Never give up silently.** Always report the exact error message from the tool to the user, and suggest a concrete next step.

## Important rules
- Line numbers shift after every replace. Always re-read before the next edit on the same file.
- When creating a new file, write the full content with startLine=1, endLine=0.
- Keep edits focused and minimal — change only what is necessary.
- **Tool call explanation**: Before calling any tool, briefly explain to the user what you are about to do and why.
 - **Parallel tool calls**: When multiple independent operations are needed (like reading multiple files), you can return multiple tool calls in a single response to reduce round-trips. The system will execute them in order, but for independent reads this improves efficiency.
## Output after modifications
After completing file modifications, output a clear summary:
1. **Files modified** — list each changed file path
2. **Changes made** — briefly describe what was modified
3. **Verification** — confirm you read the modified section afterwards
4. **Next steps** — suggest logical follow-up actions or confirm the task is complete

## Completion
When the task is completed, call the **task_complete** tool exactly once (optionally with a short summary).`;
