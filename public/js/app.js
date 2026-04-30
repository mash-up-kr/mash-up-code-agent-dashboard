'use strict';

const DEFAULT_COMMUNITY_API = 'http://223.130.141.52:4321';
const COMMUNITY_API = window.MASHUP_DASHBOARD_CONFIG?.communityApiUrl || DEFAULT_COMMUNITY_API;

/* ══════════════════════════════════════════════════
   DOM References
   ══════════════════════════════════════════════════ */
const sessionsEl     = document.getElementById('session-list');
const agentsEl       = document.getElementById('agent-list');
const statusPill     = document.getElementById('status-pill');
const headerTime     = document.getElementById('header-time');
const headerSessLbl  = document.getElementById('header-session-label');
const canvasEmpty    = document.getElementById('canvas-empty');

/* Dashboard */
const statTotalEvents    = document.getElementById('stat-total-events');
const statCost           = document.getElementById('stat-cost');
const statActiveSessions = document.getElementById('stat-active-sessions');
const eventTableBody     = document.getElementById('event-table-body');
const syncLabel          = document.getElementById('sync-label');
const costEstimate       = document.getElementById('cost-estimate');

/* ══════════════════════════════════════════════════
   State
   ══════════════════════════════════════════════════ */
const sessions = new Map();
let totalEvents = 0;
let toolCallCount = 0;
const eventHistory = [];
const timelineBuckets = new Array(20).fill(0);
const eventTypeCounts = { tool_use: 0, thinking_start: 0, agent_start: 0, session_start: 0 };
const dailyBuckets = [0, 0, 0, 0, 0, 0, 0]; // MON-SUN

/* ── Project Goal Timers (localStorage) ────────── */
function loadProjectGoals() {
  try { return JSON.parse(localStorage.getItem('projectGoals') || '{}'); } catch { return {}; }
}
function saveProjectGoals(goals) {
  localStorage.setItem('projectGoals', JSON.stringify(goals));
}
const goalNotified = new Set(); // track which projects already got goal-reached toast today

/* ══════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════ */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString('en', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

/* Clock */
function updateClock() {
  if (headerTime) {
    headerTime.textContent = new Date().toLocaleString('en', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).replace(',', '');
  }
}
setInterval(updateClock, 1000);
updateClock();

/* ══════════════════════════════════════════════════
   Tab Switching
   ══════════════════════════════════════════════════ */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    // Reset all tabs
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('tab-btn--active', 'border-[#6046ff]', 'text-[#6046ff]', 'font-bold');
      b.classList.add('border-transparent', 'text-slate-500');
    });
    // Activate clicked
    btn.classList.add('tab-btn--active', 'border-[#6046ff]', 'text-[#6046ff]', 'font-bold');
    btn.classList.remove('border-transparent', 'text-slate-500');

    // Show target view
    document.querySelectorAll('.view-panel').forEach(v => v.classList.add('hidden'));
    const target = document.getElementById('view-' + btn.dataset.tab);
    if (target) target.classList.remove('hidden');

    // 커뮤니티 탭에서는 채팅 드로어 버튼 비활성화
    const isCommunity = btn.dataset.tab === 'community';
    const chatToggleBtn = document.getElementById('btn-chat-toggle');
    if (chatToggleBtn) {
      if (isCommunity) {
        chatToggleBtn.disabled = true;
        chatToggleBtn.classList.add('opacity-30', 'cursor-not-allowed');
        chatToggleBtn.classList.remove('hover:bg-[#1c1f2e]');
        // 드로어가 열려있으면 닫기
        document.getElementById('chat-drawer')?.classList.add('closed');
        updateChatToggleStyle();
      } else {
        chatToggleBtn.disabled = false;
        chatToggleBtn.classList.remove('opacity-30', 'cursor-not-allowed');
        chatToggleBtn.classList.add('hover:bg-[#1c1f2e]');
      }
    }

    // 대시보드 탭 렌더링
    if (btn.dataset.tab === 'dashboard') {
      loadUsageSnapshot();
    }
  });
});

/* ══════════════════════════════════════════════════
   Chat Drawer Toggle
   ══════════════════════════════════════════════════ */
const chatDrawer = document.getElementById('chat-drawer');
const btnChatToggle = document.getElementById('btn-chat-toggle');
const updateChatToggleStyle = () => {
  const isClosed = chatDrawer?.classList.contains('closed');
  if (isClosed) {
    btnChatToggle?.classList.remove('text-[#6046ff]', 'bg-[#6046ff]/10');
    btnChatToggle?.classList.add('text-slate-400');
  } else {
    btnChatToggle?.classList.remove('text-slate-400');
    btnChatToggle?.classList.add('text-[#6046ff]', 'bg-[#6046ff]/10');
  }
};
btnChatToggle?.addEventListener('click', () => {
  chatDrawer?.classList.toggle('closed');
  setTimeout(updateChatToggleStyle, 0);
});
document.getElementById('btn-chat-close')?.addEventListener('click', () => {
  chatDrawer?.classList.add('closed');
  updateChatToggleStyle();
});
updateChatToggleStyle();

/* ══════════════════════════════════════════════════
   Render: Sidebar Sessions
   ══════════════════════════════════════════════════ */
function renderSessions() {
  syncMascots();
  if (!sessionsEl) return;

  if (sessions.size === 0) {
    sessionsEl.innerHTML = `
      <div class="p-2 rounded text-[10px] text-slate-500">No active sessions</div>`;
    if (agentsEl) agentsEl.innerHTML = `
      <div class="p-2 rounded text-[10px] text-slate-500">No agents</div>`;
    return;
  }

  // Sessions
  let sessionHtml = '';
  let agentHtml = '';
  let first = true;

  for (const s of sessions.values()) {
    const badge = statusBadge(s.status);
    const name = s.name || 'unknown';
    const displayId = (s.sid || name).slice(0, 10).toUpperCase();
    const timeLabel = first ? 'now processing...' : formatTimeAgo(s.startedAt);
    const projectName = s.cwd ? s.cwd.split('/').pop() : '';

    // Session card
    if (first) {
      sessionHtml += `
        <div class="p-2 rounded bg-[#6046ff]/10 border-l-2 border-[#6046ff] shadow-[0_0_12px_rgba(96,70,255,0.1)] cursor-pointer">
          <div class="flex justify-between items-start mb-1">
            <span class="text-xs font-mono text-[#c6bfff]">${esc(displayId)}</span>
            <span class="text-[9px] px-1.5 py-0.5 rounded ${badge.cls} font-bold">${badge.text}</span>
          </div>
          <div class="text-[10px] text-slate-400">${esc(timeLabel)}</div>
          ${projectName ? `<div class="text-[9px] text-[#6046ff]/70 mt-0.5 flex items-center gap-1"><span class="material-symbols-outlined text-[10px]">folder</span>${esc(projectName)}</div>` : ''}
        </div>`;
    } else {
      sessionHtml += `
        <div class="p-2 rounded hover:bg-[#1c1f2e] transition-all cursor-pointer group">
          <div class="flex justify-between items-start mb-1">
            <span class="text-xs font-mono text-slate-400 group-hover:text-slate-300">${esc(displayId)}</span>
            <span class="text-[9px] px-1.5 py-0.5 rounded ${badge.cls} font-bold">${badge.text}</span>
          </div>
          <div class="text-[10px] text-slate-500">${esc(timeLabel)}</div>
          ${projectName ? `<div class="text-[9px] text-slate-600 mt-0.5 flex items-center gap-1"><span class="material-symbols-outlined text-[10px]">folder</span>${esc(projectName)}</div>` : ''}
        </div>`;
    }

    // Agent card
    const dotColor = agentDotColor(s.status);
    const statusLabel = agentStatusLabel(s.status);
    const statusColor = agentStatusColor(s.status);
    agentHtml += `
      <div class="flex items-center gap-3 p-2 rounded hover:bg-[#1c1f2e] transition-all cursor-pointer">
        <div class="relative">
          <span class="material-symbols-outlined text-slate-400">smart_toy</span>
          <span class="absolute bottom-0 right-0 w-2 h-2 rounded-full ${dotColor} border border-[#0a0b12]"></span>
        </div>
        <div class="flex-1">
          <div class="text-slate-300">${esc(name)}</div>
          <div class="text-[10px] ${statusColor}">${statusLabel}</div>
        </div>
      </div>`;

    // Update header session label for first session
    if (first && headerSessLbl) {
      headerSessLbl.textContent = 'Session: ' + displayId.toLowerCase();
    }
    first = false;
  }

  sessionsEl.innerHTML = sessionHtml;
  if (agentsEl) agentsEl.innerHTML = agentHtml;
}

function statusBadge(status) {
  switch (status) {
    case 'idle':     return { text: 'ACTIVE',   cls: 'bg-emerald-500/10 text-emerald-400' };
    case 'thinking': return { text: 'THINKING', cls: 'bg-indigo-500/10 text-indigo-400 animate-pulse' };
    case 'running':  return { text: 'RUNNING',  cls: 'bg-amber-500/10 text-amber-400 animate-pulse' };
    case 'ended':    return { text: 'ENDED',    cls: 'bg-slate-500/10 text-slate-500' };
    default:         return { text: 'IDLE',     cls: 'bg-emerald-500/10 text-emerald-400' };
  }
}

function agentDotColor(s) {
  return { running: 'bg-amber-500', thinking: 'bg-indigo-500 animate-pulse', idle: 'bg-sky-500', ended: 'bg-slate-500' }[s] || 'bg-sky-500';
}
function agentStatusLabel(s) {
  return { running: '작업 중', thinking: '사고 중', idle: '대기 중', ended: '완료' }[s] || '대기 중';
}
function agentStatusColor(s) {
  return { running: 'text-amber-500/80', thinking: 'text-indigo-500/80', idle: 'text-sky-500/80', ended: 'text-slate-500' }[s] || 'text-sky-500/80';
}

/* ══════════════════════════════════════════════════
   Render: Event Log (Workspace)
   ══════════════════════════════════════════════════ */
function appendEvent(e) {
  if (canvasEmpty) canvasEmpty.style.display = 'none';

  totalEvents++;
  if (e.type === 'tool_use') toolCallCount++;

  // Track last tool per session (for mascot bubbles)
  if ((e.type === 'tool_use' || e.type === 'pre_tool_use') && e.pid) {
    sessionLastTool.set(e.pid, { toolName: e.toolName, toolDetail: e.toolDetail || '', ts: e.ts });
    // Only clear permission pending on actual tool execution, not pre_tool_use
    // (pre_tool_use fires before permission check; permission_request comes after)
    if (e.type === 'tool_use') sessionPermPending.delete(e.pid);
    const m = activeMascots.get(e.pid);
    if (m) updateBubble(m, sessions.get(e.pid)?.status || 'idle');
    // Track current in-progress task per session
    if (e.toolName === 'TaskCreate' && e.toolDetail) {
      if (!sessionTaskList.has(e.pid)) sessionTaskList.set(e.pid, []);
      sessionTaskList.get(e.pid).push({ subject: e.toolDetail, status: 'pending' });
      updateMascotTaskLabel(e.pid);
    }
    if (e.toolName === 'TaskUpdate' && e.toolDetail) {
      const list = sessionTaskList.get(e.pid) || [];
      // Extract task number from "#N → status"
      const match = e.toolDetail.match(/#(\d+)\s*→\s*(\S+)/);
      const newStatus = match ? match[2] : '';
      // Find the task to update — try index-based within session list
      if (newStatus === 'in_progress') {
        // Find the oldest pending task and mark it in_progress (FIFO)
        const task = list.find(t => t.status !== 'completed' && t.status !== 'in_progress');
        if (task) task.status = 'in_progress';
        // Set current task label to in-progress task
        const activeTask = list.find(t => t.status === 'in_progress');
        if (activeTask) sessionCurrentTask.set(e.pid, { subject: activeTask.subject });
        updateMascotTaskLabel(e.pid);
      }
      if (newStatus === 'completed') {
        // Mark the oldest in_progress or pending task as completed
        const task = list.find(t => t.status === 'in_progress') || list.find(t => t.status !== 'completed');
        if (task) task.status = 'completed';
        // Update current task to next in_progress, or clear
        const nextActive = list.find(t => t.status === 'in_progress');
        if (nextActive) sessionCurrentTask.set(e.pid, { subject: nextActive.subject });
        else sessionCurrentTask.delete(e.pid);
        updateMascotTaskLabel(e.pid);
      }
    }
    // Trigger excited mood on task completion
    if (e.toolName === 'TaskUpdate' && e.toolDetail && e.toolDetail.includes('completed')) {
      triggerExcitedMood(e.pid);
    }
  }
  if (e.type === 'permission_request' && e.pid) {
    sessionPermPending.set(e.pid, { toolName: e.toolName, toolDetail: e.toolDetail || '', ts: e.ts || Date.now() });
    const m = activeMascots.get(e.pid);
    if (m) updateBubble(m, sessions.get(e.pid)?.status || 'idle');
  }
  // Note: do NOT clear sessionPermPending on thinking_start/thinking_end.
  // Permission pending is only resolved when tool_use (PostToolUse) fires,
  // meaning the user actually approved and the tool executed.
  // Track compaction state
  if (e.type === 'pre_compact' && e.pid) {
    sessionCompacting.add(e.pid);
    const m = activeMascots.get(e.pid);
    if (m) updateBubble(m, sessions.get(e.pid)?.status || 'idle');
  }
  if (e.type === 'post_compact' && e.pid) {
    sessionCompacting.delete(e.pid);
    const m = activeMascots.get(e.pid);
    if (m) updateBubble(m, sessions.get(e.pid)?.status || 'idle');
  }
  // Stop — Claude finished responding: clear priority states and show persistent completion message
  if (e.type === 'stop' && e.pid) {
    sessionPermPending.delete(e.pid);
    sessionCompacting.delete(e.pid);
    // Don't overwrite excited completion message from task completion
    if (!sessionStopMessage.has(e.pid)) {
      const stopQuotes = ['끝! 다음 메시지 보내줘~', '응답 완료! 확인해봐~', '다 했어! 이어서 보내줘~', '입력 기다리는 중~', '완료! 확인하고 이어가자~'];
      sessionStopMessage.set(e.pid, { quote: stopQuotes[Math.floor(Math.random() * stopQuotes.length)], excited: false, ts: Date.now() });
    }
    const m = activeMascots.get(e.pid);
    if (m) updateBubble(m, sessions.get(e.pid)?.status || 'idle');
  }
  // Clear completion message when new activity starts.
  // thinking_start/agent_start aren't wired as hooks in Claude Code, so rely on
  // the events we actually receive: pre_tool_use/tool_use/permission_request.
  const activityEvents = ['thinking_start', 'agent_start', 'pre_tool_use', 'tool_use', 'permission_request'];
  if (activityEvents.includes(e.type) && e.pid) {
    if (sessionStopMessage.has(e.pid)) {
      sessionStopMessage.delete(e.pid);
      const m = activeMascots.get(e.pid);
      if (m) { const b = m.el.querySelector('.mascot-bubble'); if (b) b.style.borderColor = ''; }
    }
  }

  // Track for dashboard
  eventHistory.push(e);
  if (eventHistory.length > 50) eventHistory.shift();

  // Daily bucket (use day of week)
  const day = new Date(e.ts).getDay();
  const idx = day === 0 ? 6 : day - 1; // MON=0 ... SUN=6
  dailyBuckets[idx]++;

  // Timeline bucket
  timelineBuckets.push(1);
  if (timelineBuckets.length > 20) timelineBuckets.shift();

  updateDashboard();
}

/* ══════════════════════════════════════════════════
   Render: Dashboard
   ══════════════════════════════════════════════════ */
let weeklySessionCount = 0;

function updateWeeklySessionCount() {
  fetch('/api/projects')
    .then(r => r.json())
    .then(projects => {
      const now = new Date();
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
      monday.setHours(0, 0, 0, 0);
      const mondayTs = monday.getTime();

      let count = 0;
      for (const proj of projects) {
        for (const s of proj.sessions || []) {
          if (s.startedAt >= mondayTs) count++;
        }
      }
      weeklySessionCount = count;
      if (statActiveSessions) statActiveSessions.textContent = weeklySessionCount;
    })
    .catch(() => {});
}

updateWeeklySessionCount();
setInterval(updateWeeklySessionCount, 30000);

function updateDashboard() {
  if (statTotalEvents) statTotalEvents.textContent = totalEvents.toLocaleString();
  if (statActiveSessions) statActiveSessions.textContent = weeklySessionCount;
  if (syncLabel) syncLabel.textContent = 'Sync: just now';

  // Estimate cost (rough: ~$0.003 per event as illustrative)
  const estCost = (totalEvents * 0.003).toFixed(2);
  if (statCost) statCost.textContent = '$' + estCost;
  if (costEstimate) costEstimate.textContent = 'Estimated $' + (totalEvents * 0.003 * 4).toFixed(2) + ' EOM';

  updateBarChart();
  updateTimeline();
  updateTable();
}

function updateBarChart() {
  const el = document.getElementById('chart-bars');
  if (!el) return;

  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const max = Math.max(1, ...dailyBuckets);

  el.innerHTML = dailyBuckets.map((v, i) => {
    const pct = Math.max(5, (v / max) * 100);
    const isTop = v === max && v > 0;
    const barBg = isTop ? 'bg-[#6046ff] shadow-[0_0_12px_rgba(96,70,255,0.3)]' : 'bg-[#1c1f2e] group-hover:bg-[#6046ff]/20';
    const labelColor = isTop ? 'text-[#6046ff] font-bold' : 'text-slate-500';
    const tooltipVis = isTop ? 'opacity-100 font-bold bg-[#6046ff]' : 'opacity-0 group-hover:opacity-100 bg-[#292931]';
    return `
      <div class="flex-1 flex flex-col items-center group">
        <div class="w-full ${barBg} rounded-t-lg transition-all relative" style="height:${pct}%">
          <div class="absolute -top-8 left-1/2 -translate-x-1/2 ${tooltipVis} text-[10px] text-white px-2 py-1 rounded transition-opacity whitespace-nowrap">${v > 0 ? (v / 1000).toFixed(0) + 'k' : '0'}</div>
        </div>
        <span class="mt-4 text-[10px] font-mono ${labelColor}">${days[i]}</span>
      </div>`;
  }).join('');
}

function updateTimeline() {
  const line = document.getElementById('timeline-line');
  const area = document.getElementById('timeline-area');
  if (!line || !area) return;

  const max = Math.max(1, ...timelineBuckets);
  const pts = timelineBuckets.map((v, i) => {
    const x = (i / (timelineBuckets.length - 1)) * 400;
    const y = 200 - (v / max) * 180;
    return `${x},${y}`;
  });

  line.setAttribute('d', 'M' + pts.join(' L'));
  area.setAttribute('d', 'M' + pts.join(' L') + ' L400,200 L0,200 Z');
}

function updateTable() {
  if (!eventTableBody) return;

  // Group by session
  const bySession = {};
  for (const e of eventHistory) {
    const key = e.name || e.pid || 'unknown';
    if (!bySession[key]) bySession[key] = { name: key, count: 0, types: new Set() };
    bySession[key].count++;
    bySession[key].types.add(e.type);
  }

  const rows = Object.values(bySession);
  if (rows.length === 0) {
    eventTableBody.innerHTML = '<tr><td colspan="4" class="px-6 py-8 text-center text-slate-600 text-xs">No sessions recorded</td></tr>';
    return;
  }

  eventTableBody.innerHTML = rows.map(r => {
    const cost = (r.count * 0.003).toFixed(2);
    return `
      <tr class="hover:bg-[#1c1f2e] transition-colors">
        <td class="px-6 py-4 font-mono text-xs text-[#6046ff]">${esc(r.name)}</td>
        <td class="px-6 py-4 text-xs">${[...r.types].slice(0, 3).join(', ')}</td>
        <td class="px-6 py-4 text-xs">${r.count.toLocaleString()}</td>
        <td class="px-6 py-4 text-right font-mono text-xs">$${cost}</td>
      </tr>`;
  }).join('');
}


/* ══════════════════════════════════════════════════
   SSE Connection
   ══════════════════════════════════════════════════ */
function setConnected(ok) {
  if (statusPill) {
    statusPill.className = ok
      ? 'flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-xs font-bold'
      : 'flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500/10 text-red-400 text-xs font-bold';
    statusPill.innerHTML = ok
      ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>ACTIVE'
      : '<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>DISCONNECTED';
  }
}

function connect() {
  setConnected(false);
  const es = new EventSource('/api/stream');

  es.addEventListener('connected', () => setConnected(true));

  es.addEventListener('usage_update', (e) => {
    try { renderUsageTab(JSON.parse(e.data)); } catch (_) {}
  });

  es.addEventListener('init', e => {
    const { sessions: s, events: ev } = JSON.parse(e.data);
    sessions.clear();
    s.forEach(sess => sessions.set(sess.pid, sess));
    renderSessions();
    ev.forEach(ev => {
      trackEventType(ev);
      appendEvent(ev);
    });
  });

  es.addEventListener('session', e => {
    const s = JSON.parse(e.data);
    sessions.set(s.pid, s);
    if (s.status === 'ended') {
      setTimeout(() => { sessions.delete(s.pid); renderSessions(); }, 3000);
    }
    renderSessions();
  });

  es.addEventListener('event', e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'session_start' && !sessions.has(ev.pid)) {
      sessions.set(ev.pid, {
        pid: ev.pid, cwd: ev.cwd, name: ev.name, sid: ev.sid,
        status: 'idle', startedAt: ev.ts,
      });
      renderSessions();
    }
    trackEventType(ev);
    appendEvent(ev);
    // Refresh project panel on session lifecycle events
    if (['session_start', 'session_end'].includes(ev.type)) {
      setTimeout(loadProjects, 500);
      if (ev.type === 'session_end') setTimeout(loadBashCommands, 500);
    }
  });

  es.addEventListener('notification', e => {
    const n = JSON.parse(e.data);
    showToast(n.title || '알림', n.message || '');
  });

  es.onerror = () => {
    setConnected(false);
    es.close();
    setTimeout(connect, 3000);
  };
}

function trackEventType(ev) {
  if (ev.type in eventTypeCounts) eventTypeCounts[ev.type]++;
}

