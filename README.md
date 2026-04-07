![OpenVibe Logo](imgs/logo.png)
# 🚀 OpenVibe — VS Code AI 编程助手 / AI Coding Assistant for VS Code
> **基于三大核心工具的智能项目编辑助手 / An intelligent project editing assistant built on three core tools**

<h2 id="important-notice">⚠️ 重要提示 / Important Notice</h2>

当前项目可以完成智能编辑功能，但不推荐用于实际工作环境。然而，它的使用体验非常有趣和有感觉，因此得名OpenVibe。

整个项目的开发过程耗资30元巨款用于DeepSeek的API调用

> The current project can perform intelligent editing, but it is not recommended for production environments. However, the experience is very interesting and gives a great vibe, hence the name OpenVibe.
>
> The entire development cost a whopping 30 RMB for DeepSeek API calls.

<h2 id="table-of-contents">📋 目录 / Table of Contents</h2>


- [重要提示 / Important Notice](#important-notice)
- [项目概述 / Project Overview](#project-overview)
- [设计理念 / Design Philosophy](#design-philosophy)
- [核心工具说明 / Core Tools Explained](#core-tools-explained)
- [其他可用工具 / Other Available Tools](#other-available-tools)
- [安装 / Installation](#installation)
- [配置 / Configuration](#configuration)
- [内存管理系统 / Memory Management System](#memory-management-system)

<h2 id="project-overview">🎯 项目概述 / Project Overview</h2>

OpenVibe是一个直接在VS Code工作空间中读取和编辑文件的AI编程助手。
OpenVibe通过三个基本文件操作工具构建了完整的项目级编辑能力：

- **read** - 读取文件内容
- **find** - 定位代码位置  
- **edit** - 安全编辑代码

这三个工具形成了一套最小但完整的文件操作系统，支持从代码分析到精确修改的全流程。系统还包含任务规划、会话管理、配置管理等功能，实现智能的、可控的项目级代码编辑。

> OpenVibe is an AI programming assistant that reads and edits files directly within the VS Code workspace.
>
> OpenVibe builds complete project‑level editing capabilities through three fundamental file operations:
>
> - **read** – read file content
> - **find** – locate code positions
> - **edit** – safely edit code
>
> These three tools form a minimal yet complete file operation system that supports the entire workflow from code analysis to precise modification. The system also includes task planning, conversation management, configuration management, etc., enabling intelligent and controllable project‑level code editing.

<h2 id="design-philosophy">🎨 设计理念 / Design Philosophy</h2>

OpenVibe的设计核心是**三个基本文件操作工具**的抽象。我们相信任何项目级别的代码编辑都可以分解为这三个基本操作：

1. **信息获取** (read) - 理解现有代码
2. **位置定位** (find) - 找到需要修改的地方
3. **安全修改** (edit) - 应用精确的变更

这种设计确保了：
- **最小化复杂性**：仅三个工具实现完整功能
- **最大化可控性**：每一步操作都可验证
- **项目级一致性**：保持代码库的整体协调

> The core of OpenVibe's design is the abstraction of **three basic file operation tools**. We believe any project‑level code editing can be broken down into these three fundamental actions:
>
> 1. **Information acquisition** (read) – understand existing code
> 2. **Location positioning** (find) – find what needs to be changed
> 3. **Safe modification** (edit) – apply precise changes
>
> This design ensures:
> - **Minimal complexity**: only three tools for complete functionality
> - **Maximum controllability**: every operation is verifiable
> - **Project‑level consistency**: maintain overall coherence of the codebase

---

<h2 id="core-tools-explained">🔧 核心工具说明 / Core Tools Explained</h2>

### 📖 1. read_file — 读取文件内容 / Read File Content

```javascript
read_file(filePath, startLine, endLine)
```

**用途**：获取文件的完整或部分内容，用于理解代码结构和上下文。

**特点**：
- 支持指定行范围读取，减少上下文开销
- 返回带行号的代码内容，便于精确引用
- 编辑前必读操作，确保理解准确

**工作流程**：
```
读取文件 → 理解结构 → 规划修改
```

> **Purpose**: Retrieve full or partial file content to understand code structure and context.
>
> **Features**:
> - Supports reading a specific line range to reduce context overhead
> - Returns code with line numbers for precise reference
> - Must‑read before editing to ensure accurate understanding
>
> **Workflow**:
> ```
> Read file → Understand structure → Plan modifications
> ```

### 🔍 2. find_in_file — 定位代码位置 / Locate Code Position

```javascript
find_in_file(filePath, searchString, contextBefore, contextAfter)
```

**用途**：在文件中查找特定代码片段并返回其精确位置。

**特点**：
- 精确的字符串匹配（大小写敏感）
- 可配置上下文行数，获取周围代码
- 支持查找第N次出现（默认第一次）

**工作流程**：
```
定位目标代码 → 获取上下文 → 确定编辑位置
```

> **Purpose**: Find a specific code snippet in a file and return its exact position.
>
> **Features**:
> - Exact string matching (case‑sensitive)
> - Configurable context lines to get surrounding code
> - Supports finding the Nth occurrence (first by default)
>
> **Workflow**:
> ```
> Locate target code → Get context → Determine edit position
> ```

### ✏️ 3. edit — 安全代码编辑 / Safe Code Editing

```javascript
edit(filePath, startLine, endLine, newContent)
```

**用途**：替换文件中的特定代码区域，包含自动LLM验证。

**特点**：
- **二次LLM验证**：自动检查修改的正确性和安全性
- **精确行数控制**：替换指定行范围的代码
- **插入/删除支持**：支持纯插入（endLine = startLine - 1）和删除（newContent = ""）
- **失败回滚**：验证失败时自动取消操作

**工作流程**：
```
执行编辑 → LLM验证 → 应用变更（或取消）
```

> **Purpose**: Replace a specific code region in a file, including automatic LLM verification.
>
> **Features**:
> - **Secondary LLM verification**: automatically checks correctness and safety of the modification
> - **Precise line control**: replaces code in a specified line range
> - **Insert/delete support**: supports pure insertion (endLine = startLine - 1) and deletion (newContent = "")
> - **Failure rollback**: automatically cancels the operation if verification fails
>
> **Workflow**:
> ```
> Perform edit → LLM verification → Apply change (or cancel)
> ```

---
<h2 id="other-available-tools">📚 其他可用工具 / Other Available Tools</h2>

除了三个核心文件操作工具外，OpenVibe还提供以下辅助工具：

### create_todo_list — 任务规划工具 / Task Planning Tool

用于多步骤任务的规划和管理。遵循"先计划后执行"的原则，确保复杂任务的有序完成。

**特点**：
- 任务分解为明确步骤
- 支持子任务扩展（expandIndex功能）
- 完成状态跟踪

> Besides the three core file operation tools, OpenVibe also provides the following auxiliary tools:
>
> ### create_todo_list — 任务规划工具 / Task Planning Tool
>
> Used for planning and managing multi‑step tasks. Follows the principle of "plan first, then execute" to ensure orderly completion of complex tasks.
>
> **Features**:
> - Breaks down tasks into clear steps
> - Supports subtask expansion (expandIndex function)
> - Completion status tracking

### get_workspace_info — 工作区信息 / Workspace Information

获取当前工作空间的根目录和顶层文件列表，用于了解项目结构。

> Retrieves the root directory and top‑level file list of the current workspace, used to understand the project structure.

### create_directory — 创建目录 / Create Directory

在项目结构中创建新目录，支持递归创建。

> Creates a new directory in the project structure, supports recursive creation.

### complete_todo_item — 任务进度跟踪 / Task Progress Tracking

标记todo项目为已完成，更新任务进度。

> Marks a todo item as completed, updating task progress.

### compact — 对话压缩工具 / Conversation Compression Tool

将长对话历史压缩为简洁摘要，减少上下文窗口使用。

> Compresses a long conversation history into a concise summary, reducing context window usage.

<h2 id="installation">🔧 安装 / Installation</h2>

### 安装步骤 / Installation Steps

1. **Download the extension**:
   ```bash
   # Clone the project
   git clone https://github.com/DoubtedSteam/openvibe.git
   cd openvibe
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the extension**:
   ```bash
   npm run compile
   ```

4. **Install into VS Code**:
   - Press `F1` to open the command palette
   - Type `Extensions: Install from VSIX`
   - Select `openvibe/vibe-coding-assistant-0.1.0.vsix`

<h2 id="configuration">⚙️ 配置 / Configuration</h2>

OpenVibe提供灵活的配置选项，可通过VS Code设置界面进行配置。

### 配置方式 / How to Configure

1. **通过VS Code设置界面**：
   - 按 `Ctrl+,` 打开设置
   - 搜索 "Vibe Coding Assistant"
   - 配置相关选项

2. **通过settings.json文件**：
   ```json
   {
     "vibe-coding.apiBaseUrl": "https://api.deepseek.com",
     "vibe-coding.apiKey": "your-api-key",
     "vibe-coding.model": "deepseek-reasoner",
     "vibe-coding.confirmChanges": true,
     "vibe-coding.maxInteractions": -1,
     "vibe-coding.maxSequenceLength": 1000000
   }
   ```

> OpenVibe provides flexible configuration options that can be set via the VS Code settings interface.
>
> ### 配置方式 / How to Configure
>
> 1. **Via VS Code settings UI**:
>    - Press `Ctrl+,` to open settings
>    - Search for "Vibe Coding Assistant"
>    - Configure the relevant options
>
> 2. **Via settings.json file**:
>    ```json
>    {
>      "vibe-coding.apiBaseUrl": "https://api.deepseek.com",
>      "vibe-coding.apiKey": "your-api-key",
>      "vibe-coding.model": "deepseek-reasoner",
>      "vibe-coding.confirmChanges": true,
>      "vibe-coding.maxInteractions": -1,
>      "vibe-coding.maxSequenceLength": 1000000
>    }
>    ```

### ⚙️ 配置项说明 / Configuration Options

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| **apiBaseUrl** | `string` | `https://api.deepseek.com` | OpenAI兼容API的基础URL |
| **apiKey** | `string` | `""` | API密钥（**必填**） |
| **model** | `string` | `deepseek-reasoner` | 使用的AI模型 |
| **confirmChanges** | `boolean` | `true` | 文件修改前是否需要用户确认 |
| **maxInteractions** | `number` | `-1` | 最大工具调用迭代次数（`-1`表示无限制） |
| **maxSequenceLength** | `number` | `1000000` | 生成文本的最大长度 |

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| **apiBaseUrl** | `string` | `https://api.deepseek.com` | Base URL of the OpenAI‑compatible API |
| **apiKey** | `string` | `""` | API key (**required**) |
| **model** | `string` | `deepseek-reasoner` | AI model to use |
| **confirmChanges** | `boolean` | `true` | Whether to require user confirmation before modifying files |
| **maxInteractions** | `number` | `-1` | Maximum number of tool call iterations (`-1` means unlimited) |
| **maxSequenceLength** | `number` | `1000000` | Maximum length of generated text |

<h2 id="memory-management-system">🧠 内存管理系统 / Memory Management System</h2>

OpenVibe包含一个智能内存系统，用于维护项目知识和任务历史。

### 内存文件结构 / Memory File Structure

内存文件位于 `.OpenVibe/memory.md`，包含以下部分：

1. **项目概览** - 项目基本信息
2. **重要文件说明** - 关键文件功能介绍
3. **技术栈** - 使用的技术和框架
4. **会话历史摘要** - 重要任务的记录
5. **待办事项** - 当前的任务列表
6. **开发笔记** - 技术细节和注意事项

> OpenVibe includes an intelligent memory system for maintaining project knowledge and task history.
>
> ### 内存文件结构 / Memory File Structure
>
> The memory file is located at `.OpenVibe/memory.md` and contains the following sections:
>
> 1. **Project Overview** – basic project information
> 2. **Important Files Description** – functionality of key files
> 3. **Tech Stack** – technologies and frameworks used
> 4. **Conversation History Summary** – records of important tasks
> 5. **Todo Items** – current task list
> 6. **Development Notes** – technical details and considerations

### 内存使用原则 / Memory Usage Principles

1. **主动规划**：内存更新应作为todo list的一部分
2. **持续积累**：重要修改及时记录到内存
3. **知识传承**：为新会话提供项目上下文
4. **一致性维护**：确保项目知识的连续性

> ### 内存使用原则 / Memory Usage Principles
>
> 1. **Proactive planning**: memory updates should be part of the todo list
> 2. **Continuous accumulation**: record important modifications into memory promptly
> 3. **Knowledge transfer**: provide project context for new sessions
> 4. **Consistency maintenance**: ensure continuity of project knowledge

## 📄 许可证 / License

MIT License - See LICENSE file for details

---

**OpenVibe — 基于三个核心工具构建的智能项目编辑助手 / An intelligent project editing assistant built on three core tools**

*简洁、可控、强大的 AI 辅助编程体验 / Simple, controllable, powerful AI‑assisted programming experience*
