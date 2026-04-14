'use strict';

/* ══════════════════════════════════════════════════
   DOM References
   ══════════════════════════════════════════════════ */
const sessionsEl     = document.getElementById('session-list');
const agentsEl       = document.getElementById('agent-list');
const eventLogBody   = document.getElementById('event-log-body');
const eventCountEl   = document.getElementById('event-count');
const statusPill     = document.getElementById('status-pill');
const headerTime     = document.getElementById('header-time');
const headerSessLbl  = document.getElementById('header-session-label');
const canvasEmpty    = document.getElementById('canvas-empty');
const logEmpty       = document.getElementById('log-empty');

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
  if (logEmpty) logEmpty.style.display = 'none';
  if (canvasEmpty) canvasEmpty.style.display = 'none';

  totalEvents++;
  if (e.type === 'tool_use') toolCallCount++;

  if (eventCountEl) eventCountEl.textContent = totalEvents;

  // Workspace event row
  const row = document.createElement('div');
  row.className = 'event-row';
  const detail = e.agentName || e.toolDetail || e.toolName || '';
  row.innerHTML = `
    <span class="ev-time">${hhmm(e.ts)}</span>
    <span class="ev-session" title="${esc(e.name || '')}">${esc(e.name || '')}</span>
    <span class="ev-type t-${e.type || 'unknown'}">${esc(e.type)}</span>
    <span class="ev-detail" title="${esc(detail)}">${esc(detail)}</span>`;

  const atBottom = eventLogBody.scrollHeight - eventLogBody.clientHeight - eventLogBody.scrollTop < 60;
  eventLogBody.appendChild(row);
  if (atBottom) eventLogBody.scrollTop = eventLogBody.scrollHeight;
  while (eventLogBody.children.length > 200) eventLogBody.removeChild(eventLogBody.firstChild);

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
function updateDashboard() {
  if (statTotalEvents) statTotalEvents.textContent = totalEvents.toLocaleString();
  if (statActiveSessions) statActiveSessions.textContent = sessions.size;
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

    activeMascots.set(pid, { el, interval });
  }

  // Remove mascots for ended sessions
  for (const [pid, m] of activeMascots) {
    if (!sessions.has(pid)) {
      m.el.style.opacity = '0';
      m.el.style.transition = 'opacity 0.8s';
      clearInterval(m.interval);
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
