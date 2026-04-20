import type { ToolDefinition } from './types';

export const CLI_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_workspace_info',
      description: 'Get workspace root and top-level entries.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file content by line range.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_in_file',
      description: 'Find exact string in file and return context.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          searchString: { type: 'string' },
          contextBefore: { type: 'number' },
          contextAfter: { type: 'number' },
          occurrence: { type: 'number' },
        },
        required: ['filePath', 'searchString'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: 'Replace line range with new content.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
          newContent: { type: 'string' },
        },
        required: ['filePath', 'startLine', 'endLine', 'newContent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create directory recursively in workspace.',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string' },
          recursive: { type: 'boolean' },
        },
        required: ['dirPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell_command',
      description: 'Run one shell command in workspace root.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Signal task completion.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: [],
      },
    },
  },
];

