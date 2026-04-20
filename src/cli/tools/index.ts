import * as path from 'path';
import * as fs from 'fs';

// ─── Path helpers for CLI ─────────────────────────────────────────────────

/**
 * CLI版本的工作区根目录获取
 * 使用当前工作目录作为工作区根目录
 */
function getWorkspaceRoot(): string {
  return process.cwd();
}

function resolveWorkspacePath(filePath: string): string {
  const root = getWorkspaceRoot();
  const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Access denied: path is outside workspace: ${filePath}`);
  }
  return abs;
}

function readLines(absPath: string): { lines: string[]; crlf: boolean } {
  const raw = fs.readFileSync(absPath, 'utf-8');
  const crlf = raw.includes('\r\n');
  return { lines: raw.split(/\r?\n/), crlf };
}

// ─── CLI read_file tool ───────────────────────────────────────────────────

export interface ReadFileParams {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

/**
 * CLI版本的 read_file 工具实现
 * 返回格式与 VS Code 扩展保持一致，便于统一处理
 */
export function readFileTool(params: ReadFileParams): string {
  let absPath: string;
  try {
    absPath = resolveWorkspacePath(params.filePath);
  } catch (e: any) {
    return JSON.stringify({ error: e.message });
  }

  if (!fs.existsSync(absPath)) {
    return JSON.stringify({ error: `File not found: ${params.filePath}` });
  }

  const { lines } = readLines(absPath);
  const total = lines.length;
  const start = Math.max(1, params.startLine ?? 1);
  const end = Math.min(total, params.endLine ?? total);

  const content = lines
    .slice(start - 1, end)
    .map((l, i) => `${start + i}: ${l}`)
    .join('');

  return JSON.stringify({ 
    content, 
    totalLines: total, 
    startLine: start, 
    endLine: end 
  });
}

/**
 * CLI版本的 get_workspace_info 工具
 */
export function getWorkspaceInfoTool(): string {
  const root = getWorkspaceRoot();
  
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root).filter(
      (f) => !f.startsWith('.') && f !== 'node_modules' && f !== 'out' && f !== 'dist'
    );
  } catch { /* ignore read errors */ }

  return JSON.stringify({
    workspaceRoot: root,
    topLevelEntries: entries,
    hint: 'Use relative paths (e.g., "src/index.ts") when calling read_file or find_in_file.',
    osPlatform: process.platform,
    osType: 'CLI',
    arch: process.arch,
    pathSeparator: path.sep,
    defaultNewFileLineEndings: 'LF'
  });
}