import * as vscode from 'vscode';
import { ChatViewProvider } from './modules/ChatViewProvider';

export function activate(context: vscode.ExtensionContext) {
  // 创建输出通道
  const outputChannel = vscode.window.createOutputChannel('Vibe Coding Assistant');
  context.subscriptions.push(outputChannel);
  
  console.log('Vibe Coding Assistant is now active');
  outputChannel.appendLine('Vibe Coding Assistant扩展已激活 - ' + new Date().toLocaleString());

  // 注册聊天视图提供者
  const provider = new ChatViewProvider(context.extensionUri, context);
  provider.setOutputChannel(outputChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  // 注册命令：打开聊天视图（如果视图被关闭，可以通过命令重新打开）
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-coding.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.vibe-coding');
    })
  );

  // 注册命令：清除聊天历史
  context.subscriptions.push(
    vscode.commands.registerCommand('vibe-coding.clearHistory', () => {
      provider.clearHistory();
      vscode.window.showInformationMessage('Chat history cleared');
    })
  );

  console.log('Vibe Coding Assistant is now active');
}

export function deactivate() {}