'use strict';

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
  });
});

/* ══════════════════════════════════════════════════
   Chat Drawer Toggle
   ══════════════════════════════════════════════════ */
const chatDrawer = document.getElementById('chat-drawer');
document.getElementById('btn-chat-toggle')?.addEventListener('click', () => chatDrawer?.classList.toggle('closed'));
document.getElementById('btn-chat-close')?.addEventListener('click', () => chatDrawer?.classList.add('closed'));

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
  if (e.type === 'tool_use' && e.pid) {
    sessionLastTool.set(e.pid, { toolName: e.toolName, toolDetail: e.toolDetail || '', ts: e.ts });
    const m = activeMascots.get(e.pid);
    if (m) updateBubble(m, sessions.get(e.pid)?.status || 'idle');
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

function showToast(title, message) {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'pointer-events-auto bg-[#13151f] border border-[#6046ff]/30 rounded-lg p-4 shadow-[0_8px_32px_rgba(96,70,255,0.15)] backdrop-blur-xl max-w-sm animate-slide-in';
  toast.innerHTML = `
    <div class="flex items-start gap-3">
      <span class="material-symbols-outlined text-[#6046ff] text-lg flex-shrink-0 mt-0.5">notifications_active</span>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-bold text-slate-200">${esc(title)}</div>
        <div class="text-[11px] text-slate-400 mt-0.5">${esc(message)}</div>
      </div>
    </div>`;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 5000);
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
    <div class="bg-[#0d0f18] border border-[#252838] rounded-lg p-4 w-[260px] shadow-2xl" onclick="event.stopPropagation()">
      <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-3">작업 타이머 설정</div>
      <div class="text-[10px] text-slate-400 mb-3">${esc(projectName)}</div>
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

  const goalLabel = `${Math.floor(goal.goalMin / 60)}시간` + (goal.goalMin % 60 ? ` ${goal.goalMin % 60}분` : '');
  return `
    <div class="mb-3 goal-timer-live" data-goal-ms="${goalMs}" data-set-at="${setAt}" data-cwd="${esc(projectCwd)}" data-name="${esc(projectName)}">
      <div class="flex items-center justify-between mb-1.5">
        <div class="text-[9px] text-slate-600 uppercase tracking-wider">작업 타이머</div>
        <div class="flex items-center gap-2">
          <button onclick="window._stopTimer('${esc(projectCwd)}'); event.stopPropagation();"
            class="text-[9px] text-red-400 hover:text-red-300 cursor-pointer transition-colors">중지</button>
          <button onclick="showGoalPopup('${esc(projectCwd)}', '${esc(projectName)}', ${goal.goalMin})"
            class="text-[9px] text-slate-500 hover:text-[#6046ff] cursor-pointer transition-colors">수정</button>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-1.5 mb-1.5">
        <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
          <div class="text-[9px] text-slate-500">목표</div>
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
          <div class="h-full rounded-full transition-all duration-1000 gt-bar" style="width:${pct}%"></div>
        </div>
        <span class="text-[10px] font-bold font-mono gt-pct">${Math.floor(pct)}%</span>
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
    if (barEl) {
      barEl.style.width = pct + '%';
      barEl.className = 'h-full rounded-full transition-all duration-1000 gt-bar ' + (isComplete ? 'bg-emerald-500' : 'bg-[#6046ff]');
    }
    if (pctEl) pctEl.textContent = Math.floor(pct) + '%';
    if (elapsedEl) elapsedEl.className = 'text-xs font-bold font-mono gt-elapsed ' + (isComplete ? 'text-emerald-400' : 'text-[#6046ff]');
    if (remainEl) remainEl.className = 'text-xs font-bold font-mono gt-remain ' + (isComplete ? 'text-emerald-400' : 'text-white');
    if (pctEl) pctEl.className = 'text-[10px] font-bold font-mono gt-pct ' + (isComplete ? 'text-emerald-400' : 'text-[#6046ff]');

    // Goal notification
    if (isComplete && !goalNotified.has(el.dataset.cwd)) {
      goalNotified.add(el.dataset.cwd);
      showToast('타이머 완료!', `${el.dataset.name} 작업 타이머가 종료되었어요!`);
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
    const completedSessions = (proj.sessions || []).filter(s => s.endedAt && s.startedAt);
    let avgSessionLen = 0;
    if (completedSessions.length > 0) {
      const totalLen = completedSessions.reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0);
      avgSessionLen = totalLen / completedSessions.length;
    }

    // ── Today's duration ──
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();
    let todayDuration = 0;
    for (const s of (proj.sessions || [])) {
      if ((s.startedAt || 0) >= todayTs) {
        todayDuration += s.endedAt ? (s.endedAt - s.startedAt) : (s.status !== 'ended' ? Date.now() - s.startedAt : 0);
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
    const tasks = (proj.tasks || []).slice(0, 10);
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const totalTasks = tasks.length;
    const taskRows = tasks.map(t => {
      const icon = t.status === 'completed' ? 'check_circle' : t.status === 'in_progress' ? 'pending' : 'radio_button_unchecked';
      const color = t.status === 'completed' ? 'text-emerald-400' : t.status === 'in_progress' ? 'text-amber-400' : 'text-slate-500';
      const textColor = t.status === 'completed' ? 'text-slate-500 line-through' : 'text-slate-300';
      return `
        <div class="flex items-center gap-1.5 text-[10px] py-0.5">
          <span class="material-symbols-outlined text-[12px] ${color}">${icon}</span>
          <span class="${textColor} truncate flex-1">${esc(t.subject)}</span>
        </div>`;
    }).join('');

    // ── Recent sessions ──
    const sessionRows = (proj.sessions || []).slice(0, 5).map(s => {
      const dur = s.endedAt && s.startedAt ? formatDuration(s.endedAt - s.startedAt) : (s.status !== 'ended' ? 'active' : '-');
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
        ${taskRows ? `
        <div class="mb-2">
          <div class="flex items-center justify-between mb-1">
            <div class="text-[9px] text-slate-600 uppercase tracking-wider">작업 목록</div>
            ${totalTasks > 0 ? `<span class="text-[9px] text-slate-500 font-mono">${completedTasks}/${totalTasks}</span>` : ''}
          </div>
          ${taskRows}
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

// Parse a bash command into colored tokens
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

  // Classify each token
  return tokens.map((tok, i) => {
    const e = esc(tok);
    // First token = command
    if (i === 0) return `<span class="text-emerald-400 font-bold">${e}</span>`;
    // Subcommand (second token for git/npm/docker etc, if not a flag)
    if (i === 1 && /^(git|npm|npx|yarn|pnpm|docker|kubectl|cargo|go)$/.test(tokens[0]) && !tok.startsWith('-'))
      return `<span class="text-amber-400">${e}</span>`;
    // Long flags --foo or --foo=bar
    if (tok.startsWith('--'))
      return `<span class="text-sky-400">${e}</span>`;
    // Short flags -x
    if (/^-[a-zA-Z]/.test(tok))
      return `<span class="text-sky-300">${e}</span>`;
    // Pipe, redirect, logical operators
    if (/^[|><&;]+$/.test(tok) || tok === '&&' || tok === '||')
      return `<span class="text-pink-400 font-bold">${e}</span>`;
    // Paths (contains /)
    if (tok.includes('/'))
      return `<span class="text-violet-400">${e}</span>`;
    // Glob patterns
    if (tok.includes('*') || tok.includes('?'))
      return `<span class="text-violet-300">${e}</span>`;
    // Quoted strings
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'")))
      return `<span class="text-yellow-300">${e}</span>`;
    // Default = argument
    return `<span class="text-slate-300">${e}</span>`;
  }).join(' ');
}

