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
  updateStatusCounts();
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

    // Session card
    if (first) {
      sessionHtml += `
        <div class="p-2 rounded bg-[#6046ff]/10 border-l-2 border-[#6046ff] shadow-[0_0_12px_rgba(96,70,255,0.1)] cursor-pointer">
          <div class="flex justify-between items-start mb-1">
            <span class="text-xs font-mono text-[#c6bfff]">${esc(displayId)}</span>
            <span class="text-[9px] px-1.5 py-0.5 rounded ${badge.cls} font-bold">${badge.text}</span>
          </div>
          <div class="text-[10px] text-slate-400">${esc(timeLabel)}</div>
        </div>`;
    } else {
      sessionHtml += `
        <div class="p-2 rounded hover:bg-[#1c1f2e] transition-all cursor-pointer group">
          <div class="flex justify-between items-start mb-1">
            <span class="text-xs font-mono text-slate-400 group-hover:text-slate-300">${esc(displayId)}</span>
            <span class="text-[9px] px-1.5 py-0.5 rounded ${badge.cls} font-bold">${badge.text}</span>
          </div>
          <div class="text-[10px] text-slate-500">${esc(timeLabel)}</div>
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
  updateStatusCounts();
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
   Status Counts
   ══════════════════════════════════════════════════ */
function updateStatusCounts() {
  const el1 = document.getElementById('status-event-count');
  const el2 = document.getElementById('status-session-count');
  if (el1) el1.textContent = totalEvents;
  if (el2) el2.textContent = sessions.size;
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
    }
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

function renderProjectPanel(projects) {
  if (!projectPanelBody) return;
  if (!projects || projects.length === 0) {
    if (projectEmpty) projectEmpty.style.display = '';
    return;
  }
  if (projectEmpty) projectEmpty.style.display = 'none';

  projectPanelBody.innerHTML = projects.map(proj => {
    // Tool chart — horizontal bars
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

    // Top modified files
    const fileRows = (proj.topFiles || []).slice(0, 5).map(f => {
      const shortPath = f.file.split('/').slice(-2).join('/');
      return `
        <div class="flex items-center justify-between text-[10px] py-0.5">
          <span class="text-slate-400 truncate flex-1" title="${esc(f.file)}">${esc(shortPath)}</span>
          <span class="text-[#6046ff] font-mono ml-2">${f.count}x</span>
        </div>`;
    }).join('');

    // Recent sessions (last 5)
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

    // Daily activity sparkline (last 14 days)
    const dailyEntries = Object.entries(proj.dailyActivity || {}).sort().slice(-14);
    let sparkline = '';
    if (dailyEntries.length > 0) {
      const maxDay = Math.max(1, ...dailyEntries.map(e => e[1]));
      const bars = dailyEntries.map(([day, count]) => {
        const h = Math.max(2, (count / maxDay) * 24);
        const label = day.slice(5); // MM-DD
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
          <span class="text-[9px] text-slate-600 font-mono truncate ml-2 max-w-[180px]" title="${esc(proj.cwd)}">${esc(proj.cwd)}</span>
        </div>

        <!-- Stats row -->
        <div class="grid grid-cols-3 gap-2 mb-3">
          <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
            <div class="text-[10px] text-slate-500">세션</div>
            <div class="text-sm font-bold text-white font-mono">${proj.totalSessions}</div>
          </div>
          <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
            <div class="text-[10px] text-slate-500">사용 시간</div>
            <div class="text-sm font-bold text-white font-mono">${formatDuration(proj.totalDuration)}</div>
          </div>
          <div class="bg-[#1c1f2e] rounded px-2 py-1.5 text-center">
            <div class="text-[10px] text-slate-500">이벤트</div>
            <div class="text-sm font-bold text-white font-mono">${proj.totalEvents.toLocaleString()}</div>
          </div>
        </div>

        <!-- Tool usage -->
        ${toolBars ? `
        <div class="mb-3">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-1.5">도구 사용</div>
          <div class="space-y-1">${toolBars}</div>
        </div>` : ''}

        <!-- Top files -->
        ${fileRows ? `
        <div class="mb-2">
          <div class="text-[9px] text-slate-600 uppercase tracking-wider mb-1">자주 수정된 파일</div>
          ${fileRows}
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

function loadProjects() {
  fetch('/api/projects')
    .then(r => r.json())
    .then(renderProjectPanel)
    .catch(() => {});
}

// Load projects on startup and refresh periodically
loadProjects();
setInterval(loadProjects, 30000);

// Refresh button
document.getElementById('btn-project-refresh')?.addEventListener('click', loadProjects);

/* ══════════════════════════════════════════════════
   Floating Mascots (one per session)
   ══════════════════════════════════════════════════ */
const mascotContainer = document.getElementById('mascot-container');
const canvas = document.getElementById('view-workspace');
const activeMascots = new Map(); // pid -> { el, interval }

function syncMascots() {
  if (!mascotContainer || !canvas) return;

  // Add mascots for new sessions
  for (const [pid, s] of sessions) {
    if (activeMascots.has(pid)) continue;

    const el = document.createElement('div');
    el.className = 'mascot';
    el.innerHTML = `
      <img src="/img/mascot.png" alt="${esc(s.name || 'mascot')}" class="mascot-img" draggable="false">
      <div class="mascot-label">${esc(s.name || pid)}</div>`;

    // Animate between two mascot images
    const mascotImg = el.querySelector('.mascot-img');
    const images = ['/img/mascot-default.png', '/img/mascot-move.png'];
    const imgInterval = startImageAnimation(mascotImg, images, 600);

    // Random initial position
    const cw = canvas.clientWidth || 800;
    const ch = canvas.clientHeight || 600;
    el.style.left = (Math.random() * (cw - 160) + 20) + 'px';
    el.style.top  = (Math.random() * (ch - 160) + 20) + 'px';

    // Random float delay so they don't all bob in sync
    el.style.animationDelay = (Math.random() * -3) + 's';

    mascotContainer.appendChild(el);

    // Each mascot wanders independently
    const interval = setInterval(() => wanderMascot(el), 4000 + Math.random() * 3000);
    setTimeout(() => wanderMascot(el), 1000 + Math.random() * 2000);

    activeMascots.set(pid, { el, interval, imgInterval });
  }

  // Remove mascots for ended sessions
  for (const [pid, m] of activeMascots) {
    if (!sessions.has(pid)) {
      m.el.style.opacity = '0';
      m.el.style.transition = 'opacity 0.8s';
      clearInterval(m.interval);
      clearInterval(m.imgInterval);
      setTimeout(() => m.el.remove(), 800);
      activeMascots.delete(pid);
    }
  }
}

function wanderMascot(el) {
  if (!canvas) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const x = Math.random() * (cw - 160) + 20;
  const y = Math.random() * (ch - 160) + 20;
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
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