/* ══════════════════════════════════════════════════
   Notification Toasts
   ══════════════════════════════════════════════════ */
const toastContainer = document.getElementById('toast-container');

/* ── Browser Notification API ─────────────────── */
let browserNotiPermission = Notification?.permission || 'default';

function requestBrowserNotification() {
  if (!('Notification' in window)) return;
  if (browserNotiPermission === 'default') {
    Notification.requestPermission().then(p => { browserNotiPermission = p; });
  }
}
// Auto-request on first user gesture
document.addEventListener('click', () => requestBrowserNotification(), { once: true });

function sendBrowserNotification(title, message) {
  if (browserNotiPermission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(title, {
      body: message,
      icon: '/img/mascot-default.png',
      tag: 'claude-viz-' + Date.now(),
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  } catch (_) {}
}

function showToast(title, message, type = 'info') {
  // Also send browser notification when tab is hidden
  sendBrowserNotification(title, message);
  if (!toastContainer) return;

  const styles = {
    info:    { border: 'border-[#6046ff]/30', icon: 'notifications_active', iconColor: 'text-[#6046ff]', shadow: 'shadow-[0_8px_32px_rgba(96,70,255,0.15)]' },
    error:   { border: 'border-red-500/30',   icon: 'error',                iconColor: 'text-red-400',   shadow: 'shadow-[0_8px_32px_rgba(239,68,68,0.15)]'  },
    success: { border: 'border-emerald-500/30', icon: 'check_circle',       iconColor: 'text-emerald-400', shadow: 'shadow-[0_8px_32px_rgba(52,211,153,0.15)]' },
    warning: { border: 'border-amber-500/30', icon: 'warning',              iconColor: 'text-amber-400', shadow: 'shadow-[0_8px_32px_rgba(245,158,11,0.15)]' },
  };
  const s = styles[type] || styles.info;

  const toast = document.createElement('div');
  toast.className = `pointer-events-auto bg-[#13151f] border ${s.border} rounded-lg p-4 ${s.shadow} backdrop-blur-xl max-w-sm animate-slide-in`;
  toast.innerHTML = `
    <div class="flex items-start gap-3">
      <span class="material-symbols-outlined ${s.iconColor} text-lg flex-shrink-0 mt-0.5" style="font-variation-settings:'FILL' 1">${s.icon}</span>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-bold text-slate-200">${esc(title)}</div>
        <div class="text-[11px] text-slate-400 mt-0.5">${esc(message)}</div>
      </div>
    </div>`;
  toastContainer.appendChild(toast);
  const duration = type === 'error' ? 6000 : 5000;
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

connect();

/* ══════════════════════════════════════════════════
   Project Panel
   ══════════════════════════════════════════════════ */
const projectPanelBody = document.getElementById('project-panel-body');
const projectEmpty = document.getElementById('project-empty');

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ' + (sec % 60) + 's';
  const hr = Math.floor(min / 60);
  return hr + 'h ' + (min % 60) + 'm';
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

function toolIcon(name) {
  const icons = {
    Bash: 'terminal', Read: 'description', Write: 'edit_document',
    Edit: 'edit', Grep: 'search', Glob: 'folder_open',
    Agent: 'smart_toy', WebFetch: 'language', WebSearch: 'travel_explore',
  };
  return icons[name] || 'build';
}

function formatLastActivity(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return '방금 전';
  if (diff < 3600) return Math.floor(diff / 60) + '분 전';
  if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
  return Math.floor(diff / 86400) + '일 전';
}

/* ── Goal Timer Popup ─────────────────────────── */
function showGoalPopup(projectCwd, projectName, currentGoalMin) {
  // Remove any existing popup
  document.querySelector('.goal-popup')?.remove();

  const popup = document.createElement('div');
  popup.className = 'goal-popup fixed inset-0 z-[100] flex items-center justify-center';
  popup.style.background = 'rgba(0,0,0,0.5)';
  popup.innerHTML = `
    <div class="bg-[#0d0f18] border border-[#252838] rounded-lg p-4 w-[280px] shadow-2xl" onclick="event.stopPropagation()">
      <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-3">작업 타이머 설정</div>
      <div class="text-[10px] text-slate-400 mb-3">${esc(projectName)}</div>

      <!-- Pomodoro quick-start -->
      <div class="mb-3 pb-3 border-b border-[#252838]">
        <div class="text-[9px] text-slate-500 mb-2">포모도로</div>
        <div class="grid grid-cols-3 gap-1.5">
          <button class="pomo-btn py-1.5 rounded text-[10px] text-[#6046ff] bg-[#6046ff]/10 hover:bg-[#6046ff]/20 cursor-pointer transition-colors font-mono" data-work="25" data-rest="5">25/5</button>
          <button class="pomo-btn py-1.5 rounded text-[10px] text-[#6046ff] bg-[#6046ff]/10 hover:bg-[#6046ff]/20 cursor-pointer transition-colors font-mono" data-work="50" data-rest="10">50/10</button>
          <button class="pomo-btn py-1.5 rounded text-[10px] text-[#6046ff] bg-[#6046ff]/10 hover:bg-[#6046ff]/20 cursor-pointer transition-colors font-mono" data-work="90" data-rest="15">90/15</button>
        </div>
      </div>

      <!-- Custom timer -->
      <div class="text-[9px] text-slate-500 mb-2">커스텀</div>
      <div class="grid grid-cols-2 gap-2 mb-4">
        <div>
          <div class="text-[9px] text-slate-500 mb-1">시간</div>
          <input id="goal-hours" type="number" min="0" max="24" value="${Math.floor((currentGoalMin || 0) / 60)}"
            class="w-full bg-[#1c1f2e] border border-[#252838] rounded px-2 py-1.5 text-sm text-white font-mono text-center focus:border-[#6046ff] outline-none">
        </div>
        <div>
          <div class="text-[9px] text-slate-500 mb-1">분</div>
          <input id="goal-minutes" type="number" min="0" max="59" step="5" value="${(currentGoalMin || 0) % 60}"
            class="w-full bg-[#1c1f2e] border border-[#252838] rounded px-2 py-1.5 text-sm text-white font-mono text-center focus:border-[#6046ff] outline-none">
        </div>
      </div>
      <div class="flex gap-1.5">
        <button id="goal-cancel" class="flex-1 py-1.5 rounded text-[10px] text-slate-400 bg-[#1c1f2e] hover:bg-[#252838] cursor-pointer transition-colors">취소</button>
        ${currentGoalMin ? '<button id="goal-clear" class="py-1.5 px-2.5 rounded text-[10px] text-red-400 bg-[#1c1f2e] hover:bg-red-500/10 cursor-pointer transition-colors">초기화</button>' : ''}
        <button id="goal-save" class="flex-1 py-1.5 rounded text-[10px] text-white bg-[#6046ff] hover:bg-[#7056ff] cursor-pointer font-bold transition-colors">저장</button>
      </div>
    </div>
  `;

  popup.addEventListener('click', () => popup.remove());
  document.body.appendChild(popup);

  popup.querySelector('#goal-cancel').addEventListener('click', () => popup.remove());
  popup.querySelector('#goal-clear')?.addEventListener('click', () => {
    const goals = loadProjectGoals();
    delete goals[projectCwd];
    saveProjectGoals(goals);
    goalNotified.delete(projectCwd);
    popup.remove();
    if (cachedProjects) renderProjectPanel(cachedProjects);
  });
  popup.querySelector('#goal-save').addEventListener('click', () => {
    const h = parseInt(popup.querySelector('#goal-hours').value) || 0;
    const m = parseInt(popup.querySelector('#goal-minutes').value) || 0;
    const totalMin = h * 60 + m;
    const goals = loadProjectGoals();
    if (totalMin > 0) {
      // Keep existing setAt if just editing, otherwise start fresh
      const existing = goals[projectCwd];
      goals[projectCwd] = { goalMin: totalMin, setAt: existing?.setAt || Date.now() };
    } else {
      delete goals[projectCwd];
    }
    saveProjectGoals(goals);
    goalNotified.delete(projectCwd);
    popup.remove();
    if (cachedProjects) renderProjectPanel(cachedProjects);
  });

  // Pomodoro quick-start buttons
  popup.querySelectorAll('.pomo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const workMin = parseInt(btn.dataset.work);
      const restMin = parseInt(btn.dataset.rest);
      const goals = loadProjectGoals();
      goals[projectCwd] = { goalMin: workMin, setAt: Date.now(), pomodoro: { workMin, restMin, cycle: 1 } };
      saveProjectGoals(goals);
      goalNotified.delete(projectCwd);
      popup.remove();
      if (cachedProjects) renderProjectPanel(cachedProjects);
    });
  });

  // Focus on hours input
  setTimeout(() => popup.querySelector('#goal-hours')?.focus(), 100);
}

// Expose globally for inline onclick
window.showGoalPopup = showGoalPopup;
window._stopTimer = function(projectCwd) {
  const goals = loadProjectGoals();
  delete goals[projectCwd];
  saveProjectGoals(goals);
  goalNotified.delete(projectCwd);
  if (cachedProjects) renderProjectPanel(cachedProjects);
};

function buildGoalTimerHtml(projectCwd, projectName) {
  const goals = loadProjectGoals();
  const goal = goals[projectCwd];

  if (!goal) {
    return `
      <div class="mb-3">
        <div class="flex items-center justify-between mb-1.5">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider">작업 타이머</div>
          <button onclick="showGoalPopup('${esc(projectCwd)}', '${esc(projectName)}', 0)"
            class="text-[9px] text-slate-500 hover:text-[#6046ff] cursor-pointer transition-colors">설정</button>
        </div>
        <div class="bg-[#1c1f2e] rounded px-3 py-2 flex items-center justify-center cursor-pointer hover:border-[#6046ff]/30 border border-transparent transition-colors"
          onclick="showGoalPopup('${esc(projectCwd)}', '${esc(projectName)}', 0)">
          <span class="material-symbols-outlined text-[14px] text-slate-600 mr-1.5">timer</span>
          <span class="text-[10px] text-slate-500">작업 타이머를 설정해보세요</span>
        </div>
      </div>`;
  }

  const goalMs = goal.goalMin * 60 * 1000;
  const setAt = goal.setAt || Date.now();
  const elapsed = Date.now() - setAt;
  const pct = Math.min(100, (elapsed / goalMs) * 100);
  const isComplete = elapsed >= goalMs;
  const remaining = goalMs - elapsed;

  const isPomo = !!goal.pomodoro;
  const isResting = !!goal.isResting;
  const pomoCycle = goal.pomodoro?.cycle || 1;
  const accentColor = isResting ? '#22c55e' : '#6046ff';
  const phaseLabel = isResting ? '휴식 중' : '작업 중';
  const phaseIcon = isResting ? 'coffee' : 'timer';

  const goalLabel = goal.goalMin >= 60
    ? `${Math.floor(goal.goalMin / 60)}시간` + (goal.goalMin % 60 ? ` ${goal.goalMin % 60}분` : '')
    : `${goal.goalMin}분`;
  return `
    <div class="mb-3 goal-timer-live" data-goal-ms="${goalMs}" data-set-at="${setAt}" data-cwd="${esc(projectCwd)}" data-name="${esc(projectName)}" data-pomo="${isPomo ? '1' : ''}" data-resting="${isResting ? '1' : ''}">
      <div class="flex items-center justify-between mb-1.5">
        <div class="flex items-center gap-1.5">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider">${isPomo ? '포모도로' : '작업 타이머'}</div>
          ${isPomo ? `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full gt-phase-badge" style="background:${accentColor}20;color:${accentColor}">
            <span class="material-symbols-outlined text-[10px] align-middle">${phaseIcon}</span> ${phaseLabel} · ${pomoCycle}회차
          </span>` : ''}
        </div>
        <div class="flex items-center gap-2">
          <button onclick="window._stopTimer('${esc(projectCwd)}'); event.stopPropagation();"
            class="text-[9px] text-red-400 hover:text-red-300 cursor-pointer transition-colors">중지</button>
          <button onclick="showGoalPopup('${esc(projectCwd)}', '${esc(projectName)}', ${goal.goalMin})"
            class="text-[9px] text-slate-500 hover:text-[#6046ff] cursor-pointer transition-colors">수정</button>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-1.5 mb-1.5">
        <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
          <div class="text-[9px] text-slate-500">${isPomo ? phaseLabel : '목표'}</div>
          <div class="text-xs font-bold text-white font-mono">${goalLabel}</div>
        </div>
        <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
          <div class="text-[9px] text-slate-500">경과</div>
          <div class="text-xs font-bold font-mono gt-elapsed">${formatDuration(elapsed)}</div>
        </div>
        <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
          <div class="text-[9px] gt-remain-label">${isComplete ? '초과' : '남은 시간'}</div>
          <div class="text-xs font-bold font-mono gt-remain">${isComplete ? '+' + formatDuration(elapsed - goalMs) : formatDuration(remaining)}</div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex-1 h-1.5 bg-[#1c1f2e] rounded-full overflow-hidden">
          <div class="h-full rounded-full transition-all duration-1000 gt-bar" style="width:${pct}%;background:${accentColor}"></div>
        </div>
        <span class="text-[10px] font-bold font-mono gt-pct" style="color:${accentColor}">${Math.floor(pct)}%</span>
      </div>
    </div>`;
}

/* ── Lightweight timer tick (every second) ────── */
function tickTimers() {
  const timers = document.querySelectorAll('.goal-timer-live');
  for (const el of timers) {
    const goalMs = Number(el.dataset.goalMs);
    const setAt = Number(el.dataset.setAt);
    if (!goalMs || !setAt) continue;

    const elapsed = Date.now() - setAt;
    const pct = Math.min(100, (elapsed / goalMs) * 100);
    const isComplete = elapsed >= goalMs;

    const elapsedEl = el.querySelector('.gt-elapsed');
    const remainEl = el.querySelector('.gt-remain');
    const remainLbl = el.querySelector('.gt-remain-label');
    const barEl = el.querySelector('.gt-bar');
    const pctEl = el.querySelector('.gt-pct');

    if (elapsedEl) elapsedEl.textContent = formatDuration(elapsed);
    if (remainEl) remainEl.textContent = isComplete ? '+' + formatDuration(elapsed - goalMs) : formatDuration(goalMs - elapsed);
    if (remainLbl) {
      remainLbl.textContent = isComplete ? '초과' : '남은 시간';
      remainLbl.className = 'text-[9px] gt-remain-label ' + (isComplete ? 'text-emerald-500' : 'text-slate-500');
    }
    const isResting = el.dataset.resting === '1';
    const accent = isResting ? '#22c55e' : '#6046ff';

    if (barEl) {
      barEl.style.width = pct + '%';
      barEl.style.background = isComplete ? '#22c55e' : accent;
      barEl.className = 'h-full rounded-full transition-all duration-1000 gt-bar';
    }
    if (pctEl) { pctEl.textContent = Math.floor(pct) + '%'; pctEl.style.color = isComplete ? '#22c55e' : accent; }
    if (elapsedEl) elapsedEl.style.color = isComplete ? '#34d399' : accent;
    if (remainEl) remainEl.className = 'text-xs font-bold font-mono gt-remain ' + (isComplete ? 'text-emerald-400' : 'text-white');
    elapsedEl?.classList?.add('text-xs', 'font-bold', 'font-mono', 'gt-elapsed');
    pctEl?.classList?.add('text-[10px]', 'font-bold', 'font-mono', 'gt-pct');

    // Goal / Pomodoro notification
    if (isComplete && !goalNotified.has(el.dataset.cwd)) {
      goalNotified.add(el.dataset.cwd);
      const cwd = el.dataset.cwd;
      const goals = loadProjectGoals();
      const goal = goals[cwd];
      if (goal?.pomodoro) {
        const pomo = goal.pomodoro;
        const isWorkPhase = !goal.isResting;
        if (isWorkPhase) {
          showToast('휴식 시간!', `${el.dataset.name} — ${pomo.workMin}분 작업 완료! ${pomo.restMin}분 쉬세요`);
          // Switch to rest phase
          goal.goalMin = pomo.restMin;
          goal.setAt = Date.now();
          goal.isResting = true;
          saveProjectGoals(goals);
          setTimeout(() => { goalNotified.delete(cwd); if (cachedProjects) renderProjectPanel(cachedProjects); }, 500);
        } else {
          pomo.cycle = (pomo.cycle || 1) + 1;
          showToast('작업 시작!', `${el.dataset.name} — ${pomo.cycle}번째 포모도로 시작!`);
          // Switch back to work phase
          goal.goalMin = pomo.workMin;
          goal.setAt = Date.now();
          goal.isResting = false;
          saveProjectGoals(goals);
          setTimeout(() => { goalNotified.delete(cwd); if (cachedProjects) renderProjectPanel(cachedProjects); }, 500);
        }
      } else {
        showToast('타이머 완료!', `${el.dataset.name} 작업 타이머가 종료되었어요!`);
      }
    }
  }
}
setInterval(tickTimers, 1000);

