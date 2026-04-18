// Webview-side UI script (loaded via <script src=...>).
// Keep this file dependency-free; VS Code webviews often run with strict CSP.
// Do not break string literals across physical lines — invalid JS will prevent this entire file from loading.
(function () {
  function qs(sel) { return document.querySelector(sel); }
  function byId(id) { return document.getElementById(id); }

  // Acquire VS Code API early.
  var vscode;
  try {
    vscode = acquireVsCodeApi();
  } catch (e) {
    // If this fails, nothing else can work.
    return;
  }

  function safePost(msg) {
    try { vscode.postMessage(msg); } catch (_) {}
  }

  window.addEventListener('error', function (event) {
    var msg = (event && event.message) ? String(event.message) : 'Unknown error';
    safePost({ type: 'webviewError', message: msg });
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = (event && event.reason && (event.reason.message || event.reason)) ? String(event.reason.message || event.reason) : 'Unhandled promise rejection';
    safePost({ type: 'webviewError', message: reason });
  });

   var messagesDiv = byId('messages');
   var input = byId('input');
   var sendBtn = byId('send');
   var stopBtn = byId('stop');
   var clearBtn = byId('clear');
   var snapshotsBtn = byId('snapshots');
   var editToggleBtn = byId('edit-toggle');
   var confirmBar = byId('replace-confirm');
   var confirmMeta = byId('confirm-meta');
   var confirmApplyBtn = byId('confirm-apply');
   var confirmCancelBtn = byId('confirm-cancel');
   var confirmTitleEl = qs('#replace-confirm .confirm-title');
  var TOOL_ICONS = {
    read_file: '📄',
    find_in_file: '🔍',
    edit: '✏️',
    create_directory: '📁',
    get_workspace_info: '📂',
  };

   var pendingToolCard = null;
   var pendingConfirm = null; // { requestId, ... }
   
   // Edit permission state
   var editPermissionEnabled = true;
  function scrollBottom() {
    if (!messagesDiv) return;
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
  function escHtml(str) {
    if (str === null || str === undefined) { return ''; }
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
   }
   
   // Edit permission toggle function
   function toggleEditPermission() {
     if (!editToggleBtn) return;
     
     editPermissionEnabled = !editPermissionEnabled;
     
     // Update UI
     if (editPermissionEnabled) {
       editToggleBtn.classList.remove('off');
       editToggleBtn.classList.add('on');
       editToggleBtn.title = 'Toggle edit permission - ON: LLM can use edit tools, OFF: read-only mode';
       var iconSpan = editToggleBtn.querySelector('.toggle-icon');
       var textSpan = editToggleBtn.querySelector('.toggle-text');
       if (iconSpan) iconSpan.textContent = '🔓';
       if (textSpan) textSpan.textContent = 'Edit ON';
     } else {
       editToggleBtn.classList.remove('on');
       editToggleBtn.classList.add('off');
       editToggleBtn.title = 'Toggle edit permission - ON: LLM can use edit tools, OFF: read-only mode';
       var iconSpan = editToggleBtn.querySelector('.toggle-icon');
       var textSpan = editToggleBtn.querySelector('.toggle-text');
       if (iconSpan) iconSpan.textContent = '🔒';
       if (textSpan) textSpan.textContent = 'Edit OFF';
     }
     
     // Notify backend
     safePost({ 
       type: 'setEditPermission', 
       enabled: editPermissionEnabled 
     });
   }

   // Simple markdown parser for basic formatting
  // Simple markdown parser for basic formatting
  function parseMarkdown(text) {
    if (!text || typeof text !== 'string') return '';
    
    // Escape HTML first to prevent XSS
    var escaped = escHtml(text);
    
    // Process markdown tags (order matters)
    // Headers (h1-h3)
    var result = escaped
      .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
      .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
      .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
    
    // Bold and italic
    result = result
      .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>');
    
    // Inline code and code blocks
    result = result
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Lists
    result = result
      .replace(/^-\s+(.+)$/gm, '<li>$1</li>')
      .replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
    
    // Wrap list items in ul/ol
    var lines = result.split('\n');
    var inList = false;
    var isOrderedList = false;
    var output = [];
    
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var isListItem = line.startsWith('<li>');
      
      if (isListItem && !inList) {
        // Determine if ordered list based on original line
        var origLine = escaped.split('\n')[i];
        isOrderedList = /^\d+\.\s/.test(origLine);
        output.push(isOrderedList ? '<ol>' : '<ul>');
        inList = true;
      } else if (!isListItem && inList) {
        output.push(isOrderedList ? '</ol>' : '</ul>');
        inList = false;
        isOrderedList = false;
      }
      
      output.push(line);
    }
    
    // Close any open list
    if (inList) {
      output.push(isOrderedList ? '</ol>' : '</ul>');
    }
    
    result = output.join('\n');
    
    // Paragraphs
    var paragraphs = result.split(/\n\n+/);
    result = paragraphs.map(function(p) {
      p = p.trim();
      if (!p) return '';
      // Don't wrap if it's already a block element
      if (p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<ol') || 
          p.startsWith('<li') || p.startsWith('<pre') || p.startsWith('<code')) {
        return p;
      }
      return '<p>' + p + '</p>';
    }).join('\n\n');
    
    // Links (simple pattern) with security validation
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(match, text, url) {
      // Sanitize URL to prevent javascript: and other dangerous protocols
      var cleanUrl = url.trim();
      // Only allow http, https, mailto, and relative URLs
      if (/^(https?:\/\/|mailto:|#|\/|\.)/.test(cleanUrl)) {
        return '<a href="' + cleanUrl.replace(/"/g, '&quot;') + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
      }
      // For other URLs, render as plain text
      return text;
    });
    // Horizontal rule
    result = result.replace(/^---$/gm, '<hr>');
    
    // Blockquotes
    result = result.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');
    
    return result;
  }
  function addMessage(role, content) {
    if (!messagesDiv) return;
    var row = document.createElement('div');
    row.className = 'message-row ' + role;
    if (role !== 'system') {
      var label = document.createElement('div');
      label.className = 'message-role';
      label.textContent = role === 'user' ? 'You' : 'Assistant';
      row.appendChild(label);
    }
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    // Parse markdown while maintaining CSP safety
    if (content === null || content === undefined) {
      bubble.innerHTML = '';
    } else {
      var htmlContent = parseMarkdown(String(content));
      bubble.innerHTML = htmlContent;
    }
    row.appendChild(bubble);
    messagesDiv.appendChild(row);
    scrollBottom();
  }
  function addCheckCard(data) {
    if (!messagesDiv) return;
    var verdict = data.verdict || '';
    var card = document.createElement('div');
    card.className = 'check-card ' + String(verdict).toLowerCase();
    var icon = verdict === 'CONFIRMED' ? '✅' : '❌';
    var timeStr = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    var header = document.createElement('div');
    header.className = 'check-header';
    var roundLabel = '';
    if (data.reviewRound != null && data.reviewRound !== undefined) {
      roundLabel = ' · round ' + escHtml(String(data.reviewRound));
    }
    header.innerHTML =
      '<span class="check-icon">' + icon + '</span>' +
      '<span class="check-title">Edit review' + roundLabel + '</span>' +
      '<span class="check-status">' + escHtml(verdict) + '</span>';
    header.addEventListener('click', function () { card.classList.toggle('expanded'); });

    var meta = document.createElement('div');
    meta.className = 'check-meta';
    meta.innerHTML =
      '<span class="file-path">' + escHtml(data.filePath) + '</span>' +
      '<span class="line-range">lines ' + data.startLine + '–' + data.endLine + '</span>' +
      '<span class="check-time">' + escHtml(timeStr) + '</span>';

    var body = document.createElement('div');
    body.className = 'check-body';

    var hasUnified = typeof data.unifiedDiff === 'string' && data.unifiedDiff.length > 0;
    if (hasUnified) {
      if (data.contextTruncated) {
        var hint = document.createElement('div');
        hint.className = 'check-diff-trunc';
        hint.textContent = 'Long diff trimmed for chat view.';
        body.appendChild(hint);
      }
      var pre = document.createElement('pre');
      pre.className = 'check-diff-unified';
      pre.textContent = data.unifiedDiff || '';
      body.appendChild(pre);
    }

    var reasonDiv = document.createElement('div');
    reasonDiv.className = 'reason-section';
    reasonDiv.innerHTML = '<strong>LLM Reason:</strong> ' + escHtml(data.reason);
    body.appendChild(reasonDiv);

    card.appendChild(header);
    card.appendChild(meta);
    card.appendChild(body);
    messagesDiv.appendChild(card);
    if (hasUnified) card.classList.add('expanded');
    scrollBottom();
  }

  function addToolCall(name, args) {
    if (!messagesDiv) return null;
    var card = document.createElement('div');
    card.className = 'tool-card';
    var displayName = name === 'replace_lines' ? 'edit' : name;
    var icon = TOOL_ICONS[name] || '🔧';
    var argsStr = JSON.stringify(args, null, 2);
    var command = (name === 'run_shell_command' && args && args.command) ? String(args.command) : '';
    card.dataset.toolName = name;
    if (command) card.dataset.command = command;
    card.innerHTML =
      '<div class="tool-header">' +
        '<span class="tool-icon">' + icon + '</span>' +
        '<span class="tool-name">' + escHtml(displayName) + '</span>' +
        '<span class="tool-status">running…</span>' +
      '</div>' +
      '<div class="tool-body">' + escHtml(command ? ('Command:\n' + command + '\n\nArgs:\n' + argsStr) : argsStr) + '</div>';
    var header = card.querySelector('.tool-header');
    if (header) header.addEventListener('click', function () { card.classList.toggle('expanded'); });
    messagesDiv.appendChild(card);
    scrollBottom();
    pendingToolCard = card;
    return card;
  }

  function resolveToolCard(result) {
    var card = pendingToolCard;
    if (!card) {
      var allCards = document.querySelectorAll('.tool-card');
      for (var i = allCards.length - 1; i >= 0; i--) {
        var c = allCards[i];
        if (!c.classList.contains('done') && !c.classList.contains('error')) { card = c; break; }
      }
    }
    pendingToolCard = null;
    if (!card) return;
    var parsed;
    try { parsed = JSON.parse(result); } catch (_) { parsed = { raw: result }; }
    var isError = parsed && (parsed.error || parsed.success === false);
    card.classList.remove('expanded');
    card.classList.add(isError ? 'error' : 'done');
    var statusEl = card.querySelector('.tool-status');
    if (statusEl) statusEl.textContent = isError ? ('error: ' + (parsed.error || parsed.message || '?')) : (parsed.message || 'done');
    var body = card.querySelector('.tool-body');
    if (body) {
      var toolName = card.dataset.toolName || '';
      var cmd = card.dataset.command || '';
      var resultStr = JSON.stringify(parsed, null, 2);
      body.textContent = (toolName === 'run_shell_command' && cmd) ? ('Command:\n' + cmd + '\n\nResult:\n' + resultStr) : resultStr;
    }
    scrollBottom();
  }

  function showLoading(show) {
    if (!messagesDiv) return;
    var el = byId('loading');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'loading';
        el.className = 'loading';
        el.textContent = 'Thinking…';
        messagesDiv.appendChild(el);
      }
      scrollBottom();
      if (sendBtn) sendBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
    } else {
      if (el) el.remove();
      if (sendBtn) sendBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
    }
  }

  function setRunningState(running) {
    if (sendBtn) sendBtn.disabled = !!running;
    if (stopBtn) stopBtn.disabled = !running;
  }

  function showInfo(msg) {
    if (!messagesDiv) return;
    var el = document.createElement('div');
    el.className = 'info-msg';
    el.textContent = msg;
    messagesDiv.appendChild(el);
    scrollBottom();
    setTimeout(function () { try { el.remove(); } catch (_) {} }, 5000);
  }

  function showError(msg) {
    if (!messagesDiv) return;
    var el = document.createElement('div');
    el.className = 'error-msg';
    el.textContent = msg;
    messagesDiv.appendChild(el);
    scrollBottom();
    setTimeout(function () { try { el.remove(); } catch (_) {} }, 8000);
  }

  function showTokenUsage(usage) {
    if (!messagesDiv) return;
    var el = document.createElement('div');
    el.className = 'token-usage';
    el.textContent = '↑ ' + usage.prompt_tokens + '  ↓ ' + usage.completion_tokens + '  Σ ' + usage.total_tokens + ' tokens';
    messagesDiv.appendChild(el);
    scrollBottom();
  }

  function formatTime(timestamp) {
    var date = new Date(timestamp);
    var now = new Date();
    var diff = now - date;
    if (diff < 24 * 60 * 60 * 1000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diff < 7 * 24 * 60 * 60 * 1000) return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()];
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function updateSessionsList(sessions) {
    var sessionsList = byId('sessions-list');
    if (!sessionsList) return;
    sessionsList.innerHTML = '';
    sessions.forEach(function (session) {
      var item = document.createElement('div');
      item.className = 'session-item' + (session.isActive ? ' active' : '');
      item.dataset.id = session.id;
      item.innerHTML =
        '<div class="session-item-content">' +
          '<div class="session-title">' + escHtml(session.title) + '</div>' +
          '<div class="session-meta">' +
            '<span>' + (session.messageCount || 0) + ' messages</span>' +
            '<span>' + formatTime(session.updated) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="session-actions">' +
          '<button class="session-btn edit-btn" title="Rename">✏️</button>' +
          '<button class="session-btn delete-btn" title="Delete">🗑</button>' +
        '</div>';
      item.addEventListener('click', function (e) {
        if (!e.target.closest('.session-actions')) {
          safePost({ type: 'switchSession', sessionId: session.id });
        }
      });
      var editBtn = item.querySelector('.edit-btn');
      if (editBtn) editBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        safePost({ type: 'renameSession', sessionId: session.id, currentTitle: session.title });
      });
      var delBtn = item.querySelector('.delete-btn');
      if (delBtn) delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        safePost({ type: 'deleteSession', sessionId: session.id });
      });
      sessionsList.appendChild(item);
    });
  }

  function showSnapshotsList(snapshots) {
    if (!messagesDiv) return;
    var old = messagesDiv.querySelector('.snapshot-panel');
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.className = 'snapshot-panel';
    var header = document.createElement('div');
    header.className = 'snapshot-panel-header';
    header.innerHTML = '<span>⏮️ Git Snapshots (' + snapshots.length + ')</span><button class="snapshot-panel-close" title="Close">×</button>';
    var close = header.querySelector('.snapshot-panel-close');
    if (close) close.addEventListener('click', function () { panel.remove(); });
    panel.appendChild(header);
    if (snapshots.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'snapshot-empty';
      empty.textContent = 'No snapshots yet.';
      panel.appendChild(empty);
    } else {
      var sorted = snapshots.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
      sorted.forEach(function (snapshot) {
        var item = document.createElement('div');
        item.className = 'snapshot-item';
        var date = new Date(snapshot.timestamp);
        var timeStr = date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        var instruction = snapshot.userInstruction || snapshot.subject || snapshot.snapshotId;
        var truncated = instruction.length > 80 ? instruction.slice(0, 80) + '…' : instruction;
        item.innerHTML =
          '<div class="snapshot-meta">' +
            '<div class="snapshot-time">' + escHtml(timeStr) + ' · ' + escHtml((snapshot.commitHash || '').slice(0, 7)) + '</div>' +
            '<div class="snapshot-instruction" title="' + escHtml(instruction) + '">' + escHtml(truncated) + '</div>' +
          '</div>' +
          '<button class="snapshot-rollback-btn">↩ Rollback</button>';
        var rb = item.querySelector('.snapshot-rollback-btn');
        if (rb) rb.addEventListener('click', function () {
          safePost({ type: 'rollbackToSnapshot', snapshot: { tag: snapshot.tag, snapshotId: snapshot.snapshotId, userInstruction: instruction } });
          panel.remove();
        });
        panel.appendChild(item);
      });
    }
    messagesDiv.appendChild(panel);
    scrollBottom();
  }

  function respondConfirm(approved) {
    if (!pendingConfirm || !pendingConfirm.requestId) {
      if (confirmBar) confirmBar.classList.remove('show');
      return;
    }
    var kind = pendingConfirm.kind || 'replace';
    if (kind === 'shell') {
      safePost({ type: 'shellConfirmResponse', requestId: pendingConfirm.requestId, approved: approved });
    } else {
      safePost({ type: 'replaceConfirmResponse', requestId: pendingConfirm.requestId, approved: approved });
    }
    pendingConfirm = null;
    if (confirmBar) confirmBar.classList.remove('show');
  }

  // Sidebar bindings
  var sidebar = byId('session-sidebar');
  var toggleBtn = byId('toggle-sidebar');
  var closeBtn = qs('.sidebar-close');
  var addSessionBtn = byId('add-session');

  if (toggleBtn && sidebar) toggleBtn.addEventListener('click', function () { sidebar.classList.add('open'); });
  if (closeBtn && sidebar) closeBtn.addEventListener('click', function () { sidebar.classList.remove('open'); });
  if (addSessionBtn) addSessionBtn.addEventListener('click', function () { safePost({ type: 'newSession' }); });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !sidebar) return;
    var openBtn = t.closest && t.closest('#toggle-sidebar');
    if (openBtn) { sidebar.classList.add('open'); return; }
    var close = t.closest && t.closest('.sidebar-close');
    if (close) sidebar.classList.remove('open');
  });

  if (confirmApplyBtn) confirmApplyBtn.addEventListener('click', function () { respondConfirm(true); });
  if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', function () { respondConfirm(false); });

  if (sendBtn) sendBtn.addEventListener('click', function () {
    if (!input) return;
    var text = input.value.trim();
    input.value = '';
    input.style.height = 'auto';
    safePost({ type: 'sendMessage', text: text });
  });
  if (stopBtn) stopBtn.addEventListener('click', function () { safePost({ type: 'stopOperation' }); });
  if (clearBtn) clearBtn.addEventListener('click', function () { safePost({ type: 'clearHistory' }); });
   if (snapshotsBtn) snapshotsBtn.addEventListener('click', function () { safePost({ type: 'showSnapshots' }); });
   if (editToggleBtn) editToggleBtn.addEventListener('click', toggleEditPermission);
  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (sendBtn) sendBtn.click(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.type) {
      case 'snapshotsList':  showSnapshotsList(msg.snapshots); break;
      case 'addMessage':     addMessage(msg.message.role, msg.message.content); break;
      case 'addCheckCard':   addCheckCard(msg.data); break;
      case 'toolCall':       addToolCall(msg.name, msg.args); break;
      case 'toolResult':     resolveToolCard(msg.result); break;
      case 'loading':        showLoading(msg.loading); break;
      case 'error':          showError(msg.message); break;
      case 'tokenUsage':     showTokenUsage(msg.usage); break;
      case 'setRunning':     setRunningState(msg.running); break;
      case 'info':           showInfo(msg.message); break;
      case 'requestReplaceConfirm': {
        pendingConfirm = msg.data || null;
        pendingConfirm.kind = 'replace';
        var fp = pendingConfirm && pendingConfirm.filePath ? pendingConfirm.filePath : '';
        var rng = pendingConfirm ? (pendingConfirm.startLine + '–' + pendingConfirm.endLine) : '';
        if (confirmMeta) confirmMeta.textContent = fp ? (fp + (rng ? (' · lines ' + rng) : '')) : '';
        if (confirmTitleEl) confirmTitleEl.textContent = 'Apply this edit?';
        if (confirmBar) confirmBar.classList.add('show');
        scrollBottom();
        break;
      }
      case 'requestShellConfirm': {
        pendingConfirm = msg.data || null;
        if (pendingConfirm) pendingConfirm.kind = 'shell';
        var cmd = pendingConfirm && pendingConfirm.command ? String(pendingConfirm.command) : '';
        if (confirmMeta) confirmMeta.textContent = cmd ? cmd : '';
        if (confirmTitleEl) confirmTitleEl.textContent = 'Run this command?';
        if (confirmBar) confirmBar.classList.add('show');
        scrollBottom();
        break;
      }
      case 'clearMessages':
        if (messagesDiv) messagesDiv.innerHTML = '';
        pendingToolCard = null;
        pendingConfirm = null;
        if (confirmBar) confirmBar.classList.remove('show');
        break;
      case 'sessionsList':
        updateSessionsList(msg.sessions);
        break;
    }
  });

  // Notify extension that the webview is ready.
  safePost({ type: 'ready' });
})();

