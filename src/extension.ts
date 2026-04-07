import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';

export function activate(context: vscode.ExtensionContext) {
  // 注册聊天视图提供者
  const provider = new ChatViewProvider(context.extensionUri, context);
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