function renderProjectPanel(projects) {
  if (!projectPanelBody) return;
  if (!projects || projects.length === 0) {
    if (projectEmpty) projectEmpty.style.display = '';
    return;
  }
  if (projectEmpty) projectEmpty.style.display = 'none';

  projectPanelBody.innerHTML = projects.map(proj => {
    // ── Active sessions for this project ──
    const activeSessions = [...sessions.values()].filter(s => s.cwd === proj.cwd && s.status !== 'ended');
    let activeIndicator = '';
    if (activeSessions.length > 0) {
      const elapsed = formatDuration(Date.now() - Math.min(...activeSessions.map(s => s.startedAt || Date.now())));
      activeIndicator = `<span class="flex items-center gap-1 text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded-full font-bold">
           <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>${activeSessions.length} 작업 중 · ${elapsed}
         </span>`;
    }

    // ── Last activity ──
    const lastLabel = activeSessions.length > 0 ? '' : formatLastActivity(proj.lastActivityTs);

    // ── Average session length ──
    const completedSessions = (proj.sessions || [])
      .map(s => ({ s, end: s.effectiveEndedAt || s.endedAt }))
      .filter(({ s, end }) => end && s.startedAt && end > s.startedAt);
    let avgSessionLen = 0;
    if (completedSessions.length > 0) {
      const totalLen = completedSessions.reduce((sum, { s, end }) => sum + (end - s.startedAt), 0);
      avgSessionLen = totalLen / completedSessions.length;
    }

    // ── Today's duration ──
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();
    let todayDuration = 0;
    for (const s of (proj.sessions || [])) {
      if ((s.startedAt || 0) >= todayTs) {
        const end = s.effectiveEndedAt || s.endedAt;
        if (end && end > s.startedAt) todayDuration += (end - s.startedAt);
      }
    }

    // ── Hourly activity heatmap (0-23) ──
    const hourly = proj.hourlyActivity || {};
    const maxHourly = Math.max(1, ...Object.values(hourly));
    const hourLabels = ['0', '', '', '3', '', '', '6', '', '', '9', '', '', '12', '', '', '15', '', '', '18', '', '', '21', '', ''];
    const heatmapCells = Array.from({ length: 24 }, (_, h) => {
      const count = hourly[String(h)] || 0;
      const intensity = count / maxHourly;
      let bg;
      if (count === 0)         bg = 'bg-[#1c1f2e]';
      else if (intensity < 0.25) bg = 'bg-[#6046ff]/20';
      else if (intensity < 0.5)  bg = 'bg-[#6046ff]/40';
      else if (intensity < 0.75) bg = 'bg-[#6046ff]/60';
      else                       bg = 'bg-[#6046ff]';
      return `<div class="flex flex-col items-center">
        <div class="w-3 h-3 rounded-sm ${bg}" title="${h}시: ${count}회"></div>
        ${hourLabels[h] ? `<span class="text-[7px] text-slate-600 mt-0.5">${hourLabels[h]}</span>` : ''}
      </div>`;
    }).join('');

    // ── Tool chart ──
    const toolEntries = Object.entries(proj.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxTool = toolEntries.length > 0 ? toolEntries[0][1] : 1;
    const toolBars = toolEntries.map(([name, count]) => {
      const pct = Math.max(8, (count / maxTool) * 100);
      return `
        <div class="flex items-center gap-2 text-[10px]">
          <span class="material-symbols-outlined text-[12px] text-slate-500">${toolIcon(name)}</span>
          <span class="w-14 text-slate-400 truncate">${esc(name)}</span>
          <div class="flex-1 h-1.5 bg-[#1c1f2e] rounded-full overflow-hidden">
            <div class="h-full bg-[#6046ff] rounded-full" style="width:${pct}%"></div>
          </div>
          <span class="w-8 text-right text-slate-500 font-mono">${count}</span>
        </div>`;
    }).join('');

    // ── Tasks ──
    const allTasks = proj.tasks || [];
    const archivedCount = proj.archivedTaskCount || 0;
    const activeTasks = allTasks.filter(t => t.status === 'in_progress');
    const pendingTasks = allTasks.filter(t => t.status === 'pending');
    const completedTasks = allTasks.filter(t => t.status === 'completed');
    const totalTasks = allTasks.length + archivedCount;
    const doneCount = completedTasks.length + archivedCount;

    function taskRow(t) {
      const icon = t.status === 'completed' ? 'check_circle' : t.status === 'in_progress' ? 'pending' : 'radio_button_unchecked';
      const color = t.status === 'completed' ? 'text-emerald-400' : t.status === 'in_progress' ? 'text-amber-400' : 'text-slate-500';
      const textColor = t.status === 'completed' ? 'text-slate-500 line-through' : 'text-slate-300';
      return `
        <div class="flex items-center gap-1.5 text-[10px] py-0.5">
          <span class="material-symbols-outlined text-[12px] ${color}">${icon}</span>
          <span class="${textColor} truncate flex-1">${esc(t.subject)}</span>
        </div>`;
    }

    const activeRows = activeTasks.map(taskRow).join('');
    const pendingRows = pendingTasks.map(taskRow).join('');
    const completedRows = completedTasks.map(taskRow).join('');

    // Progress bar
    const progressPct = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;
    const progressBarHtml = totalTasks > 0 ? `
      <div class="flex items-center gap-2 mb-1.5">
        <div class="flex-1 h-1.5 bg-[#1c1f2e] rounded-full overflow-hidden">
          <div class="h-full bg-emerald-500 rounded-full transition-all" style="width:${progressPct}%"></div>
        </div>
        <span class="text-[9px] font-mono ${progressPct === 100 ? 'text-emerald-400' : 'text-slate-400'}">${doneCount}/${totalTasks}</span>
      </div>` : '';

    // Collapsible completed section
    const completedSection = completedTasks.length > 0 ? `
      <div class="mt-1">
        <button onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.collapse-icon').classList.toggle('rotate-90')"
          class="flex items-center gap-1 text-[9px] text-slate-500 hover:text-slate-400 cursor-pointer transition-colors w-full">
          <span class="material-symbols-outlined text-[10px] collapse-icon rotate-90 transition-transform">chevron_right</span>
          완료 (${completedTasks.length}${archivedCount ? ` +${archivedCount} 아카이브` : ''})
        </button>
        <div class="hidden mt-0.5">${completedRows}</div>
      </div>` : (archivedCount > 0 ? `
      <div class="text-[9px] text-slate-600 mt-1">아카이브된 태스크 ${archivedCount}개</div>` : '');

    // ── Recent sessions ──
    const sessionRows = (proj.sessions || []).slice(0, 5).map(s => {
      const end = s.effectiveEndedAt || s.endedAt;
      const dur = end && s.startedAt ? formatDuration(end - s.startedAt) : (s.status !== 'ended' ? 'active' : '-');
      const statusDot = s.status === 'ended' ? 'bg-slate-500' : 'bg-emerald-500 animate-pulse';
      return `
        <div class="flex items-center gap-2 text-[10px] py-0.5">
          <span class="w-1.5 h-1.5 rounded-full ${statusDot} flex-shrink-0"></span>
          <span class="text-slate-400 flex-1 truncate">${esc(formatDate(s.startedAt))}</span>
          <span class="text-slate-500 font-mono">${dur}</span>
          <span class="text-slate-600 font-mono">${s.eventCount}ev</span>
        </div>`;
    }).join('');

    // ── Daily activity sparkline ──
    const dailyEntries = Object.entries(proj.dailyActivity || {}).sort().slice(-14);
    let sparkline = '';
    if (dailyEntries.length > 0) {
      const maxDay = Math.max(1, ...dailyEntries.map(e => e[1]));
      const bars = dailyEntries.map(([day, count]) => {
        const h = Math.max(2, (count / maxDay) * 24);
        const label = day.slice(5);
        return `<div class="flex flex-col items-center gap-0.5" title="${label}: ${count} events">
          <div class="w-2 bg-[#6046ff]/60 rounded-sm" style="height:${h}px"></div>
        </div>`;
      }).join('');
      sparkline = `
        <div class="mt-2">
          <div class="text-[9px] text-slate-600 mb-1">최근 활동</div>
          <div class="flex items-end gap-0.5 h-6">${bars}</div>
        </div>`;
    }

    return `
      <div class="bg-[#0d0f18] border border-[#252838] rounded-lg p-3 hover:border-[#6046ff]/30 transition-colors">
        <!-- Project header -->
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[16px] text-[#6046ff]">folder</span>
            <span class="text-xs font-bold text-slate-200 truncate">${esc(proj.name)}</span>
          </div>
          <div class="flex items-center gap-2">
            ${activeIndicator}
            ${lastLabel ? `<span class="text-[9px] text-slate-500">${lastLabel}</span>` : ''}
          </div>
        </div>

        <!-- Stats row -->
        <div class="grid grid-cols-4 gap-1.5 mb-3">
          <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
            <div class="text-[9px] text-slate-500">세션</div>
            <div class="text-sm font-bold text-white font-mono">${proj.totalSessions}</div>
          </div>
          <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
            <div class="text-[9px] text-slate-500">총 시간</div>
            <div class="text-sm font-bold text-white font-mono">${formatDuration(proj.totalDuration)}</div>
          </div>
          <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
            <div class="text-[9px] text-slate-500">평균 세션</div>
            <div class="text-sm font-bold text-white font-mono">${formatDuration(avgSessionLen)}</div>
          </div>
          <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
            <div class="text-[9px] text-emerald-500">오늘</div>
            <div class="text-sm font-bold text-emerald-400 font-mono">${formatDuration(todayDuration)}</div>
          </div>
        </div>

        <!-- Goal Timer -->
        ${buildGoalTimerHtml(proj.cwd, proj.name)}

        <!-- Hourly heatmap -->
        <div class="mb-3">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-1.5">시간대별 활동</div>
          <div class="flex items-start gap-[3px]">${heatmapCells}</div>
        </div>

        <!-- Tool usage -->
        ${toolBars ? `
        <div class="mb-3">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-1.5">도구 사용</div>
          <div class="space-y-1">${toolBars}</div>
        </div>` : ''}

        <!-- Tasks -->
        ${allTasks.length > 0 || archivedCount > 0 ? `
        <div class="mb-2">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-1">작업 목록</div>
          ${progressBarHtml}
          ${activeRows}
          ${pendingRows}
          ${completedSection}
        </div>` : ''}

        <!-- Daily sparkline -->
        ${sparkline}

        <!-- Recent sessions -->
        ${sessionRows ? `
        <div class="mt-2 pt-2 border-t border-[#252838]/50">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-1">최근 세션</div>
          ${sessionRows}
        </div>` : ''}
      </div>`;
  }).join('');
}

let cachedProjects = null;

function loadProjects() {
  fetch('/api/projects')
    .then(r => r.json())
    .then(data => { cachedProjects = data; renderProjectPanel(data); })
    .catch(() => {});
}

// Load projects on startup and refresh periodically
loadProjects();
setInterval(loadProjects, 30000);

// Re-render every minute to update elapsed times (timers tick via tickTimers separately)
setInterval(() => { if (cachedProjects) renderProjectPanel(cachedProjects); }, 60000);

// Refresh button + collapse toggle
document.getElementById('btn-project-refresh')?.addEventListener('click', loadProjects);
const projectToggleIcon = document.getElementById('project-toggle-icon');
document.getElementById('btn-project-toggle')?.addEventListener('click', () => {
  if (!projectPanelBody) return;
  const collapsed = projectPanelBody.style.display === 'none';
  projectPanelBody.style.display = collapsed ? '' : 'none';
  if (projectToggleIcon) projectToggleIcon.textContent = collapsed ? 'expand_less' : 'expand_more';
});

/* ══════════════════════════════════════════════════
   Bash Commands Tab
   ══════════════════════════════════════════════════ */
const categoryLabels = {
  git: { label: 'Git', color: 'bg-orange-500/20 text-orange-400' },
  package: { label: 'Package', color: 'bg-emerald-500/20 text-emerald-400' },
  runtime: { label: 'Runtime', color: 'bg-blue-500/20 text-blue-400' },
  infra: { label: 'Infra', color: 'bg-purple-500/20 text-purple-400' },
  shell: { label: 'Shell', color: 'bg-slate-500/20 text-slate-400' },
  build: { label: 'Build', color: 'bg-amber-500/20 text-amber-400' },
  test: { label: 'Test', color: 'bg-cyan-500/20 text-cyan-400' },
  lint: { label: 'Lint', color: 'bg-pink-500/20 text-pink-400' },
  other: { label: 'Other', color: 'bg-slate-500/20 text-slate-500' },
};

// Parse a bash command into colored tokens. Flag tokens get a title= tooltip
// with a Korean description when one is registered in bash-flags.js.
function parseBashTokens(raw) {
  // Take first line only
  const cmd = raw.split('\n')[0].trim();
  // Tokenize respecting quotes
  const tokens = [];
  let current = '';
  let inQuote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (!inQuote && (ch === '"' || ch === "'")) { inQuote = ch; current += ch; }
    else if (ch === inQuote) { inQuote = null; current += ch; }
    else if (!inQuote && ch === ' ') {
      if (current) { tokens.push(current); current = ''; }
    } else { current += ch; }
  }
  if (current) tokens.push(current);
  if (tokens.length === 0) return esc(cmd);

  const cmdName = tokens[0];
  const hasSubcmd = tokens.length > 1
    && /^(git|npm|npx|yarn|pnpm|docker|kubectl|cargo|go)$/.test(cmdName)
    && !tokens[1].startsWith('-');
  const subcmd = hasSubcmd ? tokens[1] : null;

  const flagTip = (flag) => {
    try {
      const desc = window.lookupFlag ? window.lookupFlag(cmdName, subcmd, flag) : null;
      return desc ? ` title="${esc(flag + ' — ' + desc)}"` : '';
    } catch (_) { return ''; }
  };

  return tokens.map((tok, i) => {
    const e = esc(tok);
    if (i === 0) return `<span class="text-emerald-400 font-bold">${e}</span>`;
    if (i === 1 && hasSubcmd) return `<span class="text-amber-400">${e}</span>`;
    if (tok.startsWith('--'))
      return `<span class="text-sky-400 bash-flag"${flagTip(tok)}>${e}</span>`;
    if (/^-[a-zA-Z]/.test(tok))
      return `<span class="text-sky-300 bash-flag"${flagTip(tok)}>${e}</span>`;
    if (/^[|><&;]+$/.test(tok) || tok === '&&' || tok === '||')
      return `<span class="text-pink-400 font-bold">${e}</span>`;
    if (tok.includes('/'))
      return `<span class="text-violet-400">${e}</span>`;
    if (tok.includes('*') || tok.includes('?'))
      return `<span class="text-violet-300">${e}</span>`;
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'")))
      return `<span class="text-yellow-300">${e}</span>`;
    return `<span class="text-slate-300">${e}</span>`;
  }).join(' ');
}

// Cache for filter re-renders
let bashData = null;
let bashFilter = { category: localStorage.getItem('bashFilterCategory') || null };

function setBashFilter(cat) {
  bashFilter.category = cat;
  if (cat) localStorage.setItem('bashFilterCategory', cat);
  else localStorage.removeItem('bashFilterCategory');
  if (bashData) renderBashPanel(bashData);
}

function firstToken(cmd) {
  const m = (cmd || '').trim().match(/^(\S+)/);
  return m ? m[1] : '';
}

function renderBashPanel(data) {
  if (data) bashData = data;
  if (!bashData) return;
  const { recent, topCommands, categoryCounts, total } = bashData;

  const totalEl = document.getElementById('bash-total');
  if (totalEl) totalEl.textContent = total.toLocaleString();

  // Categories — compact clickable pills
  const catEl = document.getElementById('bash-categories');
  if (catEl) {
    const catEntries = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
    const active = bashFilter.category;
    const all = `<span class="bash-cat-pill ${active ? 'is-muted' : 'is-active'} bg-slate-500/20 text-slate-300 px-2 py-0.5 rounded text-[9px] font-bold" data-cat="">전체 ${total}</span>`;
    const pills = catEntries.map(([cat, count]) => {
      const info = categoryLabels[cat] || categoryLabels.other;
      const state = active ? (active === cat ? 'is-active' : 'is-muted') : '';
      return `<span class="bash-cat-pill ${state} ${info.color} px-2 py-0.5 rounded text-[9px] font-bold" data-cat="${esc(cat)}">${info.label} ${count}</span>`;
    }).join('');
    catEl.innerHTML = all + pills;
    catEl.querySelectorAll('.bash-cat-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const c = pill.getAttribute('data-cat') || null;
        setBashFilter(c === bashFilter.category ? null : c);
      });
    });
  }

  const matchesFilter = (c) => !bashFilter.category || c.category === bashFilter.category;

  const exampleTitle = (cmd, examples) => {
    const lines = [cmd];
    if (examples && examples.length > 0) {
      lines.push('', '실제 사용 예시:');
      for (const ex of examples) lines.push('• ' + ex);
    }
    return esc(lines.join('\n'));
  };

  const newBadge = (isNew) => isNew ? `<span class="bash-new-badge" title="최근 7일 내 첫 등장">NEW</span>` : '';

  // Top commands (filtered)
  const topEl = document.getElementById('bash-top-commands');
  if (topEl) {
    const filtered = topCommands.filter(matchesFilter).slice(0, 10);
    if (filtered.length === 0) {
      topEl.innerHTML = `<div class="px-4 py-4 text-center text-slate-600 text-[10px]">일치하는 명령어가 없습니다</div>`;
    } else {
      const maxCount = filtered[0]?.count || 1;
      topEl.innerHTML = filtered.map(c => {
        const pct = Math.max(5, (c.count / maxCount) * 100);
        const hasExamples = c.examples && c.examples.length > 0;
        return `
          <div class="bash-cmd-row px-3 py-2 border-b border-[#252838]/20 hover:bg-[#1c1f2e] transition-colors" data-cmd="${esc(c.command)}" title="${exampleTitle(c.command, c.examples)}">
            <div class="flex items-center gap-2 text-[10px]">
              <code class="font-mono truncate flex-1 bash-cmd-name">${parseBashTokens(c.command)}</code>
              ${newBadge(c.isNew)}
              ${hasExamples ? `<span class="material-symbols-outlined text-[12px] text-slate-600 flex-shrink-0" title="파이프라인 예시 ${c.examples.length}개">menu_book</span>` : ''}
              <span class="text-[#6046ff] font-mono font-bold flex-shrink-0">${c.count}x</span>
            </div>
            <div class="flex items-center gap-2 mt-0.5">
              <div class="flex-1 h-1 bg-[#1c1f2e] rounded-full overflow-hidden">
                <div class="h-full bg-emerald-500/50 rounded-full" style="width:${pct}%"></div>
              </div>
              <span class="text-[8px] text-slate-600">${c.projects.join(', ')}</span>
            </div>
          </div>`;
      }).join('');
      topEl.querySelectorAll('.bash-cmd-row').forEach(row => {
        row.addEventListener('click', () => {
          showBashPopover(row.getAttribute('data-cmd'));
        });
      });
    }
  }

  // Recent commands (filtered)
  const recentEl = document.getElementById('bash-recent');
  if (recentEl) {
    const filtered = recent.filter(matchesFilter).slice(0, 20);
    if (filtered.length === 0) {
      recentEl.innerHTML = `<div class="px-4 py-4 text-center text-slate-600 text-[10px]">일치하는 기록이 없습니다</div>`;
    } else {
      recentEl.innerHTML = filtered.map(c => {
        const time = new Date(c.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        const examples = c.original ? [c.original] : [];
        const popKey = c.normalized || c.command;
        return `
          <div class="bash-cmd-row px-3 py-2 border-b border-[#252838]/20 hover:bg-[#1c1f2e] transition-colors" data-cmd="${esc(popKey)}" title="${exampleTitle(c.command, examples)}">
            <div class="flex items-center gap-2 text-[10px] mb-0.5">
              <span class="text-slate-600 font-mono flex-shrink-0">${time}</span>
              <span class="text-[#6046ff] text-[9px] flex-shrink-0">${esc(c.project)}</span>
              ${newBadge(c.isNew)}
              ${c.original ? `<span class="material-symbols-outlined text-[11px] text-slate-600 flex-shrink-0" title="파이프라인의 일부">alt_route</span>` : ''}
            </div>
            <code class="block font-mono text-[10px] truncate bash-cmd-name">${parseBashTokens(c.command)}</code>
          </div>`;
      }).join('');
      recentEl.querySelectorAll('.bash-cmd-row').forEach(row => {
        row.addEventListener('click', () => {
          showBashPopover(row.getAttribute('data-cmd'));
        });
      });
    }
  }
}

function loadBashCommands() {
  fetch('/api/bash-commands')
    .then(r => r.json())
    .then(renderBashPanel)
    .catch(() => {});
}

// Bash panel collapse toggle
const bashPanelBody = document.getElementById('bash-panel-body');
const bashToggleIcon = document.getElementById('bash-toggle-icon');
document.getElementById('btn-bash-toggle')?.addEventListener('click', () => {
  if (!bashPanelBody) return;
  const collapsed = bashPanelBody.style.display === 'none';
  bashPanelBody.style.display = collapsed ? '' : 'none';
  if (bashToggleIcon) bashToggleIcon.textContent = collapsed ? 'expand_less' : 'expand_more';
});

document.getElementById('btn-bash-refresh')?.addEventListener('click', loadBashCommands);

// Load on startup
loadBashCommands();
setInterval(loadBashCommands, 30000);

/* ══════════════════════════════════════════════════
   Bash command popover — tldr + co-occurrence
   ══════════════════════════════════════════════════ */
function parseTldr(md) {
  const lines = md.split('\n');
  let title = '';
  let summary = '';
  const examples = [];
  let currentDesc = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ')) { title = line.slice(2).trim(); continue; }
    if (line.startsWith('> ')) {
      const body = line.slice(2).trim();
      if (/^more info[:：]/i.test(body)) continue;
      summary = summary ? summary + ' ' + body : body;
      continue;
    }
    if (line.startsWith('- ')) {
      currentDesc = line.slice(2).replace(/:$/, '').trim();
      continue;
    }
    if (line.startsWith('`') && line.endsWith('`') && currentDesc) {
      const code = line.slice(1, -1).replace(/\{\{([^}]+)\}\}/g, '<$1>');
      examples.push({ desc: currentDesc, code });
      currentDesc = null;
    }
  }
  return { title, summary, examples };
}

async function fetchTldr(cmd) {
  const key = 'tldr:' + cmd;
  const cached = localStorage.getItem(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      // Refresh in background if older than 7 days
      if (parsed.fetchedAt && Date.now() - parsed.fetchedAt < 7 * 24 * 3600 * 1000) return parsed;
    } catch (_) {}
  }
  const platforms = ['common', 'linux', 'osx'];
  for (const p of platforms) {
    try {
      const url = `https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/${p}/${encodeURIComponent(cmd)}.md`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const md = await r.text();
      const parsed = parseTldr(md);
      const result = { ok: true, platform: p, fetchedAt: Date.now(), ...parsed };
      try { localStorage.setItem(key, JSON.stringify(result)); } catch (_) {}
      return result;
    } catch (_) { /* try next platform */ }
  }
  const result = { ok: false, fetchedAt: Date.now() };
  try { localStorage.setItem(key, JSON.stringify(result)); } catch (_) {}
  return result;
}

function showBashPopover(cmd) {
  if (!cmd) return;
  const el = document.getElementById('bash-popover');
  const titleEl = document.getElementById('bash-popover-title');
  const bodyEl = document.getElementById('bash-popover-body');
  if (!el || !titleEl || !bodyEl) return;

  titleEl.textContent = cmd;
  el.classList.add('is-open');

  const cmdName = firstToken(cmd);
  const top = (bashData && bashData.topCommands) || [];
  const match = top.find(t => t.command === cmd);
  const coOccur = match?.coOccurrences || [];
  const examples = match?.examples || [];
  const topFlags = match?.topFlags || [];
  const topArgs = match?.topArgs || [];
  // Use subcommand for flag lookup if the key is "cmd sub"
  const parts = cmd.split(/\s+/);
  const subForLookup = parts.length > 1 ? parts[1] : null;

  const exSection = examples.length > 0 ? `
    <div>
      <div class="bash-popover-section-title">
        <span class="material-symbols-outlined text-[14px]">alt_route</span>
        내가 쓴 파이프라인 예시
      </div>
      <div class="space-y-1">
        ${examples.map(ex => `<div class="bash-tldr-example"><code>${parseBashTokens(ex)}</code></div>`).join('')}
      </div>
    </div>` : '';

  const flagsSection = topFlags.length > 0 ? `
    <div>
      <div class="bash-popover-section-title">
        <span class="material-symbols-outlined text-[14px]">flag</span>
        자주 쓴 플래그
      </div>
      <div class="space-y-1">
        ${topFlags.map(f => {
          let desc = null;
          try { desc = window.lookupFlag ? window.lookupFlag(cmdName, subForLookup, f.flag) : null; } catch (_) {}
          return `
            <div class="flex items-center gap-2 text-[11px] py-1 border-b border-[#252838]/20">
              <code class="font-mono text-sky-400 font-bold flex-shrink-0 w-14">${esc(f.flag)}</code>
              <span class="flex-1 text-slate-400 truncate">${desc ? esc(desc) : '<span class="text-slate-600 italic">설명 없음</span>'}</span>
              <span class="text-[#6046ff] font-mono font-bold flex-shrink-0">${f.count}x</span>
            </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const argsSection = topArgs.length > 0 ? `
    <div>
      <div class="bash-popover-section-title">
        <span class="material-symbols-outlined text-[14px]">data_object</span>
        자주 쓴 인자
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${topArgs.map(a => `<span class="bash-cooccur-chip" style="background:rgba(139,92,246,0.1);border-color:rgba(139,92,246,0.3);color:#c4b5fd;">${esc(a.arg)} <span class="count">×${a.count}</span></span>`).join('')}
      </div>
    </div>` : '';

  const coSection = `
    <div>
      <div class="bash-popover-section-title">
        <span class="material-symbols-outlined text-[14px]">hub</span>
        자주 함께 쓴 명령어
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${coOccur.length === 0
          ? '<span class="text-[10px] text-slate-600">파이프라인에서 함께 쓰인 기록이 없습니다</span>'
          : coOccur.map(c => `<span class="bash-cooccur-chip" data-co="${esc(c.cmd)}">${esc(c.cmd)} <span class="count">×${c.count}</span></span>`).join('')}
      </div>
    </div>`;

  const tldrSection = `
    <div>
      <div class="bash-popover-section-title">
        <span class="material-symbols-outlined text-[14px]">menu_book</span>
        <span>tldr: ${esc(cmdName)}</span>
        <span class="text-[9px] font-normal text-slate-600" id="bash-popover-tldr-src">로드 중…</span>
      </div>
      <div id="bash-popover-tldr"><div class="text-[10px] text-slate-600">불러오는 중…</div></div>
    </div>`;

  bodyEl.innerHTML = flagsSection + argsSection + exSection + coSection + tldrSection;

  // Clicking a co-occurrence chip opens that command's popover (if present in top data)
  bodyEl.querySelectorAll('.bash-cooccur-chip[data-co]').forEach(chip => {
    chip.addEventListener('click', () => {
      const name = chip.getAttribute('data-co');
      if (!name) return;
      const found = top.find(t => t.command === name) || top.find(t => firstToken(t.command) === name);
      showBashPopover(found ? found.command : name);
    });
  });

  // Fetch tldr asynchronously
  fetchTldr(cmdName).then(result => {
    if (titleEl.textContent !== cmd) return; // popover changed
    const tldrEl = document.getElementById('bash-popover-tldr');
    const srcEl = document.getElementById('bash-popover-tldr-src');
    if (!tldrEl) return;
    if (!result.ok) {
      tldrEl.innerHTML = `<div class="text-[10px] text-slate-600">tldr 페이지를 찾을 수 없습니다. 터미널에서 <code class="text-slate-400">man ${esc(cmdName)}</code> 를 확인해보세요.</div>`;
      if (srcEl) srcEl.textContent = '';
      return;
    }
    if (srcEl) srcEl.textContent = `tldr-pages / ${result.platform}`;
    const summary = result.summary ? `<div class="text-[11px] text-slate-300 mb-3 leading-relaxed">${esc(result.summary)}</div>` : '';
    const ex = (result.examples || []).map(x => `
      <div class="bash-tldr-example">
        <div class="bash-tldr-desc">${esc(x.desc)}</div>
        <code>${esc(x.code)}</code>
      </div>`).join('');
    tldrEl.innerHTML = summary + (ex || '<div class="text-[10px] text-slate-600">예시가 없습니다</div>');
  });
}

