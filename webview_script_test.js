
  const vscode = acquireVsCodeApi();
  const messagesDiv = document.getElementById('messages');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const clearBtn = document.getElementById('clear');
  const TOOL_ICONS = {
    read_file: '📄',
    find_in_file: '🔍',
    edit: '✏️',
    create_directory: '📁',
    get_workspace_info: '📂',
  };

  // Pending tool card awaiting its result
  let pendingToolCard = null;

  function addMessage(role, content) {
    const row = document.createElement('div');
    row.className = 'message-row ' + role;

    if (role !== 'system') {
      const label = document.createElement('div');
      label.className = 'message-role';
      label.textContent = role === 'user' ? 'You' : 'Assistant';
      row.appendChild(label);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;

    row.appendChild(bubble);
    messagesDiv.appendChild(row);
    scrollBottom();
  }

   function addToolCall(name, args) {\n     const card = document.createElement('div');\n     card.className = 'tool-card'; // Default collapsed, not expanded\n\n     // Use friendly display name\n     const displayName = name === 'replace_lines' ? 'edit' : name;\n     const icon = TOOL_ICONS[name] || '🔧';\n     const argsStr = JSON.stringify(args, null, 2);\n\n     card.innerHTML =\n       '<div class=\"tool-header\">' +\n         '<span class=\"tool-icon\">' + icon + '</span>' +\n         '<span class=\"tool-name\">' + displayName + '</span>' +\n         '<span class=\"tool-status\">running…</span>' +\n       '</div>' +\n       '<div class=\"tool-body\">' + escHtml(argsStr) + '</div>';\n\n     card.querySelector('.tool-header').addEventListener('click', () => {\n       card.classList.toggle('expanded');\n     });\n\n     messagesDiv.appendChild(card);\n     scrollBottom();\n     pendingToolCard = card;\n     return card;\n   }

   function resolveToolCard(result) {\n     // Find the most recent tool card that is still in running state\n     let card = pendingToolCard;\n     \n     if (!card) {\n       // If no pendingToolCard, look for any running tool card\n       const allCards = document.querySelectorAll('.tool-card');\n       for (let i = allCards.length - 1; i >= 0; i--) {\n         const c = allCards[i];\n         if (!c.classList.contains('done') && !c.classList.contains('error')) {\n           card = c;\n           break;\n         }\n       }\n     }\n     \n     pendingToolCard = null;\n     if (!card) { return; }\n\n     let parsed;\n     try { parsed = JSON.parse(result); } catch { parsed = { raw: result }; }\n\n     const isError = parsed && (parsed.error || parsed.success === false);\n     card.classList.remove('expanded');\n     card.classList.add(isError ? 'error' : 'done');\n\n     const statusEl = card.querySelector('.tool-status');\n     if (statusEl) {\n       statusEl.textContent = isError\n         ? ('error: ' + (parsed.error || parsed.message || '?'))\n         : (parsed.message || 'done');\n     }\n\n     const body = card.querySelector('.tool-body');\n     if (body) {\n       body.textContent = JSON.stringify(parsed, null, 2);\n     }\n     scrollBottom();\n   }

  function showLoading(show) {
    let el = document.getElementById('loading');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'loading';
        el.className = 'loading';
        el.textContent = 'Thinking…';
        messagesDiv.appendChild(el);
      }
      scrollBottom();
      sendBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      if (el) { el.remove(); }
      sendBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  function setRunningState(running) {
    sendBtn.disabled = running;
    stopBtn.disabled = !running;
  }

  function showInfo(msg) {
    const el = document.createElement('div');
    el.className = 'info-msg';
    el.textContent = msg;
    messagesDiv.appendChild(el);
    scrollBottom();
    setTimeout(() => el.remove(), 5000);
  }

  function showError(msg) {
    const el = document.createElement('div');
    el.className = 'error-msg';
    el.textContent = msg;
    messagesDiv.appendChild(el);
    scrollBottom();
    setTimeout(() => el.remove(), 8000);
  }

  function scrollBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showTokenUsage(usage) {
    const el = document.createElement('div');
    el.className = 'token-usage';
    el.textContent =
      '↑ ' + usage.prompt_tokens +
      '  ↓ ' + usage.completion_tokens +
      '  Σ ' + usage.total_tokens + ' tokens';
    messagesDiv.appendChild(el);
    scrollBottom();
  }

   function formatTime(timestamp) {
     const date = new Date(timestamp);
     const now = new Date();
     const diff = now - date;
     
     if (diff < 24 * 60 * 60 * 1000) {
       // Today
       return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
     } else if (diff < 7 * 24 * 60 * 60 * 1000) {
       // Within a week
       const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
       return days[date.getDay()];
     } else {
       // Older
       return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
     }
   }

   function updateSessionsList(sessions) {
     const sessionsList = document.getElementById('sessions-list');
     sessionsList.innerHTML = '';
     
     sessions.forEach(session => {
       const item = document.createElement('div');
       item.className = 'session-item' + (session.isActive ? ' active' : '');
       item.dataset.id = session.id;
        item.innerHTML = '<div class="session-item-content">' +
          '<div class="session-title">' + escHtml(session.title) + '</div>' +
          '<div class="session-meta">' +
          '<span>' + session.messageCount + ' messages</span>' +
          '<span>' + formatTime(session.updated) + '</span>' +
          '</div>' +
          '</div>' +
          '<div class="session-actions">' +
          '<button class="session-btn edit-btn" title="Rename">✏️</button>' +
          '<button class="session-btn delete-btn" title="Delete">🗑</button>' +
          '</div>';
       
       // Session click
       item.addEventListener('click', (e) => {
         if (!e.target.closest('.session-actions')) {
           vscode.postMessage({ type: 'switchSession', sessionId: session.id });
         }
       });
       
       // Edit button
       const editBtn = item.querySelector('.edit-btn');
       editBtn.addEventListener('click', (e) => {
         e.stopPropagation();
         vscode.postMessage({ type: 'renameSession', sessionId: session.id, currentTitle: session.title });
       });
       
       // Delete button
       const deleteBtn = item.querySelector('.delete-btn');
       deleteBtn.addEventListener('click', (e) => {
         e.stopPropagation();
         vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
       });
       
       sessionsList.appendChild(item);
     });
   }

   // Toggle sidebar
   const sidebar = document.getElementById('session-sidebar');
   const toggleBtn = document.getElementById('toggle-sidebar');
   const closeBtn = document.querySelector('.sidebar-close');
   const addSessionBtn = document.getElementById('add-session');
   
   toggleBtn.addEventListener('click', () => {
     sidebar.classList.add('open');
   });
   
   closeBtn.addEventListener('click', () => {
     sidebar.classList.remove('open');
   });
   
   addSessionBtn.addEventListener('click', () => {
     vscode.postMessage({ type: 'newSession' });
   });

    // Notify extension that the webview is ready
    vscode.postMessage({ type: 'ready' });

    window.addEventListener('message', event => {
      const msg = event.data;
      switch (msg.type) {
        case 'addMessage':   addMessage(msg.message.role, msg.message.content); break;
        case 'toolCall':     addToolCall(msg.name, msg.args); break;
        case 'toolResult':   resolveToolCard(msg.result); break;
        case 'loading':      showLoading(msg.loading); break;
        case 'error':        showError(msg.message); break;
        case 'tokenUsage':   showTokenUsage(msg.usage); break;
        case 'setRunning':   setRunningState(msg.running); break;
        case 'info':         showInfo(msg.message); break;
        case 'clearMessages':
          messagesDiv.innerHTML = '';
          pendingToolCard = null;
          break;
        case 'sessionsList':
          updateSessionsList(msg.sessions);
          break;
        case 'confirmEdit':
          showConfirmDialog(msg);
          break;
      }
    });

  // ── Edit confirmation dialog ───────────────────────────────────────────────
  const confirmOverlay  = document.getElementById('confirm-overlay');
  const confirmFileInfo = document.getElementById('confirm-file-info');
  const confirmBefore   = document.getElementById('confirm-before');
  const confirmAfter    = document.getElementById('confirm-after');
  const confirmApprove  = document.getElementById('confirm-approve-btn');
  const confirmReject   = document.getElementById('confirm-reject-btn');
  let _currentConfirmId = null;

  function renderContextLines(text, highlightCls) {
    return text.split('\n').map(line => {
      const isHighlighted = line.startsWith('>>>');
      const cls = isHighlighted ? highlightCls : 'line-context';
      return '<span class="' + cls + '">' + escHtml(line) + '</span>';
    }).join('\n');
  }

  function showConfirmDialog(msg) {
    _currentConfirmId = msg.confirmId;
    confirmFileInfo.textContent = msg.filePath + '  (行 ' + msg.startLine + '–' + msg.endLine + ')';
    confirmBefore.innerHTML = renderContextLines(msg.beforeContext, 'line-removed');
    confirmAfter.innerHTML  = renderContextLines(msg.afterContext,  'line-added');
    confirmOverlay.classList.add('visible');
  }

  function closeConfirmDialog(approved) {
    confirmOverlay.classList.remove('visible');
    if (_currentConfirmId) {
      vscode.postMessage({ type: 'confirmEditResponse', confirmId: _currentConfirmId, approved });
      _currentConfirmId = null;
    }
  }

  confirmApprove.addEventListener('click', () => closeConfirmDialog(true));
  confirmReject.addEventListener('click',  () => closeConfirmDialog(false));

   sendBtn.addEventListener('click', () => {
     const text = input.value.trim();
     input.value = '';
     input.style.height = 'auto';
     vscode.postMessage({ type: 'sendMessage', text });
   });

   stopBtn.addEventListener('click', () => {
     vscode.postMessage({ type: 'stopOperation' });
   });

   clearBtn.addEventListener('click', () => {
     vscode.postMessage({ type: 'clearHistory' });
   });

   input.addEventListener('keydown', e => {
     if (e.key === 'Enter' && !e.shiftKey) {
       e.preventDefault();
       sendBtn.click();
     }
   });

   // Auto-grow textarea
   input.addEventListener('input', () => {
     input.style.height = 'auto';
     input.style.height = Math.min(input.scrollHeight, 120) + 'px';
   });