function renderBashPanel(data) {
  if (!data) return;
  const { recent, topCommands, categoryCounts, total } = data;

  const totalEl = document.getElementById('bash-total');
  if (totalEl) totalEl.textContent = total.toLocaleString();

  // Categories — compact pills
  const catEl = document.getElementById('bash-categories');
  if (catEl) {
    const catEntries = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
    catEl.innerHTML = catEntries.map(([cat, count]) => {
      const info = categoryLabels[cat] || categoryLabels.other;
      return `<span class="${info.color} px-2 py-0.5 rounded text-[9px] font-bold">${info.label} ${count}</span>`;
    }).join('');
  }

  // Top commands
  const topEl = document.getElementById('bash-top-commands');
  if (topEl && topCommands.length > 0) {
    const maxCount = topCommands[0]?.count || 1;
    topEl.innerHTML = topCommands.slice(0, 10).map(c => {
      const pct = Math.max(5, (c.count / maxCount) * 100);
      return `
        <div class="px-3 py-2 border-b border-[#252838]/20 hover:bg-[#1c1f2e] transition-colors">
          <div class="flex items-center gap-2 text-[10px]">
            <code class="font-mono truncate flex-1" title="${esc(c.command)}">${parseBashTokens(c.command)}</code>
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
  }

  // Recent commands
  const recentEl = document.getElementById('bash-recent');
  if (recentEl && recent.length > 0) {
    recentEl.innerHTML = recent.slice(0, 20).map(c => {
      const time = new Date(c.ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `
        <div class="px-3 py-2 border-b border-[#252838]/20 hover:bg-[#1c1f2e] transition-colors">
          <div class="flex items-center gap-2 text-[10px] mb-0.5">
            <span class="text-slate-600 font-mono flex-shrink-0">${time}</span>
            <span class="text-[#6046ff] text-[9px] flex-shrink-0">${esc(c.project)}</span>
          </div>
          <code class="block font-mono text-[10px] truncate" title="${esc(c.command)}">${parseBashTokens(c.command)}</code>
        </div>`;
    }).join('');
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
   Project Comparison Tab
   ══════════════════════════════════════════════════ */
function renderComparison(projects) {
  const body = document.getElementById('compare-body');
  if (!body || !projects || projects.length === 0) return;

  const maxEvents = Math.max(1, ...projects.map(p => p.totalEvents));
  const maxDuration = Math.max(1, ...projects.map(p => p.totalDuration));
  const maxSessions = Math.max(1, ...projects.map(p => p.totalSessions));

  // Comparison table
  const tableRows = projects.map(proj => {
    const evPct = (proj.totalEvents / maxEvents) * 100;
    const durPct = (proj.totalDuration / maxDuration) * 100;
    const sesPct = (proj.totalSessions / maxSessions) * 100;
    const topTools = Object.entries(proj.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join(', ');
    return `
      <tr class="hover:bg-[#1c1f2e] transition-colors">
        <td class="px-5 py-3">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[14px] text-[#6046ff]">folder</span>
            <span class="text-xs font-bold text-slate-200">${esc(proj.name)}</span>
          </div>
        </td>
        <td class="px-5 py-3">
          <div class="flex items-center gap-2">
            <div class="w-20 h-1.5 bg-[#1c1f2e] rounded-full overflow-hidden">
              <div class="h-full bg-[#6046ff] rounded-full" style="width:${sesPct}%"></div>
            </div>
            <span class="text-xs font-mono text-slate-400">${proj.totalSessions}</span>
          </div>
        </td>
        <td class="px-5 py-3">
          <div class="flex items-center gap-2">
            <div class="w-20 h-1.5 bg-[#1c1f2e] rounded-full overflow-hidden">
              <div class="h-full bg-emerald-500 rounded-full" style="width:${durPct}%"></div>
            </div>
            <span class="text-xs font-mono text-slate-400">${formatDuration(proj.totalDuration)}</span>
          </div>
        </td>
        <td class="px-5 py-3">
          <div class="flex items-center gap-2">
            <div class="w-20 h-1.5 bg-[#1c1f2e] rounded-full overflow-hidden">
              <div class="h-full bg-amber-500 rounded-full" style="width:${evPct}%"></div>
            </div>
            <span class="text-xs font-mono text-slate-400">${proj.totalEvents.toLocaleString()}</span>
          </div>
        </td>
        <td class="px-5 py-3 text-xs text-slate-500 font-mono">${topTools || '-'}</td>
        <td class="px-5 py-3 text-xs text-slate-500">${formatLastActivity(proj.lastActivityTs)}</td>
      </tr>`;
  }).join('');

  body.innerHTML = `
    <div class="bg-[#13151f] border border-[#252838] rounded-xl overflow-hidden mb-8">
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="bg-[#0d0e15] text-slate-500 text-[11px] font-mono uppercase">
            <tr>
              <th class="px-5 py-3 font-medium">프로젝트</th>
              <th class="px-5 py-3 font-medium">세션</th>
              <th class="px-5 py-3 font-medium">사용 시간</th>
              <th class="px-5 py-3 font-medium">이벤트</th>
              <th class="px-5 py-3 font-medium">주요 도구</th>
              <th class="px-5 py-3 font-medium">마지막 활동</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[#252838]/30 text-slate-300">${tableRows}</tbody>
        </table>
      </div>
    </div>

    <!-- Stacked bar comparison -->
    <div class="bg-[#13151f] border border-[#252838] rounded-xl p-6">
      <h3 class="text-white font-headline font-semibold text-sm flex items-center gap-2 mb-4">
        <span class="w-1 h-4 bg-[#6046ff] rounded-full"></span>
        도구 사용 비교
      </h3>
      <div class="space-y-3">${projects.map(proj => {
        const totalTools = Object.values(proj.toolCounts || {}).reduce((a, b) => a + b, 0) || 1;
        const toolColors = { Bash: '#f97316', Read: '#3b82f6', Edit: '#6046ff', Write: '#8b5cf6', Grep: '#06b6d4', Glob: '#14b8a6', Agent: '#f59e0b' };
        const segments = Object.entries(proj.toolCounts || {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => {
          const pct = (count / totalTools) * 100;
          const color = toolColors[name] || '#64748b';
          return `<div class="h-full" style="width:${pct}%;background:${color}" title="${name}: ${count} (${Math.round(pct)}%)"></div>`;
        }).join('');
        return `
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs text-slate-300">${esc(proj.name)}</span>
              <span class="text-[10px] text-slate-500 font-mono">${totalTools} calls</span>
            </div>
            <div class="flex h-3 rounded-full overflow-hidden gap-px">${segments}</div>
          </div>`;
      }).join('')}</div>
      <div class="flex flex-wrap gap-3 mt-4 pt-3 border-t border-[#252838]/50">
        ${['Bash:#f97316', 'Read:#3b82f6', 'Edit:#6046ff', 'Write:#8b5cf6', 'Grep:#06b6d4', 'Glob:#14b8a6', 'Agent:#f59e0b'].map(s => {
          const [n, c] = s.split(':');
          return `<div class="flex items-center gap-1.5"><div class="w-2 h-2 rounded-full" style="background:${c}"></div><span class="text-[10px] text-slate-500">${n}</span></div>`;
        }).join('')}
      </div>
    </div>`;
}

function loadComparison() {
  fetch('/api/projects')
    .then(r => r.json())
    .then(renderComparison)
    .catch(() => {});
}

/* ══════════════════════════════════════════════════
   Tab data loading on switch
   ══════════════════════════════════════════════════ */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab === 'compare') loadComparison();
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
const activeMascots = new Map(); // pid -> { el, interval, imgInterval, lastStatus, lastTool }

// Per-session last tool event tracking
const sessionLastTool = new Map(); // pid -> { toolName, toolDetail, ts }

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
  const lastTool = sessionLastTool.get(pid);

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

  // Show a click quote
  const bubble = el.querySelector('.mascot-bubble');
  if (bubble) {
    const quote = clickQuotes[Math.floor(Math.random() * clickQuotes.length)];
    bubble.textContent = quote;
    bubble.classList.add('visible');
    mascotData.idleBubbleActive = true;
    clearTimeout(mascotData.clickBubbleTimeout);
    mascotData.clickBubbleTimeout = setTimeout(() => {
      mascotData.idleBubbleActive = false;
      bubble.classList.remove('visible');
    }, 10000);
  }
}

function showRandomQuote(mascotData) {
  const s = sessions.get(mascotData.pid);
  if (!s || s.status === 'thinking' || s.status === 'running') return;
  const lastTool = sessionLastTool.get(mascotData.pid);
  if (lastTool && Date.now() - lastTool.ts < 5000) return;

  const bubble = mascotData.el.querySelector('.mascot-bubble');
  if (!bubble) return;

  const quote = idleQuotes[Math.floor(Math.random() * idleQuotes.length)];
  bubble.textContent = quote;
  bubble.classList.add('visible');
  mascotData.idleBubbleActive = true;

  // Hide after a few seconds
  setTimeout(() => {
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
          (s.status === 'thinking' ? 'bg-indigo-500 animate-pulse' :
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

    const mascotData = { el, interval, imgInterval, quoteInterval: null, lastStatus: s.status, pid, idleBubbleActive: false, draggedUntil: 0 };
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
