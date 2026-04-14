![OpenVibe Logo](imgs/logo.png)
# 🚀 OpenVibe — 极简AI编程助手 / Minimalist AI Assistant
> **基于三大核心工具的智能项目编辑助手 / An intelligent project editing assistant built on three core tools**

<h2 id="important-notice">⚠️ 重要提示 / Important Notice</h2>

当前项目可以完成智能编辑功能，但不推荐用于实际工作环境。然而，它的使用体验非常有趣和有感觉，因此得名OpenVibe。

整个项目的开发过程耗资30元巨款用于DeepSeek的API调用

> The current project can perform intelligent editing, but it is not recommended for production environments. However, the experience is very interesting and gives a great vibe, hence the name OpenVibe.
>
> The entire development cost a whopping 30 RMB for DeepSeek API calls.

<h2 id="news">📰 新闻 / News</h2>

2025年4月11日: OpenVibe增加了Git支持功能！现在可以在编码过程中自动创建Git快照，并支持通过UI进行版本回滚和快照管理。

> April 11, 2025: OpenVibe has added Git support! Now automatic Git snapshots can be created during coding, and version rollback and snapshot management are supported through the UI.

2025年4月14日: OpenVibe添加了独立审查机制，包括任务清单审查和代码编辑审查功能，通过独立LLM代理提高代码修改质量。

> April 14, 2025: OpenVibe added independent review mechanisms including todolist review and code edit review, improving code modification quality through independent LLM agents.
<h2 id="table-of-contents">📋 目录 / Table of Contents</h2>