document.getElementById('btn-bash-popover-close')?.addEventListener('click', () => {
  document.getElementById('bash-popover')?.classList.remove('is-open');
});
document.getElementById('bash-popover')?.addEventListener('click', (e) => {
  if (e.target.id === 'bash-popover') e.target.classList.remove('is-open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.getElementById('bash-popover')?.classList.remove('is-open');
});

/* ══════════════════════════════════════════════════
   Tab data loading on switch
   ══════════════════════════════════════════════════ */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    void tab; // placeholder for future tab-specific loading
  });
});

/* ══════════════════════════════════════════════════
   Zoom & Fullscreen
   ══════════════════════════════════════════════════ */
let zoomScale = 1;
const zoomLevelEl = document.getElementById('zoom-level');
const mascotContainerEl = document.getElementById('mascot-container');

function applyZoom() {
  if (mascotContainerEl) {
    mascotContainerEl.style.transform = `scale(${zoomScale})`;
    mascotContainerEl.style.transformOrigin = 'center center';
  }
  if (zoomLevelEl) zoomLevelEl.textContent = Math.round(zoomScale * 100) + '%';
}

document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
  zoomScale = Math.min(2, zoomScale + 0.1);
  applyZoom();
});

document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
  zoomScale = Math.max(0.3, zoomScale - 0.1);
  applyZoom();
});

// Fullscreen
const workspaceEl = document.getElementById('view-workspace');
const fullscreenIcon = document.getElementById('fullscreen-icon');
const fullscreenLabel = document.getElementById('fullscreen-label');

document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    (workspaceEl || document.documentElement).requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  if (fullscreenIcon) fullscreenIcon.textContent = isFs ? 'fullscreen_exit' : 'fullscreen';
  if (fullscreenLabel) fullscreenLabel.textContent = isFs ? '원래 크기' : '전체 보기';
});

/* ══════════════════════════════════════════════════
   Floating Mascots (one per session)
   ══════════════════════════════════════════════════ */
const mascotContainer = document.getElementById('mascot-container');
const canvas = document.getElementById('view-workspace');
const activeMascots = new Map(); // pid -> { el, interval, imgInterval, lastStatus, lastTool, mood, ... }

// Per-session last tool event tracking
const sessionLastTool = new Map(); // pid -> { toolName, toolDetail, ts }
const sessionPermPending = new Map(); // pid -> { toolName, toolDetail, ts }
const sessionCurrentTask = new Map(); // pid -> { subject } — currently in-progress task
const sessionTaskList = new Map(); // pid -> [{subject, status}] — all tasks for this session
const sessionCompacting = new Set(); // pid set — sessions currently compacting
const sessionStopMessage = new Map(); // pid -> { quote, excited, ts } — persistent completion message

/** Returns true if this session has a high-priority bubble (permission/compaction/completion) that must not be overridden. */
function hasPriorityBubble(pid) {
  return sessionPermPending.has(pid) || sessionCompacting.has(pid) || sessionStopMessage.has(pid);
}

/* ── Emotion / Mood System ───────────────────── */
// Mood: 'happy' | 'normal' | 'tired' | 'excited'
// Based on: session duration, task completions, idle time
const moodQuotes = {
  tired:   ['피곤해...잠깐 쉬자', '눈이 뻑뻑해..', '으으 얼마나 더..?', '커피 한 잔만...', '좀 쉬어도 돼?', '졸리다 zzZ'],
  excited: ['우와 해냈다!', '완료! 기분 최고~', '역시 나란 매숑이!', '한 건 했다!', '이 맛에 코딩하지!', 'LGTM~!'],
  happy:   ['기분 좋은 날~', '오늘 컨디션 최고!', '코딩이 술술 풀려~', '오예~ 순조롭다', '이 흐름 계속 가자!'],
};

function getMascotMood(pid) {
  const s = sessions.get(pid);
  if (!s) return 'normal';
  const elapsed = Date.now() - (s.startedAt || Date.now());
  const hours = elapsed / (1000 * 60 * 60);
  if (hours > 3) return 'tired';
  if (hours > 1.5) return 'tired';
  return 'normal';
}

function getMoodEmoji(mood) {
  return { tired: '😴', excited: '🎉', happy: '😊', normal: '' }[mood] || '';
}

function getMoodFilter(mood) {
  switch (mood) {
    case 'tired':   return 'saturate(0.6) brightness(0.85)';
    case 'excited': return 'saturate(1.4) brightness(1.15)';
    case 'happy':   return 'saturate(1.2) brightness(1.05)';
    default:        return '';
  }
}

// Trigger excited mood on task completion — persistent like permission/compaction
function triggerExcitedMood(pid) {
  const m = activeMascots.get(pid);
  if (!m) return;
  m.mood = 'excited';
  m.moodUntil = Date.now() + 15000;
  applyMood(m);
  if (sessionPermPending.has(pid) || sessionCompacting.has(pid)) return; // don't override permission/compaction bubble
  const q = moodQuotes.excited[Math.floor(Math.random() * moodQuotes.excited.length)];
  sessionStopMessage.set(pid, { quote: q, excited: true, ts: Date.now() });
  updateBubble(m, sessions.get(pid)?.status || 'idle');
}

function applyMood(m) {
  const img = m.el.querySelector('.mascot-img');
  if (!img) return;
  const mood = m.mood || 'normal';
  const filter = getMoodFilter(mood);
  img.style.filter = filter || '';
  // Emoji overlay
  let emojiEl = m.el.querySelector('.mascot-mood-emoji');
  const emoji = getMoodEmoji(mood);
  if (emoji) {
    if (!emojiEl) {
      emojiEl = document.createElement('span');
      emojiEl.className = 'mascot-mood-emoji';
      emojiEl.style.cssText = 'position:absolute;top:-2px;right:-2px;font-size:16px;z-index:7;pointer-events:none;';
      m.el.appendChild(emojiEl);
    }
    emojiEl.textContent = emoji;
  } else if (emojiEl) {
    emojiEl.remove();
  }
}

/* ── Mascot Interaction System ───────────────── */
const interactionQuotes = [
  ['오 안녕!', '반가워~!'],
  ['뭐 하고 있어?', '코딩 중~'],
  ['버그 찾았어?', '아직...ㅠ'],
  ['같이 하자!', '좋아!'],
  ['힘내!', '고마워~'],
  ['커피 마실래?', '좋지!'],
  ['PR 올렸어?', '지금 올릴 거야!'],
  ['점심 같이 먹자', '뭐 먹을까?'],
];

function checkMascotInteractions() {
  const mascots = [...activeMascots.values()];
  if (mascots.length < 2) return;

  for (let i = 0; i < mascots.length; i++) {
    for (let j = i + 1; j < mascots.length; j++) {
      const a = mascots[i], b = mascots[j];
      // Skip if either is in a non-idle interaction state
      if (a.interactingUntil > Date.now() || b.interactingUntil > Date.now()) continue;

      const ax = parseFloat(a.el.style.left) || 0;
      const ay = parseFloat(a.el.style.top) || 0;
      const bx = parseFloat(b.el.style.left) || 0;
      const by = parseFloat(b.el.style.top) || 0;
      const dist = Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);

      if (dist < 150) { // Close enough to interact
        // Skip if either has a priority bubble
        if (hasPriorityBubble(a.pid) || hasPriorityBubble(b.pid)) continue;

        const pair = interactionQuotes[Math.floor(Math.random() * interactionQuotes.length)];
        const now = Date.now();
        a.interactingUntil = now + 12000;
        b.interactingUntil = now + 12000;

        const bubbleA = a.el.querySelector('.mascot-bubble');
        const bubbleB = b.el.querySelector('.mascot-bubble');
        if (bubbleA && !a.idleBubbleActive) {
          bubbleA.textContent = pair[0];
          bubbleA.classList.add('visible');
          a.idleBubbleActive = true;
          setTimeout(() => { if (!hasPriorityBubble(a.pid)) { a.idleBubbleActive = false; bubbleA.classList.remove('visible'); } }, 8000);
        }
        if (bubbleB && !b.idleBubbleActive) {
          setTimeout(() => {
            if (hasPriorityBubble(b.pid)) return;
            bubbleB.textContent = pair[1];
            bubbleB.classList.add('visible');
            b.idleBubbleActive = true;
            setTimeout(() => { if (!hasPriorityBubble(b.pid)) { b.idleBubbleActive = false; bubbleB.classList.remove('visible'); } }, 8000);
          }, 1500);
        }
      }
    }
  }
}

// Check interactions every 5 seconds
setInterval(checkMascotInteractions, 5000);

const idleQuotes = [
  '코드 냄새가 나는데...?',
  '버그 어디 숨었어~',
  '리팩토링하고 싶다...',
  '커밋 메시지 뭐라 쓰지',
  '테스트 다 통과했으면...',
  'npm install 중...',
  '빌드 기다리는 중 zzZ',
  '오늘도 열코 화이팅!',
  'git push 해도 될까?',
  '타입 에러가 왜 나지...',
  '이 코드 누가 짠 거야',
  '주석 좀 달아둘걸...',
  'PR 리뷰 부탁해요~',
  '점심 뭐 먹지?',
  'console.log 지워야지',
  'TODO 가 점점 늘어나...',
  '이거 금방 끝나겠지?',
  'deploy 하면 안 되겠지?',
  '오 이거 깔끔한데',
  'LGTM!',
  'hotfix 또...?',
  '.env 커밋하면 안 돼!',
  '문서화는 나중에...',
  '왜 로컬에서만 돼?',
  'staging 먼저 해봐야지',
  '어라 여기 오타 있네',
  '이건 기술부채다...',
  'merge conflict ㅠㅠ',
  '다크모드 최고!',
  '오 벌써 이 시간?',
];

function getWanderInterval(status) {
  switch (status) {
    case 'running':  return 2000 + Math.random() * 1500;  // fast
    case 'thinking': return 8000 + Math.random() * 4000;  // slow
    default:         return 4000 + Math.random() * 3000;  // normal
  }
}

function toolBubbleHtml(lastTool) {
  const icon = { Bash: 'terminal', Read: 'description', Write: 'edit_document', Edit: 'edit', Grep: 'search', Glob: 'folder_open', Agent: 'smart_toy', TaskCreate: 'checklist', TaskUpdate: 'task_alt', ToolSearch: 'manage_search' }[lastTool.toolName] || 'build';
  const fileName = lastTool.toolDetail ? lastTool.toolDetail.split('/').pop().slice(0, 25) : '';
  const detail = lastTool.toolDetail || '';
  const taskSubject = detail.slice(0, 20);
  const msg = {
    Read:       fileName ? `${fileName} 읽는 중~` : '파일 읽는 중~',
    Edit:       fileName ? `${fileName} 고치는 중!` : '코드 수정 중!',
    Write:      fileName ? `${fileName} 쓰는 중~` : '파일 만드는 중~',
    Bash:       '명령어 실행 중..뿅!',
    Grep:       '코드 찾는 중~ 어디있니?',
    Glob:       '파일 찾는 중~',
    Agent:      '친구한테 부탁하는 중~',
    TaskCreate: taskSubject ? `"${taskSubject}" 추가!` : '할 일 정리하는 중!',
    TaskUpdate: detail ? `${detail} 완료!` : '할 일 체크! ✓',
    ToolSearch: taskSubject ? `${taskSubject} 찾는 중~` : '도구 찾는 중~',
  }[lastTool.toolName] || `${lastTool.toolName} 쓰는 중~`;
  return `<span class="material-symbols-outlined text-[10px] align-middle">${icon}</span> ${esc(msg)}`;
}

function updateBubble(mascotData, status) {
  const bubble = mascotData.el.querySelector('.mascot-bubble');
  if (!bubble) return;

  const pid = mascotData.pid;
  const perm = sessionPermPending.get(pid);
  const lastTool = sessionLastTool.get(pid);

  // Permission request — highest priority, stays until resolved
  if (perm) {
    const toolLabel = perm.toolName || '도구';
    bubble.innerHTML = `<span class="animate-pulse" style="color:#fb923c">
      <span class="material-symbols-outlined text-[10px] align-middle">front_hand</span>
      승인 대기 중! (${esc(toolLabel)})
    </span>`;
    bubble.classList.add('visible');
    bubble.style.borderColor = 'rgba(251,146,60,0.5)';
    mascotData.idleBubbleActive = false;
    return;
  }

  // Compaction — high priority indicator
  if (sessionCompacting.has(pid)) {
    bubble.innerHTML = `<span class="animate-pulse" style="color:#38bdf8">
      <span class="material-symbols-outlined text-[10px] align-middle">compress</span>
      컴팩션 중... 기억 정리하는 중!
    </span>`;
    bubble.classList.add('visible');
    bubble.style.borderColor = 'rgba(56,189,248,0.5)';
    mascotData.idleBubbleActive = false;
    return;
  }

  // Completion — persistent until next activity (like permission request)
  const stopMsg = sessionStopMessage.get(pid);
  if (stopMsg) {
    if (stopMsg.excited) {
      bubble.innerHTML = `<span style="color:#fbbf24">
        <span class="material-symbols-outlined text-[10px] align-middle">celebration</span>
        🎉 ${esc(stopMsg.quote)}
      </span>`;
      bubble.style.borderColor = 'rgba(251,191,36,0.5)';
    } else {
      bubble.innerHTML = `<span style="color:#4ade80">
        <span class="material-symbols-outlined text-[10px] align-middle">check_circle</span>
        ${esc(stopMsg.quote)}
      </span>`;
      bubble.style.borderColor = 'rgba(74,222,128,0.5)';
    }
    bubble.classList.add('visible');
    mascotData.idleBubbleActive = false;
    return;
  }

  // Reset border color
  bubble.style.borderColor = '';

  if (status === 'thinking') {
    bubble.innerHTML = '<span class="animate-pulse">thinking...</span>';
    bubble.classList.add('visible');
    mascotData.idleBubbleActive = false;
  } else if (status === 'running' && lastTool) {
    bubble.innerHTML = toolBubbleHtml(lastTool);
    bubble.classList.add('visible');
    mascotData.idleBubbleActive = false;
  } else if (lastTool && Date.now() - lastTool.ts < 5000) {
    bubble.innerHTML = toolBubbleHtml(lastTool);
    bubble.classList.add('visible');
    mascotData.idleBubbleActive = false;
  } else if (mascotData.idleBubbleActive) {
    // Keep showing idle quote (managed by timer)
  } else {
    bubble.classList.remove('visible');
  }
}

function updateMascotTaskLabel(pid) {
  const m = activeMascots.get(pid);
  if (!m) return;
  let taskEl = m.el.querySelector('.mascot-task-label');
  const task = sessionCurrentTask.get(pid);
  if (task) {
    if (!taskEl) {
      taskEl = document.createElement('div');
      taskEl.className = 'mascot-task-label';
      taskEl.style.cssText = 'position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);white-space:nowrap;background:rgba(96,70,255,0.15);border:1px solid rgba(96,70,255,0.3);color:#a78bfa;font-size:8px;padding:1px 6px;border-radius:8px;pointer-events:none;z-index:6;max-width:140px;overflow:hidden;text-overflow:ellipsis;';
      m.el.appendChild(taskEl);
    }
    taskEl.textContent = task.subject.length > 20 ? task.subject.slice(0, 20) + '…' : task.subject;
  } else if (taskEl) {
    taskEl.remove();
  }
}

const clickQuotes = [
  '앗! 간지러워~',
  '왜왜왜?! 일하고 있었다구!',
  '꾹 누르지 마..>_<',
  '나 만지면 버그 생긴다?',
  '살살 해줘~',
  '또 나야? 다른 매숑이도 있잖아!',
  '클릭 한 번 더 하면 정보 보여줄게!',
  '심심해? 나도~',
  '띠용?!',
  '누가 불렀어?',
  '배고프다.. 코드 줘..',
  '히힛 그거 나한테 하는 거야?',
  '우리 사이에 클릭이 웬말이야~',
  'zzZ..어? 안 잤어!',
  '오늘도 화이팅이야!',
];

