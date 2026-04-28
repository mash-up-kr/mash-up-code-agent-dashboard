/*
 * Chat frontend module.
 *
 * - Maintains an EventSource per group the user belongs to (multi-room).
 *   Switching the active view does NOT disconnect any stream — the user
 *   stays "online" in every group at once, so opening another room and
 *   coming back doesn't broadcast a join/leave.
 * - Each group keeps its own message + presence buffer. The actively
 *   selected group's buffer is rendered into both #chat-drawer (right
 *   rail) and #community-chat (community tab sub-view).
 * - Uses the existing session auth (GET /api/auth/me). No nickname
 *   prompt; display name comes from group_members.nickname on the server.
 *
 * Server contract (routes/chat.js):
 *   GET  /api/chat/groups/:groupId/stream
 *   POST /api/chat/groups/:groupId/messages   { content }
 */
(function () {
  'use strict';

  const HOSTS = ['#chat-drawer', '#community-chat'];
  const BUFFER_CAP = 500;   // hard cap per group to avoid unbounded growth

  let me = null;                            // { memberId, name, username }
  let activeGroupId = null;
  const groupConnections = new Map();       // groupId -> Connection

  // ─── Auth ──────────────────────────────────────────────────

  async function fetchMe() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) { return null; }
  }

  let authInFlight = null;
  async function refreshAuth() {
    if (authInFlight) return authInFlight;
    authInFlight = (async () => {
      const next = await fetchMe();
      const wasLoggedIn = !!me;
      const isLoggedIn  = !!next;
      me = next;

      if (isLoggedIn) {
        if (!wasLoggedIn) {
          // Just authenticated — open streams for every group we belong to.
          await bootstrapAllGroups();
        }
        if (activeGroupId) {
          setInputsDisabled(false, '메시지를 입력하세요...');
        } else {
          setInputsDisabled(true, '그룹에 입장하면 채팅이 시작됩니다.');
          renderIdleState();
        }
      } else {
        if (wasLoggedIn) {
          closeAllConnections();
          activeGroupId = null;
          clearMessagesUI();
          renderMemberMascots([]);
        }
        setInputsDisabled(true, '로그인 후 이용할 수 있습니다.');
      }
      authInFlight = null;
      return me;
    })();
    return authInFlight;
  }

  // ─── DOM discovery ─────────────────────────────────────────

  function discoverHost(hostSelector) {
    const host = document.querySelector(hostSelector);
    if (!host) return null;
    const messagesEl = host.querySelector('.flex-1.overflow-y-auto');
    const inputEl    = host.querySelector('input[type="text"]');
    const sendBtnEl  = inputEl && inputEl.parentElement
      ? inputEl.parentElement.querySelector('button')
      : null;
    if (!messagesEl || !inputEl || !sendBtnEl) return null;
    return { host, messagesEl, inputEl, sendBtnEl };
  }

  function eachHost(fn) {
    for (const sel of HOSTS) {
      const handle = discoverHost(sel);
      if (handle) fn(handle);
    }
  }

  // ─── Rendering helpers ─────────────────────────────────────

  const COLOR_PALETTE = [
    { accent: '#6046ff', icon: 'person' },
    { accent: '#45dfa4', icon: 'robot_2' },
    { accent: '#c6bfff', icon: 'account_circle' },
    { accent: '#68fcbf', icon: 'person_search' },
    { accent: '#ffb2b6', icon: 'face' },
    { accent: '#ffdadb', icon: 'smart_toy' },
  ];

  function colorForMember(memberId) {
    const id = Number(memberId) || 0;
    return COLOR_PALETTE[Math.abs(id) % COLOR_PALETTE.length];
  }

  function formatTime(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return '';
    return d.toTimeString().slice(0, 8);
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function buildMessageNode(msg) {
    const isSelf = !!(me && Number(msg.memberId) === Number(me.memberId));
    const { accent, icon } = colorForMember(msg.memberId);
    const wrap = document.createElement('div');
    wrap.className = isSelf ? 'flex gap-3 flex-row-reverse' : 'flex gap-3';
    wrap.dataset.msgId = String(msg.id);
    const headerLayout = isSelf ? 'flex-row-reverse' : 'justify-between';
    const bubbleStyle  = isSelf
      ? `background:${accent}1a;border-color:${accent}55;color:#e3e1ec`
      : 'background:#1c1f2e;border-color:#252838;color:#cbd5e1';
    wrap.innerHTML = `
      <div class="w-8 h-8 rounded bg-[#1c1f2e] flex-shrink-0 flex items-center justify-center"
           style="border:1px solid ${accent}33">
        <span class="material-symbols-outlined text-lg msg-icon" style="color:${accent}"></span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-baseline gap-2 mb-1 ${headerLayout}">
          <span class="font-bold font-mono msg-name" style="color:${accent}"></span>
          <span class="text-[9px] text-slate-500 msg-time"></span>
        </div>
        <div class="p-2.5 rounded border leading-relaxed" style="${bubbleStyle}">
          <p class="break-words whitespace-pre-wrap msg-content"></p>
        </div>
      </div>
    `;
    wrap.querySelector('.msg-icon').textContent = icon;
    wrap.querySelector('.msg-name').textContent = msg.nickname || `member_${msg.memberId}`;
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

  function appendMessageUI(msg) {
    eachHost(({ messagesEl }) => {
      messagesEl.appendChild(buildMessageNode(msg));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function appendSystemUI(text) {
    eachHost(({ messagesEl }) => {
      messagesEl.appendChild(buildSystemNode(text));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function clearMessagesUI() {
    eachHost(({ messagesEl }) => { messagesEl.innerHTML = ''; });
  }

  function setInputsDisabled(disabled, placeholder) {
    eachHost(({ inputEl, sendBtnEl }) => {
      inputEl.disabled = disabled;
      sendBtnEl.disabled = disabled;
      inputEl.style.opacity   = disabled ? '0.45' : '';
      inputEl.style.cursor    = disabled ? 'not-allowed' : '';
      sendBtnEl.style.opacity = disabled ? '0.35' : '';
      sendBtnEl.style.cursor  = disabled ? 'not-allowed' : '';
      if (placeholder != null) inputEl.placeholder = placeholder;
      if (disabled) inputEl.value = '';
    });
  }

  function renderMemberMascots(members) {
    const grid = document.getElementById('member-grid');
    if (!grid) return;
    if (!Array.isArray(members) || members.length === 0) {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = members.map(m => {
      const nick = m.nickname || `member_${m.memberId}`;
      return `
        <div class="bg-[#13151f] border border-[#6046ff]/40 rounded-xl flex flex-col items-center justify-center transition-colors p-2">
          <img src="/img/mascot_waiting.png" alt="${escHtml(nick)}" class="w-16 h-16 object-contain">
          <span class="text-xs text-slate-200 font-bold mt-3 truncate max-w-[90%]">${escHtml(nick)}</span>
          <div class="flex items-center gap-1 mt-1">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span class="text-[9px] text-emerald-400">online</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Suppress the placeholder "대기 중" tiles app.js would otherwise render.
  if (typeof window !== 'undefined') {
    window.renderMemberGrid = function () {
      const grid = document.getElementById('member-grid');
      if (grid) grid.innerHTML = '';
    };
  }

  // ─── Connection management ─────────────────────────────────

  function pushBufferEntry(conn, entry) {
    conn.messages.push(entry);
    if (conn.messages.length > BUFFER_CAP) {
      conn.messages.splice(0, conn.messages.length - BUFFER_CAP);
    }
  }

  function ensureConnection(groupId) {
    const id = Number(groupId);
    if (!id) return null;
    if (groupConnections.has(id)) return groupConnections.get(id);

    const conn = {
      es: null,
      messages: [],          // mixed { _system, text } | regular message
      renderedIds: new Set(),
      presence: [],
    };

    const es = new EventSource(`/api/chat/groups/${id}/stream`, { withCredentials: true });

    es.addEventListener('init', (e) => {
      let data; try { data = JSON.parse(e.data); } catch (_) { return; }
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      conn.messages = msgs.slice();
      conn.renderedIds = new Set(msgs.map(m => m.id).filter(x => x != null));
      if (id === activeGroupId) renderActive();
    });

    es.addEventListener('chat', (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.id != null && conn.renderedIds.has(m.id)) return;
      if (m.id != null) conn.renderedIds.add(m.id);
      pushBufferEntry(conn, m);
      if (id === activeGroupId) appendMessageUI(m);
    });

    es.addEventListener('member_change', (e) => {
      let data; try { data = JSON.parse(e.data); } catch (_) { return; }
      const targetId = Number(data.memberId);
      // It's about us — if it's a permanent leave (group leave or logout),
      // shut down our SSE for this group.
      if (me && targetId === Number(me.memberId)) {
        if (data.type === 'left') closeConnection(id);
        return;
      }
      const nick = data.nickname || `member_${targetId}`;
      const text = data.type === 'joined'
        ? `${nick}님이 그룹에 참여했어요`
        : `${nick}님이 그룹을 떠났어요`;
      pushBufferEntry(conn, { _system: true, text });
      if (id === activeGroupId) appendSystemUI(text);
    });

    es.addEventListener('presence', (e) => {
      let data; try { data = JSON.parse(e.data); } catch (_) { return; }
      conn.presence = Array.isArray(data.members) ? data.members : [];
      if (id === activeGroupId) renderMemberMascots(conn.presence);
    });

    es.onerror = () => { /* browser auto-reconnects */ };

    conn.es = es;
    groupConnections.set(id, conn);
    return conn;
  }

  function closeConnection(groupId) {
    const id = Number(groupId);
    const conn = groupConnections.get(id);
    if (conn && conn.es) {
      try { conn.es.close(); } catch (_) {}
    }
    groupConnections.delete(id);
    if (id === activeGroupId) {
      activeGroupId = null;
      clearMessagesUI();
      renderMemberMascots([]);
      setInputsDisabled(true, '그룹에 입장하면 채팅이 시작됩니다.');
      renderIdleState();
    }
  }

  function closeAllConnections() {
    for (const id of [...groupConnections.keys()]) {
      const conn = groupConnections.get(id);
      if (conn && conn.es) {
        try { conn.es.close(); } catch (_) {}
      }
    }
    groupConnections.clear();
  }

  async function bootstrapAllGroups() {
    if (!me) return;
    try {
      const res = await fetch('/api/community/groups', { credentials: 'same-origin' });
      if (!res.ok) return;
      const groups = await res.json();
      if (!Array.isArray(groups)) return;
      for (const g of groups) ensureConnection(g.id);
    } catch (_) { /* ignore */ }
  }

  // ─── Active group selection ────────────────────────────────

  function setActiveGroup(groupId) {
    const id = Number(groupId);
    if (!id || id === activeGroupId) return;
    ensureConnection(id);                 // open if not already
    activeGroupId = id;
    setInputsDisabled(false, '메시지를 입력하세요...');
    renderActive();
  }

  function clearActiveGroup() {
    activeGroupId = null;
    clearMessagesUI();
    renderMemberMascots([]);
    setInputsDisabled(true, '그룹에 입장하면 채팅이 시작됩니다.');
    renderIdleState();
  }

  function renderActive() {
    if (!activeGroupId) return;
    const conn = groupConnections.get(activeGroupId);
    if (!conn) return;
    clearMessagesUI();
    for (const m of conn.messages) {
      if (m._system) appendSystemUI(m.text);
      else appendMessageUI(m);
    }
    renderMemberMascots(conn.presence);
  }

  // ─── Sending ───────────────────────────────────────────────

  async function sendMessage(content) {
    const text = (content || '').trim();
    if (!text) return;
    if (!me) await refreshAuth();
    if (!me) {
      appendSystemUI('로그인이 필요합니다.');
      return;
    }
    if (!activeGroupId) {
      appendSystemUI('먼저 그룹을 선택해주세요.');
      return;
    }
    try {
      const res = await fetch(`/api/chat/groups/${activeGroupId}/messages`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        appendSystemUI(`전송 실패: ${err.error || res.status}`);
      }
    } catch (err) {
      appendSystemUI(`네트워크 오류: ${err.message || err}`);
    }
  }

  // ─── Idle state (logged in but no active group) ────────────

  async function renderIdleState() {
    if (!me || activeGroupId) return;
    let groups = [];
    try {
      const res = await fetch('/api/community/groups', { credentials: 'same-origin' });
      if (res.ok) groups = await res.json();
    } catch (_) { /* ignore */ }
    if (!Array.isArray(groups)) groups = [];
    if (activeGroupId) return;
    showGroupPicker(groups);
  }

  function showGroupPicker(groups) {
    const emptyHtml = `
      <div class="flex flex-col items-center justify-center py-10 px-4 text-center">
        <div class="w-14 h-14 mb-4 border border-dashed border-[#6046ff]/40 rounded-xl flex items-center justify-center">
          <span class="material-symbols-outlined text-2xl text-[#6046ff]">group_add</span>
        </div>
        <p class="text-xs text-slate-300 mb-1">참여 중인 그룹이 없어요</p>
        <p class="text-[10px] text-slate-500 mb-4">커뮤니티에서 그룹을 만들거나 참여해주세요</p>
        <button class="chat-go-community px-4 py-2 bg-[#6046ff] hover:bg-[#725bff] text-white text-[11px] font-bold rounded-lg transition-colors cursor-pointer">
          커뮤니티 탭 열기
        </button>
      </div>
    `;
    const listHtml = groups.length === 0 ? emptyHtml : `
      <div class="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-3 px-1">
        참여 중인 그룹 (선택해서 입장)
      </div>
      ${groups.map(g => `
        <button class="chat-pick-group w-full text-left p-3 mb-2 bg-[#1c1f2e] border border-[#252838] hover:border-[#6046ff]/50 hover:bg-[#1c1f2e]/80 rounded-lg transition-colors cursor-pointer" data-group-id="${g.id}">
          <div class="font-bold text-sm text-slate-200 mb-1 truncate">${escHtml(g.name)}</div>
          <div class="text-[10px] text-slate-500 font-mono">${g.memberCount}/${g.maxMembers} MEMBERS</div>
        </button>
      `).join('')}
    `;
    eachHost(({ messagesEl }) => { messagesEl.innerHTML = listHtml; });
  }

  // ─── Input binding ─────────────────────────────────────────

  function explainBlockedAction() {
    if (!me) {
      appendSystemUI('로그인 후 이용할 수 있어요.');
    } else if (!activeGroupId) {
      appendSystemUI('아직 그룹이 없어 채팅을 사용할 수 없어요. 커뮤니티 탭에서 그룹을 만들거나 참여해주세요.');
    }
  }

  function bindInputs() {
    eachHost(({ inputEl, sendBtnEl }) => {
      if (inputEl.dataset.chatBound !== '1') {
        inputEl.dataset.chatBound = '1';
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
            e.preventDefault();
            const value = inputEl.value;
            inputEl.value = '';
            sendMessage(value);
          }
        });
        const wrap = inputEl.parentElement;
        if (wrap && wrap.dataset.chatWrapBound !== '1') {
          wrap.dataset.chatWrapBound = '1';
          wrap.addEventListener('click', () => {
            if (inputEl.disabled) explainBlockedAction();
          });
        }
      }
      if (sendBtnEl.dataset.chatBound !== '1') {
        sendBtnEl.dataset.chatBound = '1';
        sendBtnEl.addEventListener('click', () => {
          if (sendBtnEl.disabled) {
            explainBlockedAction();
            return;
          }
          const value = inputEl.value;
          inputEl.value = '';
          sendMessage(value);
        });
      }
    });
  }

  // ─── Community tab navigation ──────────────────────────────

  function bindCommunityNavigation() {
    const community = document.getElementById('view-community');
    if (!community || community.dataset.chatNavBound === '1') return;
    community.dataset.chatNavBound = '1';

    community.addEventListener('click', (e) => {
      const enterBtn = e.target.closest('.btn-group-enter');
      if (enterBtn) {
        const card = enterBtn.closest('[data-group-id]');
        const groupId = card && Number(card.dataset.groupId);
        if (groupId) setActiveGroup(groupId);
        return;
      }
      // The "back" button is just UI navigation now — the SSE stream
      // stays alive so the user is still subscribed/online in the group.
      if (e.target.closest('#btn-group-back')) {
        clearActiveGroup();
      }
    });
  }

  async function resolveCurrentGroupFromServer() {
    if (activeGroupId) return;
    try {
      const res = await fetch('/api/community/groups', { credentials: 'same-origin' });
      if (!res.ok) return;
      const groups = await res.json();
      if (!Array.isArray(groups) || groups.length === 0) return;
      // Make sure we're subscribed to every group we belong to (in case
      // we joined/created one mid-session).
      for (const g of groups) ensureConnection(g.id);
      setActiveGroup(groups[0].id);
    } catch (_) { /* ignore */ }
  }

  function bindCommunityChatVisibility() {
    const el = document.getElementById('community-chat');
    if (!el || el.dataset.chatVisBound === '1') return;
    el.dataset.chatVisBound = '1';

    const check = () => {
      if (!el.classList.contains('hidden') && !activeGroupId) {
        resolveCurrentGroupFromServer();
      }
    };
    new MutationObserver(check).observe(el, {
      attributes: true,
      attributeFilter: ['class'],
    });
    check(); // initial
  }

  // ─── Init ──────────────────────────────────────────────────

  async function init() {
    bindInputs();
    bindCommunityNavigation();
    bindCommunityChatVisibility();
    clearMessagesUI();

    await refreshAuth();

    const observer = new MutationObserver(() => {
      bindInputs();
      bindCommunityNavigation();
      bindCommunityChatVisibility();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Re-check auth on any click while logged out so the login modal
    // closing automatically refreshes our state.
    document.addEventListener('click', () => {
      if (!me) refreshAuth();
    }, true);

    window.addEventListener('focus', () => { refreshAuth(); });

    // Group picker actions (event-delegated so future re-renders work).
    document.addEventListener('click', (e) => {
      const pick = e.target.closest('.chat-pick-group');
      if (pick) {
        const id = Number(pick.dataset.groupId);
        if (id) setActiveGroup(id);
        return;
      }
      if (e.target.closest('.chat-go-community')) {
        const tabBtn = document.querySelector('.tab-btn[data-tab="community"]');
        if (tabBtn) tabBtn.click();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