- [重要提示 / Important Notice](#important-notice)
- [新闻 / News](#news)
- [项目概述 / Project Overview](#project-overview)
- [设计理念 / Design Philosophy](#design-philosophy)
- [核心工具说明 / Core Tools Explained](#core-tools-explained)
- [其它辅助工具 / Other Auxiliary Tools](#other-available-tools)
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

**用途**：获取文件的完整或部分内容。

> **Purpose**: Retrieve full or partial file content.

### 🔍 2. find_in_file — 定位代码位置 / Locate Code Position

```javascript
find_in_file(filePath, searchString, contextBefore, contextAfter)
```

**用途**：在文件中查找特定代码片段并返回其精确位置。

> **Purpose**: Find a specific code snippet in a file and return its exact position.

### ✏️ 3. edit — 安全代码编辑 / Safe Code Editing

```javascript
edit(filePath, startLine, endLine, newContent)
```

**用途**：替换文件中的特定代码区域，包含自动LLM验证。

> **Purpose**: Replace a specific code region in a file, including automatic LLM verification.
---
<h2 id="other-available-tools">📚 其它辅助工具 / Other Auxiliary Tools</h2>

除了三个核心文件操作工具外，OpenVibe还提供以下辅助工具：
> Besides the three core file operation tools, OpenVibe also provides the following auxiliary tools:

<details>
<summary>查看辅助工具详情 / View Auxiliary Tools Details</summary>

#### get_workspace_info — 工作区信息 / Workspace Information

获取当前工作空间的根目录和顶层文件列表，用于了解项目结构。

> Retrieves the root directory and top‑level file list of the current workspace, used to understand the project structure.

#### create_directory — 创建目录 / Create Directory

在项目结构中创建新目录，支持递归创建。

> Creates a new directory in the project structure, supports recursive creation.

#### create_todo_list — 任务规划工具 / Task Planning Tool

用于多步骤任务的规划和管理。遵循"先计划后执行"的原则，确保复杂任务的有序完成。

> Used for planning and managing multi‑step tasks. Follows the principle of "plan first, then execute" to ensure orderly completion of complex tasks.

#### complete_todo_item — 任务进度跟踪 / Task Progress Tracking

标记todo项目为已完成，更新任务进度。

> Marks a todo item as completed, updating task progress.

#### compact — 对话压缩工具 / Conversation Compression Tool

将长对话历史压缩为简洁摘要，减少上下文窗口使用。

> Compresses a long conversation history into a concise summary, reducing context window usage.

#### 独立审查机制 / Independent Review Mechanisms

提供独立的LLM代理审查功能，提高任务清单和代码修改的质量。

> Provides independent LLM agent review functionality to improve the quality of task lists and code modifications.

#### Git快照管理工具 / Git Snapshot Tools

OpenVibe集成了Git快照功能，可以在编码过程中自动创建版本快照，并通过UI管理版本历史。

> OpenVibe integrates Git snapshot functionality, allowing automatic version snapshots to be created during coding, and managing version history through the UI.

</details>
<h2 id="configuration">⚙️ 配置 / Configuration</h2>
OpenVibe提供灵活的配置选项，可通过VS Code设置界面进行配置。

> OpenVibe provides flexible configuration options that can be set via the VS Code settings interface.

### ⚙️ 配置项说明 / Configuration Options
| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| **apiBaseUrl** | `string` | `https://api.deepseek.com` | OpenAI兼容API的基础URL / Base URL of the OpenAI‑compatible API |
| **apiKey** | `string` | `""` | API密钥（**必填**） / API key (**required**) |
| **model** | `string` | `deepseek-reasoner` | 使用的AI模型 / AI model to use |
| **confirmChanges** | `boolean` | `true` | 文件修改前是否需要用户确认 / Whether to require user confirmation before modifying files |
| **maxInteractions** | `number` | `-1` | 最大工具调用迭代次数（`-1`表示无限制） / Maximum number of tool call iterations (`-1` means unlimited) |
| **maxSequenceLength** | `number` | `1000000` | 生成文本的最大长度 / Maximum length of generated text |
| **vibe-coding.todolistReview.enabled** | `boolean` | `true` | 是否启用任务清单审查（独立LLM代理） / Whether to enable todolist review by independent LLM agent |
| **vibe-coding.todolistReview.maxAttempts** | `number` | `5` | 最大审查尝试次数（最小1次） / Maximum review attempts (minimum 1) |
| **vibe-coding.todolistReview.reviewTimeoutMs** | `number` | `120000` | 任务清单审查超时时间（毫秒，最小5000） / Review timeout in ms (minimum 5000) |
| **vibe-coding.todolistReview.editorTimeoutMs** | `number` | `120000` | 编辑器超时时间（毫秒，最小5000） / Editor timeout in ms (minimum 5000) |
| **vibe-coding.editReview.enabled** | `boolean` | `true` | 是否启用代码编辑审查（独立LLM代理） / Whether to enable code edit review by independent LLM agent |
| **vibe-coding.editReview.timeoutMs** | `number` | `120000` | 代码编辑审查超时时间（毫秒，最小5000） / Code edit review timeout in ms (minimum 5000) |

<h2 id="memory-management-system">🧠 内存管理系统 / Memory Management System</h2>

OpenVibe包含一个智能内存系统，用于维护项目知识和任务历史。
> OpenVibe includes an intelligent memory system for maintaining project knowledge and task history.

### 内存文件结构 / Memory File Structure

内存文件位于 `.OpenVibe/memory.md`，采用**四层级结构**，顺序固定：

1. **Level 1 — 项目整体描述** - 项目基本信息、核心设计原则、技术栈、数据流图
2. **Level 2 — 文件目录结构** - 完整的目录树、关键文件说明、文件间依赖关系
3. **Level 3 — 类和类型定义** - 每个类的职责、关键字段、生命周期、继承关系
4. **Level 4 — 函数和方法** - 所有公共函数和重要私有方法的签名、作用、副作用、错误处理

> The memory file is located at `.OpenVibe/memory.md` and follows a **four‑level structure** in fixed order:
>
> 1. **Level 1 — Project Overview** – project basic info, core design principles, tech stack, data‑flow diagram
> 2. **Level 2 — File Directory Structure** – complete directory tree, key file descriptions, file dependencies
> 3. **Level 3 — Classes and Type Definitions** – each class's responsibility, key fields, lifecycle, inheritance
> 4. **Level 4 — Functions and Methods** – signatures, purpose, side effects, error handling for all public functions and important private methods

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