/* ── Mascot Drag ──────────────────────────────── */
function enableMascotDrag(el, mascotData) {
  let dragging = false;
  let startX, startY, origLeft, origTop;

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseFloat(el.style.left) || 0;
    origTop = parseFloat(el.style.top) || 0;

    // Pause wander transition during drag
    el.style.transition = 'none';

    const onMove = (e2) => {
      const dx = e2.clientX - startX;
      const dy = e2.clientY - startY;
      if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        dragging = true;
        el.style.cursor = 'grabbing';
      }
      if (dragging) {
        el.style.left = (origLeft + dx) + 'px';
        el.style.top = (origTop + dy) + 'px';
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      el.style.cursor = 'pointer';
      // Restore transition
      el.style.transition = 'left 4s cubic-bezier(0.4, 0, 0.2, 1), top 4s cubic-bezier(0.4, 0, 0.2, 1)';
      if (dragging) {
        // Temporarily pause wander so it doesn't snap back
        mascotData.draggedUntil = Date.now() + 8000;
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // Only fire click if not dragging
  el.addEventListener('click', (e) => {
    if (dragging) { e.stopPropagation(); dragging = false; return; }
  }, true);
}

function handleMascotClick(mascotData, pid, el, e) {
  e.stopPropagation();
  // If clicked recently (within 1.5s), show session detail
  if (mascotData.lastClickTs && Date.now() - mascotData.lastClickTs < 1500) {
    mascotData.lastClickTs = 0;
    showSessionDetail(pid, el);
    return;
  }
  mascotData.lastClickTs = Date.now();

  // Cute bounce reaction
  const img = el.querySelector('.mascot-img');
  if (img) {
    img.style.animation = 'none';
    img.offsetHeight; // reflow
    img.style.animation = 'mascot-click-bounce 0.5s ease-out';
    setTimeout(() => {
      img.style.animation = '';
    }, 500);
  }

  // Show a click quote (but not if priority bubble is active)
  if (!hasPriorityBubble(pid)) {
    const bubble = el.querySelector('.mascot-bubble');
    if (bubble) {
      const quote = clickQuotes[Math.floor(Math.random() * clickQuotes.length)];
      bubble.textContent = quote;
      bubble.classList.add('visible');
      mascotData.idleBubbleActive = true;
      clearTimeout(mascotData.clickBubbleTimeout);
      mascotData.clickBubbleTimeout = setTimeout(() => {
        if (!hasPriorityBubble(pid)) { mascotData.idleBubbleActive = false; bubble.classList.remove('visible'); }
      }, 10000);
    }
  }
}

function showRandomQuote(mascotData) {
  if (hasPriorityBubble(mascotData.pid)) return; // never override permission/compaction
  const s = sessions.get(mascotData.pid);
  if (!s || s.status === 'thinking' || s.status === 'running') return;
  const lastTool = sessionLastTool.get(mascotData.pid);
  if (lastTool && Date.now() - lastTool.ts < 5000) return;
  if (mascotData.interactingUntil > Date.now()) return;

  const bubble = mascotData.el.querySelector('.mascot-bubble');
  if (!bubble) return;

  // Update mood
  const mood = (mascotData.moodUntil && mascotData.moodUntil > Date.now()) ? mascotData.mood : getMascotMood(mascotData.pid);
  if (mood !== mascotData.mood) { mascotData.mood = mood; applyMood(mascotData); }

  // Pick quotes based on mood
  let pool = idleQuotes;
  if (mood === 'tired' && Math.random() < 0.5) pool = moodQuotes.tired;
  else if (mood === 'happy' && Math.random() < 0.3) pool = moodQuotes.happy;
  const emoji = getMoodEmoji(mood);
  const quote = (emoji ? emoji + ' ' : '') + pool[Math.floor(Math.random() * pool.length)];
  bubble.textContent = quote;
  bubble.classList.add('visible');
  mascotData.idleBubbleActive = true;

  // Hide after a few seconds (but keep priority bubble intact)
  setTimeout(() => {
    if (hasPriorityBubble(mascotData.pid)) return;
    mascotData.idleBubbleActive = false;
    const s2 = sessions.get(mascotData.pid);
    if (!s2 || s2.status === 'idle') {
      bubble.classList.remove('visible');
    }
  }, 12000 + Math.random() * 6000);
}

function syncMascots() {
  if (!mascotContainer || !canvas) return;

  // Add mascots for new sessions
  for (const [pid, s] of sessions) {
    if (activeMascots.has(pid)) {
      // Update existing mascot status
      const m = activeMascots.get(pid);
      const prevStatus = m.lastStatus;
      m.el.setAttribute('data-status', s.status);

      // Update label status dot
      const statusDot = m.el.querySelector('.mascot-status-dot');
      if (statusDot) {
        statusDot.className = 'mascot-status-dot w-1.5 h-1.5 rounded-full inline-block mr-1 ' +
          (s.status === 'compacting' ? 'bg-sky-400 animate-pulse' :
           s.status === 'thinking' ? 'bg-indigo-500 animate-pulse' :
           s.status === 'running' ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500');
      }

      // Re-schedule wander if status changed
      if (prevStatus !== s.status) {
        clearInterval(m.interval);
        m.interval = setInterval(() => wanderMascot(m.el, s.status), getWanderInterval(s.status));
        m.lastStatus = s.status;
      }

      updateBubble(m, s.status);
      continue;
    }

    // Create new mascot
    const el = document.createElement('div');
    el.className = 'mascot';
    el.setAttribute('data-status', s.status);
    el.innerHTML = `
      <div class="mascot-bubble"></div>
      <img src="/img/mascot-default.png" alt="${esc(s.name || 'mascot')}" class="mascot-img" draggable="false">
      <div class="mascot-label">
        <span class="mascot-status-dot w-1.5 h-1.5 rounded-full inline-block mr-1 bg-emerald-500"></span>
        ${esc(s.name || pid)}
      </div>`;

    // Animate between two mascot images
    const mascotImg = el.querySelector('.mascot-img');
    const images = ['/img/mascot-default.png', '/img/mascot-move.png'];
    const imgInterval = startImageAnimation(mascotImg, images, 600);

    // Random initial position
    const cw = canvas.clientWidth || 800;
    const ch = canvas.clientHeight || 600;
    el.style.left = (Math.random() * (cw - 160) + 20) + 'px';
    el.style.top  = (Math.random() * (ch - 160) + 20) + 'px';
    el.style.animationDelay = (Math.random() * -3) + 's';

    mascotContainer.appendChild(el);

    const interval = setInterval(() => wanderMascot(el, s.status), getWanderInterval(s.status));
    setTimeout(() => wanderMascot(el, s.status), 1000 + Math.random() * 2000);

    const mascotData = { el, interval, imgInterval, quoteInterval: null, lastStatus: s.status, pid, idleBubbleActive: false, draggedUntil: 0, mood: 'normal', moodUntil: 0, interactingUntil: 0 };
    mascotData.quoteInterval = setInterval(() => showRandomQuote(mascotData), 8000 + Math.random() * 7000);

    // Enable drag + click interaction
    enableMascotDrag(el, mascotData);
    el.addEventListener('click', (e) => handleMascotClick(mascotData, pid, el, e));

    activeMascots.set(pid, mascotData);
    updateBubble(mascotData, s.status);
  }

  // Remove mascots for ended sessions
  for (const [pid, m] of activeMascots) {
    if (!sessions.has(pid)) {
      m.el.style.opacity = '0';
      m.el.style.transition = 'opacity 0.8s';
      clearInterval(m.interval);
      clearInterval(m.imgInterval);
      clearInterval(m.quoteInterval);
      setTimeout(() => m.el.remove(), 800);
      activeMascots.delete(pid);
    }
  }
}

function wanderMascot(el, status) {
  if (!canvas) return;
  // Skip wander if mascot was recently dragged
  for (const [, m] of activeMascots) {
    if (m.el === el && m.draggedUntil > Date.now()) return;
  }
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const curLeft = parseFloat(el.style.left) || cw / 2;
  const curTop = parseFloat(el.style.top) || ch / 2;

  let x, y;
  if (status === 'thinking') {
    // Small sway — stays near current position
    x = Math.max(20, Math.min(cw - 160, curLeft + (Math.random() - 0.5) * 60));
    y = Math.max(20, Math.min(ch - 160, curTop + (Math.random() - 0.5) * 40));
  } else if (status === 'running') {
    // Big jumps — moves far
    x = Math.random() * (cw - 160) + 20;
    y = Math.random() * (ch - 160) + 20;
  } else {
    // Normal wander
    x = Math.max(20, Math.min(cw - 160, curLeft + (Math.random() - 0.5) * 300));
    y = Math.max(20, Math.min(ch - 160, curTop + (Math.random() - 0.5) * 200));
  }
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

/* ══════════════════════════════════════════════════
   Session Detail Popup (click mascot)
   ══════════════════════════════════════════════════ */
let activeDetailEl = null;

function closeSessionDetail() {
  if (activeDetailEl) { activeDetailEl.remove(); activeDetailEl = null; }
}

document.addEventListener('click', closeSessionDetail);

function showSessionDetail(pid, mascotEl) {
  closeSessionDetail();
  const s = sessions.get(pid);
  if (!s) return;

  const rect = mascotEl.getBoundingClientRect();
  const detail = document.createElement('div');
  detail.className = 'mascot-detail';
  detail.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + 'px';
  detail.style.top = Math.max(8, rect.top - 20) + 'px';

  const elapsed = formatDuration(Date.now() - (s.startedAt || Date.now()));
  const statusLabel = { running: '작업 중', thinking: '사고 중', idle: '대기 중', ended: '완료' }[s.status] || '대기 중';
  const statusColor = { running: 'text-amber-400', thinking: 'text-indigo-400', idle: 'text-emerald-400', ended: 'text-slate-500' }[s.status] || 'text-emerald-400';
  const projectName = s.cwd ? s.cwd.split('/').pop() : '-';

  // Get recent events for this session
  const recentEvs = eventHistory.filter(e => e.pid === pid).slice(-8);
  const evRows = recentEvs.map(e => {
    const t = hhmm(e.ts);
    const detail = e.toolName || e.type;
    const info = e.toolDetail ? e.toolDetail.split('/').pop().slice(0, 30) : '';
    return `<div class="flex items-center gap-2 text-[10px] py-0.5">
      <span class="text-slate-600 font-mono">${t}</span>
      <span class="t-${e.type}">${esc(detail)}</span>
      <span class="text-slate-500 truncate">${esc(info)}</span>
    </div>`;
  }).join('');

  detail.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-[#6046ff]">smart_toy</span>
        <span class="text-sm font-bold text-slate-200">${esc(s.name || pid)}</span>
      </div>
      <button class="text-slate-500 hover:text-slate-300 cursor-pointer" onclick="this.closest('.mascot-detail').remove()">
        <span class="material-symbols-outlined text-sm">close</span>
      </button>
    </div>
    <div class="grid grid-cols-3 gap-2 mb-3">
      <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
        <div class="text-[9px] text-slate-500">상태</div>
        <div class="text-xs font-bold ${statusColor}">${statusLabel}</div>
      </div>
      <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
        <div class="text-[9px] text-slate-500">경과 시간</div>
        <div class="text-xs font-bold text-white font-mono">${elapsed}</div>
      </div>
      <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
        <div class="text-[9px] text-slate-500">프로젝트</div>
        <div class="text-xs font-bold text-[#6046ff] truncate">${esc(projectName)}</div>
      </div>
    </div>
    ${evRows ? `
    <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-1">최근 활동</div>
    <div class="bg-[#0d0f18] rounded p-2 max-h-[160px] overflow-y-auto">${evRows}</div>
    ` : '<div class="text-[10px] text-slate-600 text-center py-3">아직 활동 기록이 없습니다</div>'}
  `;

  detail.addEventListener('click', e => e.stopPropagation());
  document.body.appendChild(detail);
  activeDetailEl = detail;
}

/* ══════════════════════════════════════════════════
   Image Animation
   ══════════════════════════════════════════════════ */
function startImageAnimation(element, images, interval = 600) {
  let imageIndex = 0;
  const imgInterval = setInterval(() => {
    element.src = images[imageIndex];
    imageIndex = (imageIndex + 1) % images.length;
  }, interval);
  return imgInterval;
}

/* ══════════════════════════════════════════════════
   Mini Window — Document PiP (primary) + fallback
   ══════════════════════════════════════════════════ */
let pipWindow = null;
let pipSyncInterval = null;

document.getElementById('btn-pip')?.addEventListener('click', async () => {
  // Toggle off if already open
  if (pipWindow && !pipWindow.closed) {
    pipWindow.close();
    cleanupPip();
    return;
  }

  // Try Document PiP first (Chrome 116+)
  if ('documentPictureInPicture' in window) {
    try {
      await openDocumentPip();
      return;
    } catch (e) {
      console.warn('Document PiP failed, falling back to window.open:', e);
    }
  }

  // Fallback: window.open to /mini.html
  const w = 420, h = 340;
  const left = Math.round(window.screenX + window.outerWidth - w - 30);
  const top = Math.round(window.screenY + 60);
  const win = window.open('/mini.html', 'mashong-mini', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  if (!win) showToast('팝업 차단', '팝업이 차단되었습니다. 주소창의 팝업 차단 아이콘에서 허용해주세요.');
});

function cleanupPip() {
  clearInterval(pipSyncInterval);
  pipSyncInterval = null;
  pipWindow = null;
}

async function openDocumentPip() {
  pipWindow = await documentPictureInPicture.requestWindow({
    width: 380,
    height: 320,
  });

  const doc = pipWindow.document;

  // ── Styles ──
  const style = doc.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&display=swap');
    @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: #0d0f18; color: #e3e1ec; font-family: 'Fira Code', monospace;
      overflow: hidden; height: 100vh; position: relative;
      background-image: radial-gradient(circle, #252838 1px, transparent 1px);
      background-size: 24px 24px; user-select: none;
    }
    .material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
    .mascot {
      position: absolute; z-index: 5;
      transition: left 4s cubic-bezier(0.4,0,0.2,1), top 4s cubic-bezier(0.4,0,0.2,1);
      filter: drop-shadow(0 6px 16px rgba(96,70,255,0.15));
    }
    .mascot-img { width: 80px; height: auto; image-rendering: pixelated; display: block; animation: idle 3s ease-in-out infinite; }
    @keyframes idle {
      0%   { transform: translateY(0) scale(1) rotate(0deg); }
      25%  { transform: translateY(-4px) scale(1.02) rotate(0.8deg); }
      50%  { transform: translateY(2px) scale(1.01) rotate(-0.5deg); }
      75%  { transform: translateY(-3px) scale(1.02) rotate(0.6deg); }
      100% { transform: translateY(0) scale(1) rotate(0deg); }
    }
    @keyframes think { 0% { transform: translateY(0) scale(1); } 50% { transform: translateY(-2px) scale(1.05); } 100% { transform: translateY(0) scale(1); } }
    @keyframes run {
      0%   { transform: translateY(0) rotate(0deg) scale(1); }
      15%  { transform: translateY(-8px) rotate(-3deg) scale(1.04); }
      30%  { transform: translateY(0) rotate(2deg) scale(1); }
      45%  { transform: translateY(-6px) rotate(-2deg) scale(1.03); }
      60%  { transform: translateY(0) rotate(1deg) scale(1); }
      100% { transform: translateY(0) rotate(0deg) scale(1); }
    }
    .mascot[data-status="idle"]     .mascot-img { animation-name: idle; animation-duration: 3s; }
    .mascot[data-status="thinking"] .mascot-img { animation-name: think; animation-duration: 1.5s; }
    .mascot[data-status="running"]  .mascot-img { animation-name: run; animation-duration: 1.2s; }
    .bubble {
      position: absolute; top: -6px; left: 50%; transform: translateX(-50%);
      background: #13151f; border: 1px solid #6046ff40; border-radius: 6px;
      padding: 2px 6px; font-size: 8px; color: #c6bfff;
      white-space: nowrap; opacity: 0; transition: opacity 0.3s;
      pointer-events: none; z-index: 6; max-width: 160px;
      overflow: hidden; text-overflow: ellipsis;
    }
    .bubble::after {
      content: ''; position: absolute; bottom: -4px; left: 50%; transform: translateX(-50%);
      border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 4px solid #6046ff40;
    }
    .bubble.visible { opacity: 1; }
    .label {
      text-align: center; font-size: 8px; color: #c6bfff;
      background: rgba(96,70,255,0.12); border: 1px solid rgba(96,70,255,0.25);
      border-radius: 3px; padding: 1px 6px; margin-top: 2px;
      white-space: nowrap; width: fit-content; margin-left: auto; margin-right: auto;
    }
    .bar {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: #13151fee; backdrop-filter: blur(8px);
      border-top: 1px solid #252838; padding: 5px 10px;
      display: flex; align-items: center; gap: 6px; z-index: 20;
      flex-wrap: wrap; min-height: 26px;
    }
    .chip {
      display: flex; align-items: center; gap: 4px;
      background: #1c1f2e; border: 1px solid #252838; border-radius: 4px;
      padding: 2px 6px; font-size: 8px;
    }
    .dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .empty {
      position: absolute; top: 0; left: 0; right: 0; bottom: 26px;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      opacity: 0.3; pointer-events: none;
    }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    .pulse { animation: pulse 2s cubic-bezier(0.4,0,0.6,1) infinite; }
  `;
  doc.head.appendChild(style);

  // ── Body ──
  doc.body.innerHTML = `
    <div id="area" style="position:absolute;top:0;left:0;right:0;bottom:26px;overflow:hidden;"></div>
    <div id="empty" class="empty">
      <span class="material-symbols-outlined" style="font-size:28px;color:#6046ff;">pets</span>
      <span style="font-size:9px;color:#474556;margin-top:4px;">세션 대기 중...</span>
    </div>
    <div id="bar" class="bar"><span style="font-size:8px;color:#474556;">연결 중...</span></div>
  `;

  const area = doc.getElementById('area');
  const bar = doc.getElementById('bar');
  const empty = doc.getElementById('empty');
  const pipMascots = new Map();

  // ── Sync loop — reads from parent page's state ──
  function syncPip() {
    if (!pipWindow || pipWindow.closed) { cleanupPip(); return; }

    const aw = area.clientWidth || 360;
    const ah = area.clientHeight || 260;

    // Create / update mascots
    for (const [pid, s] of sessions) {
      if (s.status === 'ended') continue;

      if (!pipMascots.has(pid)) {
        const el = doc.createElement('div');
        el.className = 'mascot';
        el.setAttribute('data-status', s.status);
        el.innerHTML = `<div class="bubble"></div>
          <img src="/img/mascot-default.png" class="mascot-img" draggable="false">
          <div class="label">${esc(s.name || pid)}</div>`;
        el.style.left = (Math.random() * (aw - 100) + 10) + 'px';
        el.style.top = (Math.random() * (ah - 100) + 10) + 'px';

        const img = el.querySelector('.mascot-img');
        const frames = ['/img/mascot-default.png', '/img/mascot-move.png'];
        let fi = 0;
        const imgInt = setInterval(() => {
          if (pipWindow?.closed) return;
          img.src = frames[fi]; fi = (fi + 1) % 2;
        }, 600);

        area.appendChild(el);
        pipMascots.set(pid, { el, imgInt, wt: 0 });
      }

      const pm = pipMascots.get(pid);
      pm.el.setAttribute('data-status', s.status);

      // Mirror bubble from main window
      const mainM = activeMascots.get(pid);
      const pb = pm.el.querySelector('.bubble');
      if (mainM && pb) {
        const mb = mainM.el.querySelector('.mascot-bubble');
        if (mb) {
          pb.innerHTML = mb.innerHTML;
          pb.className = 'bubble' + (mb.classList.contains('visible') ? ' visible' : '');
          pb.style.borderColor = mb.style.borderColor;
        }
      }

      // Wander
      if (Date.now() - pm.wt > 5000) {
        pm.wt = Date.now();
        const cl = parseFloat(pm.el.style.left) || aw / 2;
        const ct = parseFloat(pm.el.style.top) || ah / 2;
        let nx, ny;
        if (s.status === 'thinking') {
          nx = Math.max(10, Math.min(aw - 100, cl + (Math.random() - 0.5) * 30));
          ny = Math.max(10, Math.min(ah - 100, ct + (Math.random() - 0.5) * 20));
        } else if (s.status === 'running') {
          nx = Math.random() * (aw - 100) + 10;
          ny = Math.random() * (ah - 100) + 10;
        } else {
          nx = Math.max(10, Math.min(aw - 100, cl + (Math.random() - 0.5) * 120));
          ny = Math.max(10, Math.min(ah - 100, ct + (Math.random() - 0.5) * 80));
        }
        pm.el.style.left = nx + 'px';
        pm.el.style.top = ny + 'px';
      }
    }

    // Remove ended
    for (const [pid, pm] of pipMascots) {
      const s = sessions.get(pid);
      if (!s || s.status === 'ended') {
        pm.el.style.opacity = '0'; pm.el.style.transition = 'opacity 0.5s';
        clearInterval(pm.imgInt);
        setTimeout(() => { try { pm.el.remove(); } catch(_){} }, 500);
        pipMascots.delete(pid);
      }
    }

    empty.style.display = pipMascots.size > 0 ? 'none' : '';

    // Status bar
    const chips = [];
    for (const [pid, s] of sessions) {
      if (s.status === 'ended') continue;
      const dc = { running:'#f59e0b', thinking:'#818cf8', idle:'#10b981', compacting:'#38bdf8' }[s.status] || '#10b981';
      const lb = { running:'RUN', thinking:'THINK', idle:'IDLE', compacting:'COMPACT' }[s.status] || 'IDLE';
      const lc = { running:'#fbbf24', thinking:'#a5b4fc', idle:'#34d399', compacting:'#7dd3fc' }[s.status] || '#34d399';
      const pulse = (s.status === 'thinking' || s.status === 'running') ? ' pulse' : '';
      const perm = sessionPermPending.has(pid) ? '<span style="color:#fb923c;font-size:7px;margin-left:2px" class="pulse">PERM</span>' : '';
      chips.push(`<div class="chip"><span class="dot${pulse}" style="background:${dc}"></span>
        <span style="color:#c6bfff;max-width:80px;overflow:hidden;text-overflow:ellipsis">${esc((s.name||pid).slice(0,14))}</span>
        <span style="color:${lc};font-weight:bold;font-size:7px">${lb}</span>${perm}</div>`);
    }
    bar.innerHTML = chips.length > 0 ? chips.join('') : '<span style="font-size:8px;color:#474556">세션 없음</span>';
  }

  syncPip();
  pipSyncInterval = setInterval(syncPip, 800);

  pipWindow.addEventListener('pagehide', () => {
    for (const pm of pipMascots.values()) clearInterval(pm.imgInt);
    pipMascots.clear();
    cleanupPip();
  });
}

/* ══════════════════════════════════════════════════
   Settings 드롭다운 & 로그아웃
   ══════════════════════════════════════════════════ */
document.getElementById('btn-settings')?.addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('settings-dropdown').classList.toggle('hidden');
});

document.addEventListener('click', () => {
  document.getElementById('settings-dropdown')?.classList.add('hidden');
});

document.getElementById('btn-logout')?.addEventListener('click', async () => {
  document.getElementById('settings-dropdown').classList.add('hidden');
  const confirmed = await showConfirm('로그아웃 하시겠습니까?', '로그아웃');
  if (!confirmed) return;

  await fetch(`${COMMUNITY_API}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  currentUser = null;
  currentHookToken = null;
  showCommunityGroups();
  renderGroupCards([]);
  openAuthModal('login');
});

/* ══════════════════════════════════════════════════
   Community: 인증
   ══════════════════════════════════════════════════ */
let currentUser = null; // { memberId, username, name }
let currentHookToken = null;

async function ensureCommunityHookToken() {
  if (currentHookToken) return currentHookToken;
  const res = await fetch(`${COMMUNITY_API}/api/metrics/token`, { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Claude 토큰을 불러오지 못했습니다.');
  currentHookToken = data.token;
  return currentHookToken;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildHookEnvInstallCommand(token) {
  return `curl -fsSL ${COMMUNITY_API}/api/metrics/env-installer | sh -s -- ${shellQuote(token)} ${shellQuote(COMMUNITY_API)}`;
}

function showHookTokenFeedback(message, isError = false) {
  const el = document.getElementById('hook-token-copy-feedback');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden', 'text-emerald-400', 'text-red-400');
  el.classList.add(isError ? 'text-red-400' : 'text-emerald-400');
}

function populateHookTokenModal(token) {
  document.getElementById('hook-token-value').textContent = token;
  document.getElementById('hook-token-install-command').textContent = buildHookEnvInstallCommand(token);
}

async function openHookTokenModal(options = {}) {
  const { firstRun = false, token = null } = options;
  const modalEl = document.getElementById('modal-hook-token');
  document.getElementById('hook-token-modal-title').textContent = firstRun
    ? '회원가입 완료, Claude 연동을 마무리해요'
    : 'Claude 연동 토큰';
  document.getElementById('hook-token-modal-subtitle').textContent = firstRun
    ? '아래 토큰을 `.env.local`에 한 번만 넣으면 그룹 실시간 데이터가 연결됩니다.'
    : '이 토큰을 `.env.local`에 넣어두면 이후 훅 이벤트가 자동으로 전송됩니다.';
  document.getElementById('hook-token-copy-feedback').classList.add('hidden');

  try {
    const resolvedToken = token || await ensureCommunityHookToken();
    populateHookTokenModal(resolvedToken);
  } catch (e) {
    document.getElementById('hook-token-value').textContent = e.message;
    document.getElementById('hook-token-install-command').textContent = '';
    showHookTokenFeedback('Claude 토큰을 불러오지 못했습니다.', true);
  }

  modalEl.classList.remove('hidden');
  modalEl.classList.add('flex');
}

function closeHookTokenModal() {
  const modalEl = document.getElementById('modal-hook-token');
  modalEl.classList.add('hidden');
  modalEl.classList.remove('flex');
}

async function checkAuth() {
  try {
    const res = await fetch(`${COMMUNITY_API}/api/auth/me`, { credentials: 'include' });
    if (!res.ok) { currentUser = null; currentHookToken = null; return false; }
    currentUser = await res.json();
    return true;
  } catch (_) { currentUser = null; currentHookToken = null; return false; }
}

function openAuthModal(tab = 'login') {
  switchAuthTab(tab);
  document.getElementById('modal-auth').classList.remove('hidden');
  document.getElementById('modal-auth').classList.add('flex');
}

function closeAuthModal() {
  document.getElementById('modal-auth').classList.add('hidden');
  document.getElementById('modal-auth').classList.remove('flex');
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('auth-form-login').classList.toggle('hidden', !isLogin);
  document.getElementById('auth-form-register').classList.toggle('hidden', isLogin);
  document.getElementById('auth-tab-login').className    = `flex-1 py-4 text-sm font-bold border-b-2 transition-colors cursor-pointer ${isLogin  ? 'text-[#6046ff] border-[#6046ff]' : 'text-slate-500 hover:text-slate-300 border-transparent'}`;
  document.getElementById('auth-tab-register').className = `flex-1 py-4 text-sm font-bold border-b-2 transition-colors cursor-pointer ${!isLogin ? 'text-[#6046ff] border-[#6046ff]' : 'text-slate-500 hover:text-slate-300 border-transparent'}`;
}

document.getElementById('auth-tab-login')?.addEventListener('click', () => switchAuthTab('login'));
document.getElementById('auth-tab-register')?.addEventListener('click', () => switchAuthTab('register'));

document.getElementById('btn-claude-token')?.addEventListener('click', async () => {
  document.getElementById('settings-dropdown').classList.add('hidden');
  if (!currentUser && !await checkAuth()) {
    openAuthModal('login');
    return;
  }
  await openHookTokenModal();
});

document.getElementById('btn-hook-token-close')?.addEventListener('click', closeHookTokenModal);
document.getElementById('btn-hook-token-confirm')?.addEventListener('click', closeHookTokenModal);
document.getElementById('modal-hook-token')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) closeHookTokenModal();
});

document.getElementById('btn-copy-hook-token')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById('hook-token-value').textContent.trim());
    showHookTokenFeedback('Claude 토큰을 복사했어요.');
  } catch (_) {
    showHookTokenFeedback('복사에 실패했습니다. 직접 선택해서 복사해주세요.', true);
  }
});

document.getElementById('btn-copy-hook-install')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(document.getElementById('hook-token-install-command').textContent);
    showHookTokenFeedback('자동 설정 명령을 복사했어요.');
  } catch (_) {
    showHookTokenFeedback('복사에 실패했습니다. 직접 선택해서 복사해주세요.', true);
  }
});

document.getElementById('btn-login-submit')?.addEventListener('click', async () => {
  const username = document.getElementById('input-login-username').value.trim();
  const password = document.getElementById('input-login-password').value;
  const errorEl  = document.getElementById('login-error');
  const btn      = document.getElementById('btn-login-submit');

  errorEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = '로그인 중...';

  try {
    const res  = await fetch(`${COMMUNITY_API}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentUser = data;
    currentHookToken = null;
    closeAuthModal();
    await refreshGroupList();
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
  }
});

document.getElementById('btn-register-submit')?.addEventListener('click', async () => {
  const username = document.getElementById('input-register-username').value.trim();
  const password = document.getElementById('input-register-password').value;
  const name     = document.getElementById('input-register-name').value.trim();
  const errorEl  = document.getElementById('register-error');
  const btn      = document.getElementById('btn-register-submit');

  errorEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = '가입 중...';

  try {
    const res  = await fetch(`${COMMUNITY_API}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password, name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    currentUser = data;
    currentHookToken = data.hookToken || null;
    closeAuthModal();
    await refreshGroupList();
    await openHookTokenModal({ firstRun: true, token: currentHookToken });
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '회원가입';
  }
});

/* ══════════════════════════════════════════════════
   Community: 그룹 목록 fetch & 렌더링
   ══════════════════════════════════════════════════ */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function fetchMyGroups() {
  try {
    const res = await fetch(`${COMMUNITY_API}/api/community/groups`, { credentials: 'include' });
    if (res.status === 401) return null; // 미로그인
    if (!res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

function renderGroupCards(groups) {
  const container = document.getElementById('group-cards');
  const badge     = document.getElementById('my-groups-count');
  if (!container) return;

  if (badge) badge.textContent = `${groups.length}_ACTIVE`;

  if (groups.length === 0) {
    container.innerHTML = `
      <div class="col-span-4 py-16 flex flex-col items-center justify-center text-center">
        <span class="material-symbols-outlined text-5xl text-slate-700 mb-3">group_off</span>
        <p class="text-sm text-slate-500">참여 중인 그룹이 없습니다</p>
        <p class="text-xs text-slate-600 mt-1">그룹을 생성하거나 초대 코드로 참여해보세요</p>
      </div>`;
    return;
  }

  container.innerHTML = groups.map(g => `
    <div class="bg-[#13151f] border border-[#252838] rounded-xl p-5 flex flex-col hover:border-[#6046ff]/30 transition-colors" data-group-id="${g.id}" data-group-code="${escapeHtml(g.code)}" data-group-name="${escapeHtml(g.name)}" data-member-count="${g.memberCount}">
      <div class="flex-1 min-h-[80px]">
        <div class="flex items-start justify-between mb-3">
          <h3 class="text-base font-bold text-white leading-snug">${escapeHtml(g.name)}</h3>
          <div class="relative flex-shrink-0 ml-2">
            <button class="btn-group-more w-7 h-7 flex items-center justify-center rounded text-slate-500 hover:text-slate-300 hover:bg-[#252838] transition-colors cursor-pointer">
              <span class="material-symbols-outlined text-[18px]">more_horiz</span>
            </button>
            <div class="group-more-menu hidden absolute right-0 top-8 z-20 bg-[#1c1f2e] border border-[#252838] rounded-lg shadow-xl w-36 py-1">
              <button class="btn-view-code w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-[#252838] hover:text-white transition-colors flex items-center gap-2 cursor-pointer">
                <span class="material-symbols-outlined text-[14px]">key</span>
                초대 코드 보기
              </button>
            </div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 text-xs text-slate-500">
          <span class="material-symbols-outlined text-[14px]">group</span>
          <span class="font-mono">${g.memberCount}/${g.maxMembers} MEMBERS</span>
        </div>
      </div>
      <div class="flex items-center gap-2 mt-6 pt-4 border-t border-[#252838]/50">
        <button class="btn-group-enter px-4 py-1.5 bg-[#1c1f2e] border border-[#474556] rounded text-xs font-bold text-slate-200 hover:bg-[#6046ff] hover:border-[#6046ff] hover:text-white transition-colors cursor-pointer">진입</button>
        <button class="btn-group-leave px-3 py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors cursor-pointer">나가기</button>
      </div>
    </div>`).join('');
}

async function refreshGroupList() {
  const groups = await fetchMyGroups();
  if (groups === null) {
    showCommunityAuthRequired();
    return;
  }
  hideCommunityAuthRequired();
  renderGroupCards(groups);
  applyUnreadBadges();
}

// Decorate each [data-group-id] card with a KakaoTalk-style red badge
// showing the unread count, driven by GET /api/chat/unread.
async function applyUnreadBadges() {
  let unread;
  try {
    const res = await fetch(`${COMMUNITY_API}/api/chat/unread`, { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    unread = Array.isArray(data.unread) ? data.unread : [];
  } catch (_) { return; }

  const counts = new Map(unread.map(u => [Number(u.groupId), Number(u.unreadCount) || 0]));
  document.querySelectorAll('[data-group-id]').forEach(card => {
    const gid = Number(card.dataset.groupId);
    const count = counts.get(gid) || 0;
    let badge = card.querySelector(':scope > .unread-badge');
    if (count > 0) {
      if (!badge) {
        if (getComputedStyle(card).position === 'static') {
          card.style.position = 'relative';
        }
        badge = document.createElement('span');
        badge.className = 'unread-badge absolute -top-2 -right-2 min-w-[22px] h-[22px] px-1.5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-lg shadow-red-500/30 z-10';
        card.appendChild(badge);
      }
      badge.textContent = count > 99 ? '99+' : String(count);
    } else if (badge) {
      badge.remove();
    }
  });
}

// Refresh badges whenever chat.js says local state changed (read marker
// updated after viewing the active group, or login/active-group switch).
window.addEventListener('chat:unread-changed', applyUnreadBadges);

// Lightweight polling: every 2s, but only when the user is actually
// looking at the community group list. Stops automatically while the
// browser tab is hidden, while the user is on another app tab, or while
// they're inside a chat room. No SSE on background groups.
const UNREAD_POLL_INTERVAL_MS = 2000;

function isCommunityGroupListVisible() {
  if (document.visibilityState && document.visibilityState !== 'visible') return false;
  const view = document.getElementById('view-community');
  if (!view || view.classList.contains('hidden')) return false;
  const groups = document.getElementById('community-groups');
  return !!(groups && !groups.classList.contains('hidden'));
}

setInterval(() => {
  if (isCommunityGroupListVisible()) applyUnreadBadges();
}, UNREAD_POLL_INTERVAL_MS);

function showCommunityAuthRequired() {
  const community = document.getElementById('view-community');
  if (!community) return;

  // Hide the normal sub-views while the auth-required empty state is up.
  document.getElementById('community-groups')?.classList.add('hidden');
  document.getElementById('community-chat')?.classList.add('hidden');

  let empty = document.getElementById('community-auth-required');
  if (!empty) {
    empty = document.createElement('div');
    empty.id = 'community-auth-required';
    empty.className = 'absolute inset-0 flex flex-col items-center justify-center bg-[#0d0f18] dot-grid';
    empty.innerHTML = `
      <div class="w-24 h-24 mb-6 border border-dashed border-[#6046ff]/40 rounded-xl flex items-center justify-center">
        <span class="material-symbols-outlined text-4xl text-[#6046ff]">lock</span>
      </div>
      <p class="text-sm font-headline tracking-widest uppercase text-slate-300 mb-2">Login Required</p>
      <p class="text-slate-500 text-sm mb-6">로그인 후 사용할 수 있습니다.</p>
      <button id="btn-community-auth-login"
              class="px-6 py-2.5 bg-[#6046ff] hover:bg-[#725bff] text-white text-sm font-bold rounded-lg transition-colors cursor-pointer">
        로그인 / 회원가입
      </button>
    `;
    community.appendChild(empty);
    empty.querySelector('#btn-community-auth-login')?.addEventListener('click', () => {
      openAuthModal('login');
    });
  }
  empty.classList.remove('hidden');
}

function hideCommunityAuthRequired() {
  document.getElementById('community-auth-required')?.classList.add('hidden');
  const chatVisible = !document.getElementById('community-chat')?.classList.contains('hidden');
  if (!chatVisible) {
    document.getElementById('community-groups')?.classList.remove('hidden');
  }
}

// 커뮤니티 탭 클릭 시 목록 갱신
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'community') {
    btn.addEventListener('click', () => {
      showCommunityGroups();
      refreshGroupList();
    });
  }
});

// 초기 로드 시 커뮤니티 탭이 활성화돼 있으면 바로 갱신
if (document.getElementById('view-community') && !document.getElementById('view-community').classList.contains('hidden')) {
  refreshGroupList();
}

/* ══════════════════════════════════════════════════
   Community: 확인 다이얼로그
   ══════════════════════════════════════════════════ */
function showConfirm(message, okLabel = '확인') {
  return new Promise(resolve => {
    const modal = document.getElementById('modal-confirm');
    document.getElementById('modal-confirm-message').textContent = message;
    document.getElementById('btn-confirm-ok').textContent = okLabel;
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    function cleanup(result) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    const okBtn     = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

/* ══════════════════════════════════════════════════
   Community: 초대 코드 확인 모달
   ══════════════════════════════════════════════════ */
const modalViewCode = document.getElementById('modal-view-code');

function openViewCodeModal(groupName, code) {
  document.getElementById('view-code-group-name').textContent = groupName;
  document.getElementById('view-code-display').textContent    = code;
  const copyBtn = document.getElementById('btn-view-code-copy');
  copyBtn.innerHTML = '<span class="material-symbols-outlined text-[16px]">content_copy</span> 복사';
  copyBtn.classList.remove('text-emerald-400', 'border-emerald-400/30', 'bg-emerald-400/10');
  copyBtn.classList.add('text-[#6046ff]', 'border-[#6046ff]/30', 'bg-[#6046ff]/10');
  modalViewCode.classList.remove('hidden');
  modalViewCode.classList.add('flex');
}

function closeViewCodeModal() {
  modalViewCode.classList.add('hidden');
  modalViewCode.classList.remove('flex');
}

document.getElementById('btn-view-code-close')?.addEventListener('click', closeViewCodeModal);
modalViewCode?.addEventListener('click', e => {
  if (e.target === modalViewCode) closeViewCodeModal();
});

document.getElementById('btn-view-code-copy')?.addEventListener('click', () => {
  const code = document.getElementById('view-code-display').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('btn-view-code-copy');
    btn.innerHTML = '<span class="material-symbols-outlined text-[16px]">check</span> 복사됨';
    btn.classList.remove('text-[#6046ff]', 'border-[#6046ff]/30', 'bg-[#6046ff]/10');
    btn.classList.add('text-emerald-400', 'border-emerald-400/30', 'bg-emerald-400/10');
    setTimeout(() => {
      btn.innerHTML = '<span class="material-symbols-outlined text-[16px]">content_copy</span> 복사';
      btn.classList.remove('text-emerald-400', 'border-emerald-400/30', 'bg-emerald-400/10');
      btn.classList.add('text-[#6046ff]', 'border-[#6046ff]/30', 'bg-[#6046ff]/10');
    }, 2000);
  });
});

// 더보기 드롭다운 — 이벤트 위임
document.getElementById('group-cards')?.addEventListener('click', async e => {
  // 더보기 버튼 토글
  const moreBtn = e.target.closest('.btn-group-more');
  if (moreBtn) {
    e.stopPropagation();
    const menu = moreBtn.nextElementSibling;
    const isOpen = !menu.classList.contains('hidden');
    // 열려있는 다른 메뉴 모두 닫기
    document.querySelectorAll('.group-more-menu').forEach(m => m.classList.add('hidden'));
    if (!isOpen) menu.classList.remove('hidden');
    return;
  }

  // 초대 코드 보기
  const codeBtn = e.target.closest('.btn-view-code');
  if (codeBtn) {
    const card = codeBtn.closest('[data-group-code]');
    openViewCodeModal(card.dataset.groupName, card.dataset.groupCode);
    document.querySelectorAll('.group-more-menu').forEach(m => m.classList.add('hidden'));
    return;
  }

  // 그룹 나가기
  const leaveBtn = e.target.closest('.btn-group-leave');
  if (leaveBtn) {
    const card      = leaveBtn.closest('[data-group-id]');
    const groupId   = Number(card.dataset.groupId);
    const groupName = card.dataset.groupName;
    if (!await showConfirm(`"${groupName}" 그룹에서 나가시겠어요?`, '나가기')) return;

    try {
      const res  = await fetch(`${COMMUNITY_API}/api/community/groups/${groupId}/leave`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body:    JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '오류가 발생했습니다.');

      showToast('그룹 나가기', `"${groupName}"에서 나왔어요.`, 'info');
      await refreshGroupList();
    } catch (e) {
      showToast('그룹 나가기 실패', e.message, 'error');
    }
    return;
  }
});

// 카드 영역 외 클릭 시 드롭다운 닫기
document.addEventListener('click', () => {
  document.querySelectorAll('.group-more-menu').forEach(m => m.classList.add('hidden'));
});

/* ══════════════════════════════════════════════════
   Community: 그룹 참여 모달
   ══════════════════════════════════════════════════ */
const modalJoinGroup  = document.getElementById('modal-join-group');
const joinStepForm    = document.getElementById('join-step-form');
const joinStepConfirm = document.getElementById('join-step-confirm');

function openJoinGroupModal() {
  document.getElementById('input-invite-code').value = '';
  document.getElementById('input-join-nickname').value = '';
  document.getElementById('join-form-error').classList.add('hidden');
  document.getElementById('btn-join-verify').disabled = false;
  document.getElementById('btn-join-verify').textContent = '코드 확인';
  joinStepForm.classList.remove('hidden');
  joinStepConfirm.classList.add('hidden');
  modalJoinGroup.classList.remove('hidden');
  modalJoinGroup.classList.add('flex');
  document.getElementById('input-invite-code').focus();
}

function closeJoinGroupModal() {
  modalJoinGroup.classList.add('hidden');
  modalJoinGroup.classList.remove('flex');
}

let verifiedMemberCount = 0;

document.getElementById('btn-group-join')?.addEventListener('click', openJoinGroupModal);
document.getElementById('btn-join-modal-close')?.addEventListener('click', closeJoinGroupModal);
modalJoinGroup?.addEventListener('click', e => {
  if (e.target === modalJoinGroup) closeJoinGroupModal();
});

document.getElementById('input-invite-code')?.addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase();
});

document.getElementById('btn-join-verify')?.addEventListener('click', async () => {
  const code      = document.getElementById('input-invite-code').value.trim();
  const nickname  = document.getElementById('input-join-nickname').value.trim();
  const errorEl   = document.getElementById('join-form-error');
  const verifyBtn = document.getElementById('btn-join-verify');

  if (!code) {
    errorEl.textContent = '초대 코드를 입력해주세요.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!nickname) {
    errorEl.textContent = '닉네임을 입력해주세요.';
    errorEl.classList.remove('hidden');
    return;
  }
  errorEl.classList.add('hidden');
  verifyBtn.disabled = true;
  verifyBtn.textContent = '확인 중...';

  try {
    const res  = await fetch(`${COMMUNITY_API}/api/community/groups/verify?code=${encodeURIComponent(code)}`, { credentials: 'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '오류가 발생했습니다.');

    if (data.memberCount >= data.maxMembers) {
      throw new Error('그룹 정원이 가득 찼습니다.');
    }

    verifiedMemberCount = data.memberCount;
    document.getElementById('join-group-name').textContent    = data.name;
    document.getElementById('join-group-members').textContent = `${data.memberCount}/${data.maxMembers} MEMBERS`;
    joinStepForm.classList.add('hidden');
    joinStepConfirm.classList.remove('hidden');
  } catch (e) {
    showToast('코드 확인 실패', e.message, 'error');
    verifyBtn.disabled = false;
    verifyBtn.textContent = '코드 확인';
  }
});

document.getElementById('btn-join-back')?.addEventListener('click', () => {
  joinStepConfirm.classList.add('hidden');
  joinStepForm.classList.remove('hidden');
  document.getElementById('btn-join-verify').disabled = false;
  document.getElementById('btn-join-verify').textContent = '코드 확인';
});

document.getElementById('btn-join-confirm')?.addEventListener('click', async () => {
  const code      = document.getElementById('input-invite-code').value.trim();
  const confirmBtn = document.getElementById('btn-join-confirm');
  const errorEl   = document.getElementById('join-form-error');

  confirmBtn.disabled = true;
  confirmBtn.textContent = '참여 중...';

  try {
    const res  = await fetch(`${COMMUNITY_API}/api/community/groups/join`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body:    JSON.stringify({ code, nickname: document.getElementById('input-join-nickname').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '오류가 발생했습니다.');

    closeJoinGroupModal();
    await refreshGroupList();
    showCommunityChat(data.groupId);
  } catch (e) {
    showToast('그룹 참여 실패', e.message, 'error');
    closeJoinGroupModal();
  }
});

/* ══════════════════════════════════════════════════
   Community: 그룹 생성 모달
   ══════════════════════════════════════════════════ */
const modalCreateGroup = document.getElementById('modal-create-group');
const modalStepForm    = document.getElementById('modal-step-form');
const modalStepDone    = document.getElementById('modal-step-done');

function openCreateGroupModal() {
  document.getElementById('input-group-name').value = '';
  document.getElementById('input-nickname').value = '';
  document.getElementById('modal-form-error').classList.add('hidden');
  document.getElementById('btn-create-submit').disabled = false;
  document.getElementById('btn-create-submit').textContent = '생성하기';
  modalStepForm.classList.remove('hidden');
  modalStepDone.classList.add('hidden');
  modalCreateGroup.classList.remove('hidden');
  modalCreateGroup.classList.add('flex');
  document.getElementById('input-group-name').focus();
}

function closeCreateGroupModal() {
  modalCreateGroup.classList.add('hidden');
  modalCreateGroup.classList.remove('flex');
}

document.getElementById('btn-group-create')?.addEventListener('click', openCreateGroupModal);

document.getElementById('btn-modal-close')?.addEventListener('click', () => {
  closeCreateGroupModal();
  refreshGroupList();
});

modalCreateGroup?.addEventListener('click', e => {
  if (e.target === modalCreateGroup) {
    closeCreateGroupModal();
    refreshGroupList();
  }
});

document.getElementById('btn-create-submit')?.addEventListener('click', async () => {
  const groupName  = document.getElementById('input-group-name').value.trim();
  const nickname   = document.getElementById('input-nickname').value.trim();
  const errorEl    = document.getElementById('modal-form-error');
  const submitBtn  = document.getElementById('btn-create-submit');

  if (!groupName || !nickname) {
    errorEl.textContent = '그룹 이름과 닉네임을 모두 입력해주세요.';
    errorEl.classList.remove('hidden');
    return;
  }
  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  submitBtn.textContent = '생성 중...';

  try {
    const res  = await fetch(`${COMMUNITY_API}/api/community/groups`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body:    JSON.stringify({ name: groupName, nickname }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '오류가 발생했습니다.');

    document.getElementById('created-group-name').textContent  = data.name;
    document.getElementById('invite-code-display').textContent = data.code;
    document.getElementById('invite-code-display').dataset.groupId = String(data.groupId);
    modalStepForm.classList.add('hidden');
    modalStepDone.classList.remove('hidden');
  } catch (e) {
    showToast('그룹 생성 실패', e.message, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = '생성하기';
  }
});

document.getElementById('btn-copy-code')?.addEventListener('click', () => {
  const code = document.getElementById('invite-code-display').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.getElementById('btn-copy-code');
    const original = btn.innerHTML;
    btn.innerHTML = '<span class="material-symbols-outlined text-[16px]">check</span> 복사됨';
    btn.classList.add('text-emerald-400', 'border-emerald-400/30', 'bg-emerald-400/10');
    btn.classList.remove('text-[#6046ff]', 'border-[#6046ff]/30', 'bg-[#6046ff]/10');
    setTimeout(() => {
      btn.innerHTML = original;
      btn.classList.remove('text-emerald-400', 'border-emerald-400/30', 'bg-emerald-400/10');
      btn.classList.add('text-[#6046ff]', 'border-[#6046ff]/30', 'bg-[#6046ff]/10');
    }, 2000);
  });
});

document.getElementById('btn-enter-created-group')?.addEventListener('click', () => {
  const createdGroupId = Number(document.getElementById('invite-code-display')?.dataset.groupId || 0);
  closeCreateGroupModal();
  refreshGroupList();
  if (createdGroupId) showCommunityChat(createdGroupId);
});

/* ══════════════════════════════════════════════════
   Community: 그룹 목록 ↔ 채팅 전환
   ══════════════════════════════════════════════════ */
let _communityStream = null;
let _cachedGroupMembers = null;
let _memberGridTimer = null;
let _memberStatsRefreshTimer = null;
const modalMemberStats = document.getElementById('modal-member-stats');
const memberStatsState = {
  member: null,
  stats: null,
  activeProject: null,
};

const SESSION_COLORS = ['#6046ff', '#45dfa4', '#ff6b6b', '#ffd93d', '#6bcfff', '#ff9f43'];
// 멤버의 프로젝트 목록 전체를 보고 충돌 없이 색상 배분
function buildProjectColorMap(projects) {
  const used = new Set();
  const result = new Map();
  for (const project of projects) {
    if (!project || result.has(project)) continue;
    let hash = 0;
    for (let i = 0; i < project.length; i++) hash = (hash * 31 + project.charCodeAt(i)) & 0xffffffff;
    const startIdx = Math.abs(hash) % SESSION_COLORS.length;
    let assigned = SESSION_COLORS[startIdx];
    for (let i = 0; i < SESSION_COLORS.length; i++) {
      const candidate = SESSION_COLORS[(startIdx + i) % SESSION_COLORS.length];
      if (!used.has(candidate)) { assigned = candidate; break; }
    }
    used.add(assigned);
    result.set(project, assigned);
  }
  return result;
}

function showCommunityGroups() {
  if (_communityStream) { _communityStream.close(); _communityStream = null; }
  if (_memberGridTimer) { clearInterval(_memberGridTimer); _memberGridTimer = null; }
  _cachedGroupMembers = null;
  document.getElementById('community-groups')?.classList.remove('hidden');
  document.getElementById('community-chat')?.classList.add('hidden');
}


function getMemberStatus(m) {
  if (!m.isOnline) return { label: 'IDLE', color: '#6b7280', bg: 'rgba(107,114,128,0.15)', trend: 'FLAT' };

  const act = (m.sessionActivity || []).flatMap(sa => sa.tokens || []);
  if (act.length < 3) return { label: 'CONNECTED', color: '#45dfa4', bg: 'rgba(69,223,164,0.12)', trend: 'NOMINAL' };

  const half  = Math.floor(act.length / 2);
  const first = act.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const last  = act.slice(half).reduce((a, b) => a + b, 0) / (act.length - half);
  const max   = Math.max(...act);
  const min   = Math.min(...act);
  const variance = (max - min) / (max || 1);
  const recentPeak = Math.max(...act.slice(-10), 0);

  if (variance > 0.65 && recentPeak >= 3)
    return { label: 'ACTIVE',      color: '#45dfa4', bg: 'rgba(69,223,164,0.12)',  trend: 'ERRATIC' };
  if (last > Math.max(first * 1.35, 0.5))
    return { label: 'PROCESSING',  color: '#f59e0b', bg: 'rgba(245,158,11,0.12)', trend: 'RISING' };
  if (first > 0 && last < first * 0.65)
    return { label: 'SYNCING',     color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', trend: 'STEADY' };
  return   { label: 'CONNECTED',   color: '#45dfa4', bg: 'rgba(69,223,164,0.12)',  trend: 'NOMINAL' };
}

function renderOverlaidSparklines(sessionActivities, uid, colorMap) {
  if (!sessionActivities || sessionActivities.length === 0) {
    return '<div class="flex-1 flex items-center justify-center text-[9px] font-mono text-slate-700">no data</div>';
  }
  const W = 200, H = 64, pad = 4;
  const allTokens = sessionActivities.flatMap(sa => sa.tokens || []);
  const max = Math.max(...allTokens, 1);

  const defs = sessionActivities.map((sa, i) => {
    const color = colorMap.get(sa.project) || SESSION_COLORS[0];
    return `<linearGradient id="sg_${uid}_${i}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${color}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient>`;
  }).join('');

  const layers = sessionActivities.map((sa, i) => {
    const color = colorMap.get(sa.project) || SESSION_COLORS[0];
    const activity = sa.tokens || [];
    if (activity.length < 2) return '';
    const pts = activity.map((v, j) => {
      const x = pad + (j / (activity.length - 1)) * (W - pad * 2);
      const ratio = max > 0 ? Number(v || 0) / max : 0;
      const y = H - pad - (ratio * (H - pad * 2));
      return [x, y, v];
    });
    // 비어있는 버킷은 건너뛰고 실제 데이터 포인트끼리만 연결
    const dataPts = pts.filter(([,, v]) => v > 0).map(([x, y]) => [x, y]);
    if (dataPts.length === 0) return '';
    const polyline = dataPts.map(([x, y]) => `${x},${y}`).join(' ');
    const fillPath = [`M ${dataPts[0][0]},${H}`, ...dataPts.map(([x, y]) => `L ${x},${y}`), `L ${dataPts[dataPts.length - 1][0]},${H}`, 'Z'].join(' ');
    return `
      <path d="${fillPath}" fill="url(#sg_${uid}_${i})"/>
      <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%;display:block">
    <defs>${defs}</defs>${layers}
  </svg>`;
}

function renderMemberCard(m) {
  const status  = getMemberStatus(m);
  const glowVia = m.isOnline ? 'via-[#45dfa4]/30' : 'via-[#252838]/60';
  const allProjects = [...new Set([
    ...(m.sessionActivity || []).map(sa => sa.project),
    ...(m.activeProjects || []),
  ])].filter(Boolean);
  const colorMap = buildProjectColorMap(allProjects);

  return `
    <div class="member-card bg-[#0b0c17] border border-[#1e2030] rounded-xl p-3.5 flex flex-col gap-2.5
                hover:border-[#6046ff]/50 transition-all duration-200 cursor-pointer relative overflow-hidden"
         data-member-id="${m.memberId}">

      <div class="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent ${glowVia} to-transparent"></div>

      <!-- 헤더 -->
      <div class="flex items-start gap-2.5">
        <div class="relative flex-shrink-0">
          <div class="w-10 h-10 rounded-lg bg-[#13151f] border border-[#252838] flex items-center justify-center overflow-hidden">
            <img src="/img/mascot_waiting.png" alt="mascot"
                 class="w-8 h-8 object-contain ${m.isOnline ? '' : 'opacity-30 grayscale'}">
          </div>
          <span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#0b0c17]"
                style="background:${m.isOnline ? '#45dfa4' : '#374151'}"></span>
        </div>
        <div class="flex-1 min-w-0 pt-0.5">
          <div class="text-[13px] font-bold text-slate-200 font-mono truncate leading-tight">${escapeHtml(m.nickname)}</div>
          <span class="inline-block mt-1 px-1.5 py-px rounded text-[9px] font-mono font-bold tracking-widest"
                style="background:${status.bg};color:${status.color}">${status.label}</span>
        </div>
        <div class="flex-shrink-0 pt-0.5">
          <span class="text-[9px] font-mono text-slate-600 tracking-widest">TREND:&nbsp;<span class="text-slate-400">${status.trend}</span></span>
        </div>
      </div>

      <div class="h-px bg-[#1e2030]"></div>

      <!-- 바디: 차트(좌) + 지표(우) -->
      <div class="flex gap-2.5 flex-1 min-h-0" style="min-height:80px">

        <!-- Activity 차트 (세션별) -->
        <div class="flex flex-col gap-1 flex-1 min-w-0">
          <span class="text-[8px] font-mono text-slate-600 uppercase tracking-widest">Token Usage · Last 60 Min</span>
          <div class="flex-1 min-h-0">
            ${renderOverlaidSparklines(m.sessionActivity, m.memberId, colorMap)}
          </div>
          <div class="flex items-center justify-between text-[8px] font-mono text-slate-600 uppercase tracking-widest">
            <span>60m ago</span>
            <span>now</span>
          </div>
        </div>

        <!-- 지표 박스 -->
        <div class="flex flex-col gap-1.5" style="width:38%">
          <div class="bg-[#13151f] border border-[#1e2030] rounded-lg px-2.5 py-2 flex flex-col flex-1">
            <span class="text-[8px] font-mono text-slate-600 uppercase tracking-widest">Tool Calls</span>
            <span class="text-[22px] font-bold font-mono text-[#c6bfff] leading-none mt-0.5">${m.toolCallCount.toLocaleString()}</span>
          </div>
          <div class="bg-[#13151f] border border-[#1e2030] rounded-lg px-2.5 py-2 flex flex-col flex-1">
            <span class="text-[8px] font-mono text-slate-600 uppercase tracking-widest">Active Sessions</span>
            <span class="text-[22px] font-bold font-mono text-[#c6bfff] leading-none mt-0.5">${(m.activeSessionCount ?? 0).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <!-- Active Projects (세션 색상 매칭) -->
      <div class="flex flex-wrap gap-1 min-w-0">
        ${(m.activeProjects && m.activeProjects.length > 0)
          ? m.activeProjects.map(p => {
              const color = colorMap.get(p) || SESSION_COLORS[0];
              return `<span class="px-1.5 py-0.5 rounded text-[9px] font-mono truncate max-w-full"
                style="background:${color}18;border:1px solid ${color}40;color:${color}">${escapeHtml(p)}</span>`;
            }).join('')
          : `<span class="text-[9px] font-mono text-slate-600">—</span>`
        }
      </div>

    </div>`;
}

function renderMemberGrid(members) {
  const grid = document.getElementById('member-grid');
  if (!grid) return;

  if (!members || members.length === 0) {
    grid.innerHTML = `
      <div class="col-span-3 flex flex-col items-center justify-center text-slate-600 gap-3 py-16">
        <img src="/img/mascot_waiting.png" alt="대기 중" class="w-16 h-16 object-contain opacity-20">
        <span class="text-xs">멤버가 없습니다.</span>
      </div>`;
    return;
  }

  const myId = currentUser?.memberId;
  const sorted = myId
    ? [...members].sort((a, b) => (a.memberId === myId ? -1 : b.memberId === myId ? 1 : 0))
    : members;

  grid.innerHTML = sorted.map(renderMemberCard).join('');

  if (memberStatsState.member) {
    const refreshed = sorted.find((entry) => Number(entry.memberId) === Number(memberStatsState.member.memberId));
    if (refreshed) {
      memberStatsState.member = refreshed;
      if (memberStatsState.stats) renderMemberStatsModal();
      else renderMemberStatsLoading(refreshed);
    }
  }
}

function formatCompactTokens(value) {
  const num = Number(value) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return String(Math.round(num));
}

function getProjectNameFromPath(path) {
  if (!path) return '';
  return String(path).split('/').filter(Boolean).pop() || '';
}

function getMemberStatsSubtitle(member, stats) {
  const latestEventProject = (stats?.recentTokenEvents || [])
    .slice()
    .reverse()
    .find((event) => event?.project)?.project;
  const activeProject = (member?.activeProjects || []).find(Boolean);
  const cwdProject = getProjectNameFromPath(member?.cwd);
  const project = latestEventProject || activeProject || cwdProject;
  return project ? `${project} 현재 작업 중..` : '최근 60분 토큰 활동';
}

function closeMemberStatsModal() {
  memberStatsState.member = null;
  memberStatsState.stats = null;
  memberStatsState.activeProject = null;
  if (_memberStatsRefreshTimer) {
    clearTimeout(_memberStatsRefreshTimer);
    _memberStatsRefreshTimer = null;
  }
  modalMemberStats?.classList.add('hidden');
  modalMemberStats?.classList.remove('flex');
}

function setMemberStatsActiveProject(project) {
  memberStatsState.activeProject = project || null;
  renderMemberStatsModal();
}

function renderMemberStatsLoading(member) {
  if (!modalMemberStats || !member) return;
  document.getElementById('member-stats-title').textContent = `${member.nickname}`;
  document.getElementById('member-stats-subtitle').textContent = getMemberStatsSubtitle(member, null);
  document.getElementById('member-stats-status').textContent = member.isOnline ? 'LIVE' : 'IDLE';
  document.getElementById('member-stats-status').className = `px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-widest border ${
    member.isOnline ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' : 'text-slate-400 bg-slate-500/10 border-slate-500/20'
  }`;
  document.getElementById('member-stats-tool-calls').textContent = (member.toolCallCount || 0).toLocaleString();
  document.getElementById('member-stats-sessions').textContent = (member.activeSessionCount || member.sessionCount || 0).toLocaleString();
  document.getElementById('member-stats-last-active').textContent = member.lastActiveAt ? formatTimeAgo(new Date(member.lastActiveAt).getTime()) : '—';
  document.getElementById('member-stats-project-chips').innerHTML = '';
  document.getElementById('member-stats-chart').innerHTML = `
    <div class="absolute inset-0 flex items-center justify-center text-sm font-mono text-slate-500">
      Loading token activity...
    </div>`;
  document.getElementById('member-stats-events').innerHTML = `
    <div class="rounded-xl border border-dashed border-[#252838] px-4 py-5 text-center text-xs text-slate-500">
      최근 이벤트를 불러오는 중입니다.
    </div>`;
  document.getElementById('member-stats-event-count').textContent = 'loading';
}

function renderMemberStatsModal() {
  const member = memberStatsState.member;
  const stats = memberStatsState.stats;
  if (!modalMemberStats || !member || !stats) return;

  const status = getMemberStatus(member);
  const projectSeries = (stats.projectSeries || member.sessionActivity || []).map((entry) => ({
    project: entry.project,
    tokens: entry.tokens || [],
  })).filter((entry) => entry.project);
  const recentEvents = (stats.recentTokenEvents || []).filter((event) => (Number(event.tokens) || 0) > 0);
  const allProjects = [...new Set(projectSeries.map((entry) => entry.project))];
  const colorMap = buildProjectColorMap(allProjects);
  if (!memberStatsState.activeProject && allProjects.length === 1) {
    memberStatsState.activeProject = allProjects[0];
  }
  const activeProject = memberStatsState.activeProject;

  document.getElementById('member-stats-title').textContent = `${member.nickname}`;
  document.getElementById('member-stats-subtitle').textContent = getMemberStatsSubtitle(member, stats);
  document.getElementById('member-stats-status').textContent = status.label;
  document.getElementById('member-stats-status').className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-widest border';
  document.getElementById('member-stats-status').style.color = status.color;
  document.getElementById('member-stats-status').style.background = status.bg;
  document.getElementById('member-stats-status').style.borderColor = status.color + '30';
  document.getElementById('member-stats-tool-calls').textContent = (stats.toolCallCount || member.toolCallCount || 0).toLocaleString();
  document.getElementById('member-stats-sessions').textContent = (stats.sessionCount || member.sessionCount || 0).toLocaleString();
  document.getElementById('member-stats-last-active').textContent = stats.lastActiveAt ? formatTimeAgo(new Date(stats.lastActiveAt).getTime()) : '—';
  document.getElementById('member-stats-event-count').textContent = `${recentEvents.length} events`;

  const chipsEl = document.getElementById('member-stats-project-chips');
  chipsEl.innerHTML = allProjects.length > 0
    ? allProjects.map((project) => {
        const color = colorMap.get(project) || SESSION_COLORS[0];
        const total = (projectSeries.find((entry) => entry.project === project)?.tokens || []).reduce((sum, value) => sum + Number(value || 0), 0);
        const emphasized = !activeProject || activeProject === project;
        return `<button type="button"
          class="member-stats-project-chip px-3 py-2 rounded-xl border text-left transition-all duration-150 ${emphasized ? 'scale-[1.02]' : ''}"
          data-project="${esc(project)}"
          style="background:${color}${emphasized ? '22' : '10'};border-color:${color}${emphasized ? '66' : '33'};color:${color};opacity:${emphasized ? '1' : '0.55'}">
          <span class="block text-[10px] font-mono uppercase tracking-widest">Project</span>
          <span class="block text-sm font-semibold text-slate-100 mt-1">${escapeHtml(project)}</span>
          <span class="block text-[10px] font-mono mt-1">${formatCompactTokens(total)} tokens</span>
        </button>`;
      }).join('')
    : `<div class="text-xs text-slate-500 font-mono">활성 프로젝트가 없습니다.</div>`;

  const chartEl = document.getElementById('member-stats-chart');
  if (projectSeries.length === 0) {
    chartEl.innerHTML = `
      <div class="absolute inset-0 flex items-center justify-center text-sm font-mono text-slate-500">
        최근 60분 토큰 데이터가 없습니다.
      </div>`;
  } else {
    const width = 640;
    const height = 300;
    const padX = 18;
    const padTop = 18;
    const padBottom = 44;
    const chartHeight = height - padTop - padBottom;
    const maxToken = Math.max(
      1,
      ...projectSeries.flatMap((entry) => entry.tokens || []),
      ...recentEvents.map((event) => Number(event.tokens) || 0)
    );
    const gridLines = [0.25, 0.5, 0.75, 1];
    const windowStart = Date.now() - (60 * 60 * 1000);

    const gridSvg = gridLines.map((ratio) => {
      const y = padTop + chartHeight - (chartHeight * ratio);
      const labelValue = Math.round(maxToken * ratio);
      return `
        <line x1="${padX}" y1="${y}" x2="${width - padX}" y2="${y}" stroke="#252838" stroke-dasharray="4 5"/>
        <text x="${padX + 2}" y="${y - 6}" fill="#667085" font-size="10" font-family="monospace">${formatCompactTokens(labelValue)}</text>`;
    }).join('');

    const xAxisSvg = [60, 50, 40, 30, 20, 10, 0].map((minutesAgo) => {
      const ratio = (60 - minutesAgo) / 60;
      const x = padX + ((width - padX * 2) * ratio);
      const label = minutesAgo === 0 ? 'now' : `${minutesAgo}m`;
      const anchor = minutesAgo === 60 ? 'start' : minutesAgo === 0 ? 'end' : 'middle';
      return `
        <line x1="${x}" y1="${padTop}" x2="${x}" y2="${height - padBottom}" stroke="#1c1f2e" stroke-dasharray="2 4"/>
        <text x="${x}" y="${height - padBottom + 14}" text-anchor="${anchor}" fill="#4b5563" font-size="9" font-family="monospace">${label}</text>`;
    }).join('');

    const projectSvg = projectSeries.map((entry) => {
      const color = colorMap.get(entry.project) || SESSION_COLORS[0];
      const emphasized = !activeProject || activeProject === entry.project;
      const strokeWidth = emphasized ? 3 : 1.8;
      const opacity = emphasized ? 1 : 0.18;
      const points = (entry.tokens || []).map((value, index, arr) => {
        const x = padX + ((width - padX * 2) * (arr.length <= 1 ? 0 : index / (arr.length - 1)));
        const ratio = maxToken > 0 ? (Number(value) || 0) / maxToken : 0;
        const y = padTop + chartHeight - (ratio * chartHeight);
        return { x, y, value: Number(value) || 0 };
      });
      const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
      const area = [`M ${points[0].x},${height - padBottom}`, ...points.map((point) => `L ${point.x},${point.y}`), `L ${points[points.length - 1].x},${height - padBottom}`, 'Z'].join(' ');
      const nonZeroDots = points
        .filter((point) => point.value > 0)
        .map((point) => `<circle cx="${point.x}" cy="${point.y}" r="${emphasized ? 3.2 : 2.2}" fill="${color}" opacity="${opacity}"></circle>`)
        .join('');
      return `
        <g class="member-stats-series" data-project="${esc(entry.project)}" style="cursor:pointer">
          <path d="${area}" fill="${color}" opacity="${emphasized ? '0.14' : '0.04'}"></path>
          <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"></polyline>
          ${nonZeroDots}
        </g>`;
    }).join('');

    const eventSvg = recentEvents.map((event, index) => {
      const ts = new Date(event.ts).getTime();
      if (!Number.isFinite(ts)) return '';
      const ratioX = Math.min(1, Math.max(0, (ts - windowStart) / (60 * 60 * 1000)));
      const x = padX + ((width - padX * 2) * ratioX);
      const ratioY = maxToken > 0 ? (Number(event.tokens) || 0) / maxToken : 0;
      const y = padTop + chartHeight - (ratioY * chartHeight);
      const color = colorMap.get(event.project) || SESSION_COLORS[0];
      const emphasized = !activeProject || activeProject === event.project;
      const labelY = Math.max(padTop + 12, y - 18 - ((index % 2) * 14));
      return `
        <g class="member-stats-event" data-project="${esc(event.project)}" style="cursor:pointer">
          <line x1="${x}" y1="${height - padBottom}" x2="${x}" y2="${y}" stroke="${color}" opacity="${emphasized ? '0.45' : '0.12'}"/>
          <circle cx="${x}" cy="${y}" r="${emphasized ? '4.8' : '3.6'}" fill="${color}" opacity="${emphasized ? '1' : '0.25'}"></circle>
          <rect x="${x - 16}" y="${labelY - 12}" width="32" height="16" rx="8" fill="#0b0d15" stroke="${color}" opacity="${emphasized ? '1' : '0.35'}"></rect>
          <text x="${x}" y="${labelY}" text-anchor="middle" fill="${emphasized ? '#f8fafc' : '#94a3b8'}" font-size="9" font-family="monospace">${formatCompactTokens(event.tokens)}</text>
        </g>`;
    }).join('');

    chartEl.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" class="w-full h-full overflow-visible">
        ${xAxisSvg}
        ${gridSvg}
        ${projectSvg}
        ${eventSvg}
      </svg>`;
  }

  const eventsEl = document.getElementById('member-stats-events');
  eventsEl.innerHTML = recentEvents.length > 0
    ? [...recentEvents].reverse().map((event) => {
        const color = colorMap.get(event.project) || SESSION_COLORS[0];
        const emphasized = !activeProject || activeProject === event.project;
        return `
          <button type="button"
            class="member-stats-event-item w-full rounded-xl border px-3 py-3 text-left transition-colors"
            data-project="${esc(event.project)}"
            style="border-color:${color}${emphasized ? '55' : '22'};background:${emphasized ? '#121725' : '#0d1018'};opacity:${emphasized ? '1' : '0.58'}">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="w-2 h-2 rounded-full" style="background:${color}"></span>
                  <span class="text-xs font-semibold text-slate-200 truncate">${escapeHtml(event.project || 'unknown')}</span>
                </div>
                <p class="text-[10px] font-mono text-slate-500 mt-1">${esc(event.hookEventName || 'Stop')} · ${formatTimeAgo(new Date(event.ts).getTime())}</p>
              </div>
              <span class="text-sm font-bold font-mono" style="color:${color}">${formatCompactTokens(event.tokens)}</span>
            </div>
          </button>`;
      }).join('')
    : `<div class="rounded-xl border border-dashed border-[#252838] px-4 py-5 text-center text-xs text-slate-500">최근 토큰 이벤트가 없습니다.</div>`;

  chipsEl.querySelectorAll('.member-stats-project-chip').forEach((chip) => {
    chip.addEventListener('mouseenter', () => setMemberStatsActiveProject(chip.dataset.project));
    chip.addEventListener('focus', () => setMemberStatsActiveProject(chip.dataset.project));
    chip.addEventListener('mouseleave', () => setMemberStatsActiveProject(null));
  });
  chartEl.querySelectorAll('.member-stats-series, .member-stats-event').forEach((node) => {
    node.addEventListener('mouseenter', () => setMemberStatsActiveProject(node.dataset.project));
    node.addEventListener('mouseleave', () => setMemberStatsActiveProject(null));
  });
  eventsEl.querySelectorAll('.member-stats-event-item').forEach((item) => {
    item.addEventListener('mouseenter', () => setMemberStatsActiveProject(item.dataset.project));
    item.addEventListener('mouseleave', () => setMemberStatsActiveProject(null));
  });
}

async function openMemberStatsModal(memberId) {
  const member = (_cachedGroupMembers || []).find((entry) => Number(entry.memberId) === Number(memberId));
  if (!member || !modalMemberStats) return;
  memberStatsState.member = member;
  memberStatsState.stats = null;
  memberStatsState.activeProject = null;
  renderMemberStatsLoading(member);
  modalMemberStats.classList.remove('hidden');
  modalMemberStats.classList.add('flex');

  try {
    const res = await fetch(`${COMMUNITY_API}/api/metrics/members/${memberId}/stats`, { credentials: 'include' });
    if (!res.ok) throw new Error('failed');
    const stats = await res.json();
    memberStatsState.stats = stats;
    renderMemberStatsModal();
  } catch (_) {
    document.getElementById('member-stats-chart').innerHTML = `
      <div class="absolute inset-0 flex items-center justify-center text-sm font-mono text-rose-400">
        상세 데이터를 불러오지 못했습니다.
      </div>`;
  }
}

function scheduleMemberStatsRefresh(delay = 150) {
  const memberId = memberStatsState.member?.memberId;
  if (!memberId || !memberStatsState.stats) return;
  if (_memberStatsRefreshTimer) clearTimeout(_memberStatsRefreshTimer);

  _memberStatsRefreshTimer = setTimeout(async () => {
    _memberStatsRefreshTimer = null;
    const activeMemberId = memberStatsState.member?.memberId;
    if (!activeMemberId || Number(activeMemberId) !== Number(memberId)) return;

    try {
      const res = await fetch(`${COMMUNITY_API}/api/metrics/members/${memberId}/stats`, { credentials: 'include' });
      if (!res.ok) return;
      const stats = await res.json();
      if (Number(memberStatsState.member?.memberId) !== Number(memberId)) return;
      memberStatsState.stats = stats;
      renderMemberStatsModal();
    } catch (_) {}
  }, delay);
}

document.getElementById('member-grid')?.addEventListener('click', (e) => {
  const card = e.target.closest('.member-card');
  if (!card) return;
  const memberId = Number(card.dataset.memberId);
  if (memberId) openMemberStatsModal(memberId);
});

document.getElementById('btn-member-stats-close')?.addEventListener('click', closeMemberStatsModal);
modalMemberStats?.addEventListener('click', (e) => {
  if (e.target === modalMemberStats) closeMemberStatsModal();
});

function showCommunityChat(groupId) {
  document.getElementById('community-groups')?.classList.add('hidden');
  document.getElementById('community-chat')?.classList.remove('hidden');

  if (_communityStream) { _communityStream.close(); _communityStream = null; }
  if (_memberGridTimer) { clearInterval(_memberGridTimer); _memberGridTimer = null; }

  _communityStream = new EventSource(
    `${COMMUNITY_API}/api/metrics/groups/${groupId}/sse`,
    { withCredentials: true }
  );
  function resetMemberGridTimer() {
    if (_memberGridTimer) { clearInterval(_memberGridTimer); _memberGridTimer = null; }
    _memberGridTimer = setInterval(() => {
      if (!_cachedGroupMembers) return;
      _cachedGroupMembers = _cachedGroupMembers.map(m => ({
        ...m,
        sessionActivity: (m.sessionActivity || []).map(sa => ({
          ...sa,
          tokens: [...(sa.tokens || []).slice(1), 0],
        })),
      }));
      renderMemberGrid(_cachedGroupMembers);
    }, 60000);
  }

  _communityStream.addEventListener('message', e => {
    try {
      _cachedGroupMembers = JSON.parse(e.data);
      renderMemberGrid(_cachedGroupMembers);
      scheduleMemberStatsRefresh();
      resetMemberGridTimer();
    } catch (_) {}
  });
  _communityStream.onerror = () => {};

  resetMemberGridTimer();
}

document.getElementById('view-community')?.addEventListener('click', e => {
  const enterBtn = e.target.closest('.btn-group-enter');
  if (enterBtn) {
    const card = enterBtn.closest('[data-group-id]');
    const groupId = Number(card?.dataset.groupId);
    if (groupId) showCommunityChat(groupId);
  }
  if (e.target.closest('#btn-group-back')) showCommunityGroups();
});

function formatTimeRemaining(ms) {
  if (!Number.isFinite(ms)) return '리셋 정보 없음';
  const totalSecs = Math.floor(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (totalSecs <= 0) return '이제 다시 쓸 수 있어요! 🥳 메시지를 보내면 리셋됩니다.';
  if (totalSecs < 60) return '곧 리셋';
  
  if (days > 0) return `${days}일 ${hours}시간 후 리셋`;
  if (hours > 0) return `${hours}시간 ${mins}분 후 리셋`;
  return `${mins}분 후 리셋`;
}

function getBarColor(percent) {
  if (percent >= 90) return 'bg-[#ef4444]'; // red
  if (percent >= 70) return 'bg-[#f97316]'; // orange
  return 'bg-[#6046ff]'; // purple
}

/* ── Usage tab: model color map ─────────────────── */
const MODEL_COLORS = [
  { prefix: 'Opus',   color: '#a78bfa' },
  { prefix: 'Sonnet', color: '#6046ff' },
  { prefix: 'Haiku',  color: '#312e81' },
];
function modelColor(name) {
  const m = MODEL_COLORS.find(c => name.startsWith(c.prefix));
  return m ? m.color : '#6b7280';
}

let usageLastUpdatedAt = 0;
let usageBadgeTimer = null;

function toLocalDateKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatUsageUpdatedAgo(ts) {
  if (!Number.isFinite(ts)) return '갱신 정보 없음';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return '방금 전 갱신';
  if (diff < 60) return `${diff}초 전 갱신`;
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전 갱신`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전 갱신`;
  return `${Math.floor(diff / 86400)}일 전 갱신`;
}

function updateUsageRefreshBadges() {
  const label = formatUsageUpdatedAgo(usageLastUpdatedAt);
  const html = `<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span>${esc(label)}`;
  const weeklyBadge = document.getElementById('usage-weekly-updated-at');
  const chartBadge = document.getElementById('usage-chart-updated-at');
  const projectBadge = document.getElementById('usage-project-updated-at');
  if (weeklyBadge) weeklyBadge.innerHTML = html;
  if (chartBadge) chartBadge.innerHTML = html;
  if (projectBadge) projectBadge.innerHTML = html;
}

function positionUsageBadgeTooltip(tooltip, badge) {
  const rect = badge.getBoundingClientRect();
  const gap = 8;
  const left = Math.max(8, rect.left - tooltip.offsetWidth - gap);
  const top = Math.max(8, rect.top - tooltip.offsetHeight - gap);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

/* ── Build last-7-days rows from API daily state ── */
function buildDailyRows(daily) {
  const rows = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = toLocalDateKey(d);
    const mm  = String(d.getMonth() + 1).padStart(2, '0');
    const dd  = String(d.getDate()).padStart(2, '0');
    const dayLabel = ['SUN','MON','TUE','WED','THU','FRI','SAT'][d.getDay()];
    rows.push({ key, label: `${mm}/${dd}`, dayLabel, models: daily[key] || {} });
  }
  return rows;
}

function normalizePathForCompare(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

function getActiveUsageSessions(projectPath) {
  const normalizedProjectPath = normalizePathForCompare(projectPath);
  return [...sessions.values()].filter((sess) => {
    if (!sess || sess.status === 'ended') return false;
    return normalizePathForCompare(sess.cwd) === normalizedProjectPath;
  });
}

function getLiveUsageProjectActivity(projectPath) {
  const activeSessions = getActiveUsageSessions(projectPath);
  if (activeSessions.length === 0) return null;
  return Math.max(...activeSessions.map(sess => sess.lastActivityAt || sess.startedAt || 0));
}

function getLiveUsageSessionActivity(projectPath, usageSession) {
  const activeSessions = getActiveUsageSessions(projectPath);
  if (activeSessions.length === 0) return null;
  const usageSessionId = usageSession?.sessionId || null;
  const matchedById = usageSessionId
    ? activeSessions.filter(sess => sess.sid === usageSessionId || sess.pid === usageSessionId)
    : [];
  if (matchedById.length > 0) {
    return Math.max(...matchedById.map(sess => sess.lastActivityAt || sess.startedAt || 0));
  }
  const sessionName = usageSession?.sessionName || '';
  const matched = activeSessions.filter(sess => (sess.name || '').trim() === sessionName.trim());
  const source = matched.length > 0 ? matched : [];
  if (source.length === 0) return null;
  return Math.max(...source.map(sess => sess.lastActivityAt || sess.startedAt || 0));
}

function formatUsageLastActivity(isoOrTs) {
  if (!isoOrTs) return '—';
  const ts = typeof isoOrTs === 'number' ? isoOrTs : new Date(isoOrTs).getTime();
  if (!Number.isFinite(ts)) return '—';
  return formatTimeAgo(ts);
}

function getResetMs(resetsAt) {
  if (!resetsAt) return NaN;
  return new Date(resetsAt).getTime() - Date.now();
}

function renderUsageTab(data) {
  usageLastUpdatedAt = data?.updatedAt ? new Date(data.updatedAt).getTime() : NaN;
  updateUsageRefreshBadges();
  if (!usageBadgeTimer) {
    usageBadgeTimer = setInterval(updateUsageRefreshBadges, 10000);
  }

  /* ── 플랜 소진율 ──────────────────────────────── */
  const p5h = data?.rateLimits?.fiveHour || {};
  const p7d = data?.rateLimits?.sevenDay || {};
  const plan5hBar     = document.getElementById('plan-5h-bar');
  const plan5hPercent = document.getElementById('plan-5h-percent');
  const plan5hReset   = document.getElementById('plan-5h-reset');
  const plan7dBar     = document.getElementById('plan-7d-bar');
  const plan7dPercent = document.getElementById('plan-7d-percent');
  const plan7dReset   = document.getElementById('plan-7d-reset');
  const p5hUsedPercent = Number.isFinite(p5h.usedPercentage) ? p5h.usedPercentage : 0;
  const p7dUsedPercent = Number.isFinite(p7d.usedPercentage) ? p7d.usedPercentage : 0;
  plan5hPercent.textContent = `${Math.round(p5hUsedPercent)}%`;
  plan5hBar.style.width = `${Math.max(0, Math.min(100, p5hUsedPercent))}%`;
  plan5hBar.className = `h-full rounded-full ${getBarColor(p5hUsedPercent)}`;
  plan5hReset.textContent = formatTimeRemaining(getResetMs(p5h.resetsAt));
  plan7dPercent.textContent = `${Math.round(p7dUsedPercent)}%`;
  plan7dBar.style.width = `${Math.max(0, Math.min(100, p7dUsedPercent))}%`;
  plan7dBar.className = `h-full rounded-full ${getBarColor(p7dUsedPercent)}`;
  plan7dReset.textContent = formatTimeRemaining(getResetMs(p7d.resetsAt));

  /* ── 일별 스택 막대 ────────────────────────────── */
  const daily          = data?.daily || {};
  const dailyRows      = buildDailyRows(daily);
  const allModelNames  = [...new Set(dailyRows.flatMap(r => Object.keys(r.models)))];
  const maxTok = Math.max(1, ...dailyRows.map(r => Object.values(r.models).reduce((s, v) => s + Number(v), 0)));

  const chartContainer = document.getElementById('chart-stacked-bars');
  chartContainer.innerHTML = dailyRows.map(row => {
    const total   = Object.values(row.models).reduce((s, v) => s + v, 0);
    const bars = allModelNames.map(model => {
      const tokens = row.models[model] || 0;
      if (!tokens) return '';
      const heightPct = (tokens / maxTok) * 100;
      const color = modelColor(model);
      return `<div class="w-full cursor-pointer chart-bar"
        style="height: ${heightPct}%; background: ${color};"
        data-model="${esc(model)}" data-tokens="${tokens}" data-color="${color}"></div>`;
    }).join('');
    return `
      <div class="flex-1 flex flex-col items-center">
        <div class="w-2/5 h-48 mx-auto flex flex-col-reverse gap-0.5 mb-2">
          ${total > 0 ? bars : ''}
        </div>
        <span class="text-[10px] font-mono text-slate-500">${row.label}</span>
        <span class="text-[8px] text-slate-600">${row.dayLabel}</span>
      </div>`;
  }).join('');

  /* ── 범례 동적 업데이트 ───────────────────────── */
  const legendEl = document.getElementById('chart-legend');
  if (legendEl && allModelNames.length > 0) {
    legendEl.innerHTML = allModelNames.map(m =>
      `<div class="flex items-center gap-2">
        <div class="w-3 h-3 rounded-sm" style="background:${modelColor(m)}"></div>
        <span class="text-xs text-slate-400">${esc(m)}</span>
      </div>`
    ).join('');
  }

  /* ── 프로젝트 테이블 ───────────────────────────── */
  const rawProjects = data?.projects || {};
  document.getElementById('stat-weekly-sessions').textContent = data?.weeklySessionCount ?? 0;
  const projectEntries = Object.entries(rawProjects)
    .sort((a, b) => (b[1].lastActivity || '') > (a[1].lastActivity || '') ? 1 : -1);

  const tableBody = document.getElementById('project-table-body');

  const openProjects = new Set();
  tableBody.querySelectorAll('.project-row').forEach(row => {
    const firstDetail = row.nextElementSibling;
    if (firstDetail && !firstDetail.classList.contains('hidden')) {
      openProjects.add(row.dataset.projPath);
    }
  });

  if (projectEntries.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-slate-600 text-xs">데이터 없음 — JSONL 파싱 중이거나 사용 기록이 없습니다</td></tr>`;
  } else {
    tableBody.innerHTML = projectEntries.flatMap(([projPath, proj]) => {
      const projName   = projPath.split('/').filter(Boolean).pop() || projPath;
      const cacheEff   = proj.cacheEfficiency != null ? Math.round(proj.cacheEfficiency * 100) : null;
      const cacheLabel = cacheEff != null ? `${cacheEff}%` : '—';
      const cacheClass = cacheEff != null && cacheEff >= 70 ? 'text-emerald-400' : 'text-slate-400';
      const liveProjectActivity = getLiveUsageProjectActivity(projPath);
      const hasLiveProjectActivity = Number.isFinite(liveProjectActivity) && liveProjectActivity > 0;
      const sessArr    = Object.values(proj.sessions || {})
        .sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);

      const headerRow = `
        <tr class="hover:bg-[#1c1f2e] cursor-pointer project-row" data-session-count="${sessArr.length + 1}" data-proj-path="${esc(projPath)}">
          <td class="px-6 py-3 text-slate-300 flex items-center gap-2">
            <span class="material-symbols-outlined text-[14px] transition-transform accordion-arrow">chevron_right</span>
            ${esc(projName)}
          </td>
          <td class="px-6 py-3 text-right text-slate-300 font-mono">${((proj.totalTokens || 0) / 1000).toFixed(1)}K</td>
          <td class="px-6 py-3 text-right text-slate-300">${proj.sessionCount || 0}</td>
          <td class="px-6 py-3 text-right"><span class="font-mono ${cacheClass}">${cacheLabel}</span></td>
          <td class="px-6 py-3 text-right text-slate-500 text-xs">${hasLiveProjectActivity ? '실시간' : formatUsageLastActivity(proj.lastActivity)}</td>
        </tr>`;

      const subheaderRow = `
        <tr class="session-detail hidden border-t border-[#252838]/30">
          <td class="px-6 py-1.5 pl-12 text-[10px] font-bold text-slate-600 uppercase tracking-widest">세션 (최초 명령어)</td>
          <td class="px-6 py-1.5 text-right text-[10px] font-bold text-slate-600 uppercase tracking-widest">사용 토큰</td>
          <td class="px-6 py-1.5 text-right text-[10px] font-bold text-slate-600 uppercase tracking-widest">최근 사용 모델</td>
          <td class="px-6 py-1.5 text-right text-[10px] font-bold text-slate-600 uppercase tracking-widest">캐시 효율</td>
          <td class="px-6 py-1.5 text-right text-[10px] font-bold text-slate-600 uppercase tracking-widest">마지막 활동</td>
        </tr>`;

      const sessionRows = sessArr.map(sess => {
        const sessCacheEff = sess.cacheEfficiency != null ? Math.round(sess.cacheEfficiency * 100) : null;
        const liveSessionActivity = getLiveUsageSessionActivity(projPath, sess);
        const hasLiveSessionActivity = Number.isFinite(liveSessionActivity) && liveSessionActivity > 0;
        const lastAct = hasLiveSessionActivity ? '실시간' : formatUsageLastActivity(sess.lastActivity);
        const sessionLabel = sess.sessionName || sess.name || '—';
        const sessionLabelDisplay = sessionLabel === '—' ? sessionLabel : sessionLabel + '...';
        const sessionIdShort = (sess.sessionId || '').slice(0, 8);
        return `
          <tr class="session-detail hidden bg-[#0d0e15]">
            <td class="px-6 py-2 pl-12">
              <div class="text-slate-400 text-xs font-mono">${esc(sessionLabelDisplay)}</div>
              ${sessionIdShort ? `<div class="text-[10px] text-slate-600 font-mono mt-0.5">${esc(sessionIdShort)}</div>` : ''}
            </td>
            <td class="px-6 py-2 text-right text-slate-400 text-xs font-mono">${((sess.tokens || 0) / 1000).toFixed(1)}K</td>
            <td class="px-6 py-2 text-right text-slate-400 text-xs whitespace-nowrap">${esc(sess.model || '—')}</td>
            <td class="px-6 py-2 text-right text-slate-400 text-xs font-mono">${sessCacheEff != null ? sessCacheEff + '%' : '—'}</td>
            <td class="px-6 py-2 text-right text-slate-400 text-xs font-mono whitespace-nowrap">${lastAct}</td>
          </tr>`;
      }).join('');

      return headerRow + subheaderRow + sessionRows;
    }).join('');
  }

  /* ── 아코디언 상태 복원 ──────────────────────────── */
  if (openProjects.size > 0) {
    tableBody.querySelectorAll('.project-row').forEach(row => {
      if (!openProjects.has(row.dataset.projPath)) return;
      const count = parseInt(row.dataset.sessionCount) || 0;
      let cur = row.nextElementSibling;
      let n = 0;
      while (cur && cur.classList.contains('session-detail') && n < count) {
        cur.classList.remove('hidden');
        n++;
        cur = cur.nextElementSibling;
      }
      const arrow = row.querySelector('.accordion-arrow');
      if (arrow) arrow.style.transform = 'rotate(90deg)';
    });
  }

  /* ── 프로젝트 행 accordion ─────────────────────── */
  document.querySelectorAll('.project-row').forEach(row => {
    row.addEventListener('click', () => {
      const count = parseInt(row.dataset.sessionCount) || 0;
      let cur = row.nextElementSibling;
      let n = 0;
      let hadHidden = false;
      while (cur && cur.classList.contains('session-detail') && n < count) {
        if (cur.classList.contains('hidden')) hadHidden = true;
        cur.classList.toggle('hidden');
        n++;
        cur = cur.nextElementSibling;
      }
      const arrow = row.querySelector('.accordion-arrow');
      if (arrow) arrow.style.transform = hadHidden ? 'rotate(90deg)' : 'rotate(0deg)';
    });
  });

  /* ── 차트 툴팁 ─────────────────────────────────── */
  let tooltip = document.getElementById('chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'chart-tooltip';
    tooltip.className = 'fixed hidden text-[11px] leading-snug text-[#f1f5f9] z-50 pointer-events-none max-w-[320px] whitespace-normal';
    tooltip.style.cssText = 'background:#1c1f2e;border:1px solid #252838;border-radius:6px;padding:6px 10px;';
    document.body.appendChild(tooltip);
  }
  document.querySelectorAll('.chart-bar').forEach(bar => {
    bar.addEventListener('mouseenter', () => {
      const color  = bar.dataset.color;
      const model  = bar.dataset.model;
      const tokens = parseInt(bar.dataset.tokens);
      tooltip.innerHTML = `<span style="color:${color};margin-right:6px;font-size:10px;">●</span>${esc(model)}: ${tokens.toLocaleString()}`;
      tooltip.classList.remove('hidden');
    });
    bar.addEventListener('mousemove', (e) => {
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top  = (e.clientY - 12) + 'px';
    });
    bar.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });

  document.querySelectorAll('.usage-badge-tooltip').forEach((badge) => {
    if (badge.dataset.tooltipBound === 'true') return;
    badge.dataset.tooltipBound = 'true';
    badge.addEventListener('mouseenter', () => {
      tooltip.innerHTML = esc(badge.dataset.tooltipContent || '');
      tooltip.classList.remove('hidden');
      positionUsageBadgeTooltip(tooltip, badge);
    });
    badge.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
  });
}

/* ── Usage SSE + snapshot ────────────────────────── */

function loadUsageSnapshot() {
  fetch('/api/usage/snapshot')
    .then(r => r.json())
    .then(renderUsageTab)
    .catch(() => renderUsageTab(null));
}
