/*
 * Chat frontend module.
 *
 * Self-discovers DOM elements inside #chat-drawer so index.html stays
 * untouched apart from a single <script> tag. On init:
 *   - clears dummy sample messages
 *   - opens an SSE stream to /api/chat/stream
 *   - wires the drawer's input/send button to POST /api/chat/send
 * Nickname is prompted once and cached in localStorage.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'chatUserName';

  let userName = null;
  let eventSource = null;
  let messagesEl = null;
  let inputEl = null;
  let sendBtnEl = null;
  const renderedIds = new Set();

  // ─── Nickname ──────────────────────────────────────────────

  function ensureUserName() {
    if (userName) return userName;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored.trim()) {
      userName = stored.trim();
      return userName;
    }
    const entered = window.prompt('채팅에서 사용할 닉네임을 입력하세요');
    if (!entered || !entered.trim()) return null;
    userName = entered.trim().slice(0, 64);
    localStorage.setItem(STORAGE_KEY, userName);
    return userName;
  }

  // ─── Rendering ─────────────────────────────────────────────

  const COLOR_PALETTE = [
    { accent: '#6046ff', icon: 'person' },
    { accent: '#45dfa4', icon: 'robot_2' },
    { accent: '#c6bfff', icon: 'account_circle' },
    { accent: '#68fcbf', icon: 'person_search' },
    { accent: '#ffb2b6', icon: 'face' },
    { accent: '#ffdadb', icon: 'smart_toy' },
  ];

  function colorFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    }
    return COLOR_PALETTE[h % COLOR_PALETTE.length];
  }

  function formatTime(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return '';
    return d.toTimeString().slice(0, 8);
  }

  function buildMessageNode(msg) {
    const { accent, icon } = colorFor(msg.userName || 'anon');
    const wrap = document.createElement('div');
    wrap.className = 'flex gap-3';
    wrap.dataset.msgId = String(msg.id);
    wrap.innerHTML = `
      <div class="w-8 h-8 rounded bg-[#1c1f2e] flex-shrink-0 flex items-center justify-center"
           style="border:1px solid ${accent}33">
        <span class="material-symbols-outlined text-lg msg-icon" style="color:${accent}"></span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline justify-between mb-1">
          <span class="font-bold font-mono msg-name" style="color:${accent}"></span>
          <span class="text-[9px] text-slate-500 msg-time"></span>
        </div>
        <div class="bg-[#1c1f2e] p-2.5 rounded border border-[#252838] text-slate-300 leading-relaxed">
          <p class="break-words whitespace-pre-wrap msg-content"></p>
        </div>
      </div>
    `;
    wrap.querySelector('.msg-icon').textContent = icon;
    wrap.querySelector('.msg-name').textContent = msg.userName || 'anon';
    wrap.querySelector('.msg-time').textContent = formatTime(msg.createdAt);
    wrap.querySelector('.msg-content').textContent = msg.content || '';
    return wrap;
  }

  function buildSystemNode(text) {
    const wrap = document.createElement('div');
    wrap.className = 'py-2 flex items-center gap-2 px-1';
    wrap.innerHTML = `
      <div class="h-px flex-1 bg-gradient-to-r from-transparent via-[#252838] to-transparent"></div>
      <span class="text-[9px] font-mono text-slate-500 uppercase sys-text"></span>
      <div class="h-px flex-1 bg-gradient-to-r from-transparent via-[#252838] to-transparent"></div>
    `;
    wrap.querySelector('.sys-text').textContent = text;
    return wrap;
  }

  function appendMessage(msg) {
    if (!messagesEl) return;
    if (msg.id != null && renderedIds.has(msg.id)) return;
    if (msg.id != null) renderedIds.add(msg.id);
    messagesEl.appendChild(buildMessageNode(msg));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendSystem(text) {
    if (!messagesEl) return;
    messagesEl.appendChild(buildSystemNode(text));
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearMessages() {
    renderedIds.clear();
    if (messagesEl) messagesEl.innerHTML = '';
  }

  // ─── SSE connection ────────────────────────────────────────

  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/chat/stream');

    eventSource.addEventListener('init', (e) => {
      let data;
      try { data = JSON.parse(e.data); }
      catch (_) { return; }
      clearMessages();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      for (const msg of messages) appendMessage(msg);
      if (data.dbReady === false) {
        appendSystem('DB 미연결 — 메시지는 세션 동안만 유지됩니다');
      }
    });

    eventSource.addEventListener('chat', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); }
      catch (_) { return; }
      appendMessage(msg);
    });

    eventSource.onerror = () => {
      // EventSource auto-reconnects; nothing to do here.
    };
  }

  // ─── Sending ───────────────────────────────────────────────

  async function sendMessage(content) {
    const text = (content || '').trim();
    if (!text) return;
    const name = ensureUserName();
    if (!name) {
      appendSystem('닉네임이 필요합니다');
      return;
    }
    try {
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: name, content: text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        appendSystem(`전송 실패: ${err.error || res.status}`);
      }
    } catch (err) {
      appendSystem(`네트워크 오류: ${err.message || err}`);
    }
  }

  // ─── DOM discovery ─────────────────────────────────────────

  function findDrawerElements() {
    const drawer = document.getElementById('chat-drawer');
    if (!drawer) return false;
    messagesEl = drawer.querySelector('.flex-1.overflow-y-auto');
    inputEl = drawer.querySelector('input[type="text"]');
    sendBtnEl = inputEl && inputEl.parentElement
      ? inputEl.parentElement.querySelector('button')
      : null;
    return !!(messagesEl && inputEl && sendBtnEl);
  }

  function bindInputs() {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
        e.preventDefault();
        const value = inputEl.value;
        inputEl.value = '';
        sendMessage(value);
      }
    });
    sendBtnEl.addEventListener('click', () => {
      const value = inputEl.value;
      inputEl.value = '';
      sendMessage(value);
    });
  }

  // ─── Init ──────────────────────────────────────────────────

  function init() {
    if (!findDrawerElements()) {
      console.warn('[chat] #chat-drawer elements not found; chat disabled');
      return;
    }
    clearMessages();
    bindInputs();
    connectSSE();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
