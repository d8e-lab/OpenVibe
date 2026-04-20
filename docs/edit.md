> codex resume 019d96b1-66ee-7d03-967c-121b040d4bd0
## 1. 入口与编排层（收到 agent/tool 消息后怎么走）

  1. Webview 把用户消息发给扩展：sendMessage -> handleUserMessage。src/modules/ChatViewProvider.ts:121 src/modules/MessageHandler.ts:32
  2. MessageHandler 调 sendChatMessage，请求里带 TOOL_DEFINITIONS，允许模型返回 tool_calls。src/modules/MessageHandler.ts:89 src/api.ts:30
  3. API 响应被统一解析成 content + toolCalls。src/api.ts:51

## 2. tool call 解析与预处理（重点是 edit）

  1. MessageHandler 逐个遍历 toolCalls（顺序执行，不并行）。src/modules/MessageHandler.ts:117
  2. 先 JSON.parse(toolCall.function.arguments)，失败则空对象兜底，避免整轮崩溃。src/modules/MessageHandler.ts:125
  3. 做 MM_OUTPUT 预处理：从 assistant 文本里提取 <MM_OUTPUT type="EDIT"><MM_PATCH>...</MM_PATCH> 原始文本，填回 args.newContent，并打 __mmRaw=true 标记，避免 \n 被二次转义。`src/modules/MessageHandler.ts:116`  `src/modules/MessageHandler.ts:131` `src/mmOutput.ts:34`
  4. 预处理后先发 UI 事件 toolCall（用户能看到“正在执行 edit”卡片）。`src/modules/MessageHandler.ts:159`

## 3. 调用工具分发（edit 路由）

  1. executeTool('edit', args) 进入 ToolExecutor 的 case 'edit'。src/modules/ToolExecutor.ts:85
  2. 这里把执行函数、审查函数、人工确认函数“注入”进 replaceLinesTool：

  - 执行体：replaceLinesTool(...)
  - 独立审查：llmCheckReplace(ctx)
  - 人工确认：userConfirmReplace(ctx)（受 confirmChanges 控制）
    src/modules/ToolExecutor.ts:86

## 4. edit 真正执行（replaceLinesTool）

  1. 路径安全：只能在 workspace 内，越界直接拒绝。src/tools.ts:20
  2. 文件与行号校验：支持新建文件（startLine=1,endLine=0），支持插入（endLine=startLine-1），越界报错。src/tools.ts:261 src/tools.ts:287
  3. 文本预处理：按 raw 决定是否把字面 \\n 解码；统一换行符；保留 CRLF 风格。src/tools.ts:42 src/tools.ts:295
  4. no-op 检测：替换前后完全一致则直接返回 noChanges，避免伪 diff。src/tools.ts:297
  5. 生成审查材料：beforeContext/afterContext/unifiedDiff（带行号）。src/tools.ts:317 src/tools.ts:367
  6. 先过 LLM 审查，不通过就取消写入（fail-closed）。src/tools.ts:385
  7. 再过人工确认（若开启），拒绝也取消写入。src/tools.ts:404
  8. 最后才落盘 writeLines 并返回结构化结果 JSON。src/tools.ts:420

##  5. 审查与确认如何展示给用户

  1. ChatViewProvider 把 edit 审查绑定到独立模块 codeEditReview（不是主 agent 同一次回答）。src/modules/ChatViewProvider.ts:36
  2. codeEditReview 会把结论发 addCheckCard（含 verdict/reason/diff/轮次）。src/modules/codeEditReview.ts:146
  3. 若需人工确认，UIManager.userConfirmReplace 发 requestReplaceConfirm 并挂起 Promise 等待用户按钮回复。src/modules/UIManager.ts:164
  4. Webview 收到后弹确认条；点“应用/取消”回发 replaceConfirmResponse。media/webview.js:507 media/webview.js:436
  5. ChatViewProvider 收到确认响应后调用 resolveReplaceConfirm，继续工具执行流程。src/modules/ChatViewProvider.ts:180

##  6. 工具执行结果回流与最终展示

  1. MessageHandler 拿到工具结果后发 toolResult 到 UI，并把结果以 role=tool 写入会话历史供后续轮次使用。src/modules/MessageHandler.ts:172
  2. Webview 把 tool 卡片从 running 改成 done/error，展示结构化 JSON 结果。media/webview.js:261
  3. 审查卡与工具卡是分开的：审查卡解释“为什么允许/拒绝”，工具卡解释“执行结果是什么”。

##  代码设计思路（为什么这么设计）

  1. 分层清晰

  - MessageHandler 只负责“对话循环与工具编排”。
  - ToolExecutor 只负责“工具路由/策略”。
  - tools.ts 只负责“底层文件系统执行”。
    这让执行逻辑、策略逻辑、IO 逻辑解耦。

  2. 依赖注入

  - replaceLinesTool 不直接依赖 UI 和 LLM，通过回调注入审查/确认，便于替换策略和测试。

  3. 多重安全闸

  - 路径沙箱、参数校验、独立审查、人工确认，且默认拒绝（fail-closed）。

  4. UI 事件总线化

  - 扩展端只发消息类型（toolCall/toolResult/addCheckCard/requestReplaceConfirm），前端统一渲染，前后端边界明确。

  5. 抗模型输出不稳定

  - JSON 参数解析有兜底；MM_OUTPUT 解决大段代码转义损坏；no-op 检测避免无效写入。