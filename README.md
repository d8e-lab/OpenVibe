![OpenVibe Logo](imgs/logo.png)

# OpenVibe — 极简 AI 编程助手 / Minimalist AI Assistant

**在 VS Code 工作区内直接读写与编辑项目的智能助手。** 基于 **read**、**find**、**edit** 三类核心工具，并配合任务规划、多智能体审查与会话管理。

> **An intelligent assistant that reads and edits your project inside the VS Code workspace.** Built around **read**, **find**, and **edit**, with task planning, multi‑agent review, and session management.

<h2 id="table-of-contents">目录 / Table of contents</h2>

- [重要提示 / Important notice](#important-notice)
- [新闻 / News](#news)
- [项目概述 / Project overview](#project-overview)
- [设计理念 / Design philosophy](#design-philosophy)
- [核心工具 / Core tools](#core-tools-explained)
- [多智能体架构 / Multi-agent architecture](#multi-agent-architecture)
- [其它辅助工具 / Other tools](#other-available-tools)
- [安装 / Installation](#installation)
- [配置 / Configuration](#configuration)
- [内存管理 / Memory](#memory-management-system)
- [许可证 / License](#license)

<h2 id="important-notice">重要提示 / Important notice</h2>

本扩展可实现智能编辑与辅助开发，**不建议作为生产环境的唯一依赖**；体验偏实验与探索，因此取名 OpenVibe。初版开发时曾用 DeepSeek API，成本约 30 元人民币。

> Smart editing works, but **this is not recommended as a production‑only workflow**; the experience is experimental and exploratory—hence the name. Early development used the DeepSeek API for roughly 30 RMB.

<h2 id="news">新闻 / News</h2>

| 日期 | 内容 |
|------|------|
| 2025-04-11 | 增加 **Git** 支持：编码过程中可自动创建快照，并在 UI 中回滚与管理版本。 |
| 2025-04-14 | 增加**独立审查**：任务清单审查与代码编辑审查，由独立 LLM 代理提升修改质量。 |
| 2025-04-16 | **强化 shell 审查与执行**：1) 严格禁止使用 shell 进行任何文件读写操作（强制使用专用工具） 2) 结构化返回 + 关键错误摘要 3) 注入 todo 与最近执行历史到审查流程 4) 多级审查流程：主智能体→shell 编辑代理→独立安全审查→用户确认 |

> **2025-04-11:** Git snapshots during coding; rollback and history in the UI.  

> **2025-04-14:** Independent review for todo lists and code edits via separate LLM agents.  

> **2025-04-16:** Enhanced shell review & execution: 1) Strict prohibition on shell file operations (use dedicated tools) 2) Structured output + key error summaries 3) Todo & recent history injection 4) Multi-level review flow: primary agent → shell editor agent → independent security review → user confirmation.

> **2025-04-19:** Raw payload protocol `MM_OUTPUT` for `edit` and `run_shell_command` tools — bypass JSON/Markdown escaping for complex multiline code and shell scripts.

<h2 id="project-overview">项目概述 / Project overview</h2>

OpenVibe 在本地工作区中完成「读 → 找 → 改」的闭环：

| 工具 | 作用 |
|------|------|
| **read** | 读取文件内容 |
| **find** | 定位代码位置 |
| **edit** | 安全替换指定区域 |

此外还有任务规划、会话与配置管理，使项目级修改**可分析、可验证、可追溯**。

> OpenVibe closes the loop with **read → find → edit**, plus planning and sessions so edits stay analyzable and traceable.

<h2 id="design-philosophy">设计理念 / Design philosophy</h2>

复杂修改可拆解为三步：**获取信息（read）→ 定位变更点（find）→ 安全写入（edit）**。工具集小、行为可预期，便于审查与自动化。

> Any project‑level edit breaks down into **read**, **find**, and **edit**—small surface area, predictable behavior, easier to review.

<h2 id="core-tools-explained">核心工具 / Core tools</h2>

### `read_file` — 读取文件

```javascript
read_file(filePath, startLine, endLine)
```

读取全文或指定行范围。

### `find_in_file` — 搜索定位

```javascript
find_in_file(filePath, searchString, contextBefore, contextAfter)
```

在文件中查找片段并返回位置上下文。

### `edit` — 安全编辑

```javascript
edit(filePath, startLine, endLine, newContent)
```

替换指定行范围；可选经独立 LLM 审查后再应用。对于多行代码或复杂脚本，可以使用 **MM_OUTPUT raw payload protocol** 避免 JSON/Markdown 转义问题——将 `newContent` 替换为 `<MM_OUTPUT type="EDIT">…</MM_OUTPUT>` 特殊标记即可直接传递原始文本。

<h2 id="multi-agent-architecture">多智能体架构 / Multi-agent architecture</h2>

系统包含**主智能体**（理解与规划）、**编辑智能体**（执行读/找/改与 shell）、**审查智能体**（计划与改动的独立校验），形成「执行 ↔ 验证」分离。

**典型流程（简化）**

- **plan**：主智能体制定 todo → 审查智能体验证计划 → 不通过则反馈并重规划。
- **edit**：编辑智能体写入 → 审查智能体验证改动 → 不通过则重改；必要时用户确认 diff。
**Shell 命令审查的强化流程：**

1. **严格的安全规则**：明确禁止使用 shell 命令进行任何文件读写操作（如 cat、type、dir、grep 等），强制使用专用工具 `read_file`/`find_in_file` 获取项目内容
2. **防止命令漂移**：审查时会检查命令是否与用户请求和当前 todo 上下文保持一致，拒绝无关脚本和执行代码生成等高风险操作
3. **结构化返回格式**：shell 执行结果包含 `command`、`cwd`、`exitCode`、`durationMs`、`summary`、`keyErrors` 等字段，便于审查抓取关键信息
4. **多级审查流程**：主智能体提出命令 → shell 编辑代理优化 → 独立安全审查验证 → 用户确认（可选）→ 执行并返回结构化结果
5. **上下文注入**：自动注入 todo 目标与最近 shell 执行历史到审查流程，确保命令与当前任务一致
6. **防重复执行**：记录最近执行的命令，避免无意义重复，提升执行效率

**主智能体**：需求分析、任务与 `plan` / `edit` / `shell` 协调、与用户沟通。  
**审查智能体**：todo 合理性、编辑正确性与风险、shell 命令安全性。  
**编辑智能体**：`read_file`、`find_in_file`、`edit`、`run_shell_command` 等具体执行，但**不直接进行文件操作**。

> **Primary agent** plans and coordinates; **editing agent** runs tools; **review agent** independently checks plans and edits. Failed reviews trigger rework loops.  
> **Enhanced shell command flow**: Strict safety rules, multi-level review, anti-drift enforcement, structured output, context injection, and anti-repeat protection.

<h2 id="other-available-tools">其它辅助工具 / Other tools</h2>

<details>
<summary>展开查看 / Expand</summary>

| 工具 | 说明 |
|------|------|
| `get_workspace_info` | 工作区根目录与顶层文件 |
| `create_directory` | 创建目录（可递归） |
| `create_todo_list` | 多步骤任务规划（先计划后执行） |
| `run_shell_command` | 在项目根执行命令；**禁止使用 shell 进行任何文件读写操作**（强制使用专用工具），经 shell 编辑代理优化 + 独立安全审查（含防上下文获取、防漂移、结构化返回、多级审查流程）。对于复杂多行命令，可使用 **MM_OUTPUT** 特殊标记传递原始脚本，避免转义问题 |
| `complete_todo_item` | 标记 todo 完成 |
| `compact` | 压缩长对话，节省上下文 |
| Git 相关 | 快照与历史管理（见新闻） |

</details>

<h2 id="installation">安装 / Installation</h2>

**环境**：Node.js（建议 LTS）、VS Code **≥ 1.74**（见 `package.json` 中 `engines.vscode`）。

1. 克隆仓库：`git clone https://github.com/DoubtedSteam/OpenVibe.git`
2. 安装依赖：在项目根目录执行 `npm install`
3. 编译：`npm run compile`（开发时可用 `npm run watch` 监听）
4. 在 VS Code 中打开该文件夹，按 **F5** 启动 **Extension Development Host** 调试扩展；在侧栏打开 **Vibe Coding** 视图使用聊天。

> **Requirements:** Node.js (LTS recommended), VS Code **≥ 1.74**. Clone → `npm install` → `npm run compile` → open in VS Code → **F5** to run the extension host → use the **Vibe Coding** sidebar chat.

<h2 id="configuration">配置 / Configuration</h2>

在 VS Code **设置**中搜索 `vibe-coding` 即可。下列键名与 `package.json` 中 `contributes.configuration` 一致。

| 配置项 | 类型 | 默认 | 说明 |
|--------|------|------|------|
| `vibe-coding.apiBaseUrl` | `string` | `https://api.deepseek.com` | OpenAI 兼容 API 的 Base URL |
| `vibe-coding.apiKey` | `string` | `""` | API 密钥（**必填**） |
| `vibe-coding.model` | `string` | `deepseek-reasoner` | 模型名 |
| `vibe-coding.confirmChanges` | `boolean` | `true` | 应用 `edit` 前是否确认 |
| `vibe-coding.confirmShellCommand` | `boolean` | `true` | `run_shell_command` 在审查后是否再经人工确认（与 `confirmChanges` 独立） |
| `vibe-coding.maxInteractions` | `number` | `-1` | 最大工具调用轮数（`-1` 不限） |
| `vibe-coding.maxSequenceLength` | `number` | `1000000` | 生成文本最大长度 |
| `vibe-coding.todolistReview.enabled` | `boolean` | `true` | 是否对 todo 生成/编辑做独立审查 |
| `vibe-coding.todolistReview.maxAttempts` | `number` | `5` | 单次 `create_todo_list` 最大审查/重试轮数（≥1） |
| `vibe-coding.todolistReview.reviewTimeoutMs` | `number` | `120000` | 审查与 regenerate 请求超时（毫秒，≥5000） |
| `vibe-coding.todolistReview.editorTimeoutMs` | `number` | `120000` | 编辑器代理请求超时（毫秒，≥5000） |
| `vibe-coding.editReview.enabled` | `boolean` | `true` | 是否对代码 `edit` 做独立审查 |
| `vibe-coding.editReview.timeoutMs` | `number` | `120000` | 编辑审查超时（毫秒，≥5000） |
| `vibe-coding.shellCommandReview.enabled` | `boolean` | `true` | 是否对 shell 命令启用编辑代理 + 安全审查 |
| `vibe-coding.shellCommandReview.maxAttempts` | `number` | `5` | 单次命令最大编辑/审查轮数（≥1） |
| `vibe-coding.shellCommandReview.reviewTimeoutMs` | `number` | `120000` | Shell 安全审查超时（毫秒，≥5000） |
| `vibe-coding.shellCommandReview.editorTimeoutMs` | `number` | `120000` | Shell 编辑代理超时（毫秒，≥5000） |

> All keys are under **`vibe-coding.*`** in Settings.

<h2 id="memory-management-system">内存管理 / Memory</h2>

项目知识与会话上下文可维护在 **`.OpenVibe/memory.md`**，建议按固定层级组织：

1. **Level 1** — 项目概览、技术栈、核心设计  
2. **Level 2** — 目录结构与关键文件依赖  
3. **Level 3** — 类与类型  
4. **Level 4** — 重要函数与方法（签名、副作用、错误处理）

更新内存宜纳入任务清单，保证新会话能继承一致上下文。

> Optional **`.OpenVibe/memory.md`** with four levels from overview down to functions; keep it updated as part of planned work.

<h2 id="license">许可证 / License</h2>

**MIT** — 见仓库内 [LICENSE](LICENSE) 文件。

---

*OpenVibe — 简洁、可控的 AI 辅助编程体验 / Simple, controllable AI‑assisted coding.*
