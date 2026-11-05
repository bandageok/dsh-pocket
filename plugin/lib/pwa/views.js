/* ══════════════════════════════════════════════════════════════════
   DSH Mobile — 视图层
   ──────────────────────────────────────────────────────────────────
   设计沿用 mockup（Muse 式信息架构 + DeepSeek 视觉），**数据全部是真的**：

     · 任务 = dsh 的会话（session/list）。状态由 running / approvals 推导；
       阶段与进度后端不给，就不显示假的百分比（见 taskCard 的 indeterminate）。
     · 对话 = 会话转录（/api/session/:id/messages + SSE reset/message/delta）。
     · 模型 / MCP / 工具：移动端 API 没有，走 /api/capabilities 真探测，
       探不到就显式标「未接入」，绝不摆假模型卡。

   与 app.js 的分工：app.js 是数据与流引擎（state / rpc / SSE / 去重 / 本地回声），
   这里只负责把 state 渲染成界面、把点击转成对 app.js 原语的调用。
   ══════════════════════════════════════════════════════════════════ */

/* ── 图标（Lucide 风格内联 SVG） ───────────────────────────── */
const IC = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.6 8.6 0 0 1-3.8-.9L3 20l1.2-3.4a8 8 0 0 1-.7-3.1A8.4 8.4 0 0 1 12 4a8.4 8.4 0 0 1 9 7.5z"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M8 11h8M8 15h5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.49-8.48"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  brain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.99.12A4 4 0 0 0 4 12a4 4 0 0 0 1.07 2.68A3.5 3.5 0 0 0 12 19a3.5 3.5 0 0 0 6.93-4.32A4 4 0 0 0 20 12a4 4 0 0 0-2.99-6.88A3 3 0 0 0 12 5z"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
};

/** 品牌核：DeepSeek 深海蓝底 + 青色核心 + 虚线轨道 */
function mark(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" class="brand-mark" style="width:${size}px;height:${size}px">
  <rect x="1.5" y="1.5" width="37" height="37" rx="11" fill="var(--deep)"/>
  <circle cx="20" cy="20" r="4.2" fill="var(--cyan)"/>
  <circle cx="20" cy="20" r="8.6" stroke="var(--ice)" stroke-width="1" stroke-dasharray="2.4 3" opacity=".85"/>
  <circle cx="20" cy="11.4" r="1.9" fill="#7FD4FF"/>
  <circle cx="27.6" cy="24.6" r="1.9" fill="var(--ice)"/>
  <circle cx="12.9" cy="26.2" r="1.9" fill="var(--primary)"/>
</svg>`;
}

const ROOT = () => document.getElementById('app');
const elMain = () => document.getElementById('main');

/* ── 主题 ─────────────────────────────────────────────── */
function theme() {
  const saved = localStorage.getItem('dsh-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function setTheme(next) {
  localStorage.setItem('dsh-theme', next);
  document.documentElement.dataset.theme = next;
  render();
}

/* ── 路由 ─────────────────────────────────────────────── */
let route = 'home';
let taskFilter = 'All';

function go(next) {
  route = next || 'home';
  if (route.indexOf('chat-') === 0) {
    const id = route.slice(5);
    state.sessionId = id;
    if (typeof loadTranscript === 'function') void loadTranscript(id);
    if (typeof refreshStreamSession === 'function') refreshStreamSession(id);
  }
  render();
  elMain().scrollTop = 0;
}

/* ── 任务：会话 → 任务卡片模型（只做能确证的推导） ───────── */
function taskOf(session) {
  const approvals = session.approvals || [];
  let status = 'Idle';
  if (approvals.length) status = 'Waiting';
  else if (session.running) status = 'Running';
  const name = typeof sessionLabel === 'function' ? sessionLabel(session) : (session.cwd || session.id);
  return {
    id: session.id,
    name,
    short: typeof shortOf === 'function' ? shortOf(session) : String(session.id).slice(-8),
    cwd: session.cwd ? (typeof dirName === 'function' ? dirName(session.cwd) : session.cwd) : '',
    status,
    approvals,
    running: Boolean(session.running),
    at: session.lastActivityAt || session.updatedAt || 0,
    // 阶段/进度/模型：dsh 的 session/list 不提供 —— 显式 undefined，UI 不编
    stageLabel: undefined,
    progress: undefined,
  };
}

function sessions() {
  const list = (state.snapshot && state.snapshot.sessions) || [];
  return list.slice().sort((a, b) => (b.lastActivityAt || b.updatedAt || 0) - (a.lastActivityAt || a.updatedAt || 0));
}
function tasks() { return sessions().map(taskOf); }

/* ── 底栏 ─────────────────────────────────────────────── */
function renderNav() {
  const items = [
    ['home', IC.home, 'Home'],
    ['chat', IC.chat, 'Chat'],
    ['tasks', IC.tasks, 'Tasks'],
    ['settings', IC.gear, 'Settings'],
  ];
  const active = route.indexOf('chat') === 0 ? 'chat' : route.indexOf('task') === 0 ? 'tasks' : route;
  document.getElementById('nav').innerHTML = items
    .map(([key, icon, label]) => `<button class="nav-item ${active === key ? 'on' : ''}" data-go="${key}">${icon}<span>${label}</span></button>`)
    .join('');
}

/* ── 顶栏 ─────────────────────────────────────────────── */
function renderBar() {
  const inDetail = route.indexOf('chat-') === 0;
  const sub = ['settings'].includes(route);
  const running = tasks().filter((t) => t.status === 'Running').length;
  const waiting = tasks().filter((t) => t.status === 'Waiting').length;
  const link = state.link === 'live' ? 'Live' : state.link === 'poll' ? 'Polling' : 'Offline';

  const left = inDetail || sub
    ? `<div class="brand"><span class="online-pill" data-go="${inDetail ? 'chat' : 'home'}">${IC.back} ${inDetail ? 'Chat' : 'Home'}</span></div>`
    : `<div class="brand">${mark(34)}<div class="brand-name">DSH<small>DeepSeek Harness</small></div></div>`;

  const statusPill = !inDetail && !sub
    ? `<span class="online-pill" data-go="tasks"><span class="pulse ${running ? 'busy' : ''}"></span>${running ? 'Working' : link}</span>`
    : '';

  document.getElementById('appbar').innerHTML = `${left}<div class="spacer"></div>${statusPill}
    ${route === 'home' ? `<button class="icon-btn" data-go="tasks">${IC.bell}${waiting ? '<span class="dot"></span>' : ''}</button>` : ''}
    <button class="icon-btn" id="theme-toggle" data-action="theme">${theme() === 'light' ? IC.moon : IC.sun}</button>`;
}

/* ── HOME ─────────────────────────────────────────────── */
function viewHome() {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const list = tasks();
  const running = list.filter((t) => t.status === 'Running');
  const waiting = list.filter((t) => t.status === 'Waiting');
  const recent = list.slice(0, 3);

  const workingCard = running.length || waiting.length
    ? `<div class="working" data-go="tasks">
        <div class="row">
          <span class="core">${mark(38)}</span>
          <div style="flex:1;min-width:0">
            <div class="t1"><span class="breath"></span> ${waiting.length ? waiting.length + ' awaiting approval' : 'DSH is working…'}</div>
            <div class="t2">${waiting.length ? waiting[0].approvals[0].tool : running[0].name}</div>
          </div>
          ${IC.chev}
        </div>
      </div>`
    : '';

  return `<div class="view">
    <div class="hello">
      <div class="time">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</div>
      <h1>${greet}.<br>What should we build today?</h1>
    </div>

    <div class="command">
      <textarea id="cmdInput" rows="1" placeholder="Describe a task for your agents…"></textarea>
      <div class="command-bar">
        <button class="cbtn" data-action="upload">${IC.clip}</button>
        <button class="cbtn send" id="cmdSend" data-action="send-cmd">${IC.send}</button>
      </div>
    </div>

    <div class="chips">
      <div class="chip" data-go="chat">${IC.brain} Continue a session</div>
      <div class="chip" data-go="tasks">${IC.tasks} Review tasks</div>
      ${waiting.length ? `<div class="chip" data-go="tasks">${IC.shield} ${waiting.length} approval</div>` : ''}
    </div>

    ${workingCard}

    <div class="sec-title">Tasks <span class="link" data-go="tasks">View all</span></div>
    ${recent.length ? recent.map(taskCard).join('') : `<div class="card" style="text-align:center;color:var(--text-2);padding:34px 20px;font-size:13px">
      电脑上还没有会话。开一个，或在这里直接发第一条指令。</div>`}
  </div>`;
}

function taskCard(t) {
  const status = t.status;
  const prog = status === 'Idle' ? ''
    : typeof t.progress === 'number'
      ? `<div class="prog"><i style="width:${t.progress}%"></i></div>`
      : `<div class="prog indet"><i></i></div>`;
  return `<div class="card press task-card" data-go="chat-${t.id}">
    <div class="top">
      <span class="av">D</span>
      <div style="flex:1;min-width:0">
        <div class="nm">${esc(t.name)}</div>
        <div class="meta">${esc(t.short)}${t.cwd ? ' · ' + esc(t.cwd) : ''}</div>
      </div>
      <span class="status st-${status}">${status}</span>
    </div>
    ${prog}
    <div class="foot"><span>${IC.clock} ${rel(t.at)}</span><span>${t.approvals.length ? esc(t.approvals[0].tool) : '—'}</span></div>
  </div>`;
}

/* ── CHAT（会话列表，复用任务卡样式） ──────────────────── */
function viewChat() {
  const list = tasks();
  return `<div class="view">
    <div class="hello" style="padding-bottom:0">
      <h1 style="font-size:23px">Chat</h1>
      <p>${list.length ? list.length + ' sessions · ' + (state.link === 'live' ? 'live' : state.link) : 'no sessions yet'}</p>
    </div>
    <div class="chat-list">
      ${list.length ? list.map(taskCard).join('') : `<div class="card" style="text-align:center;color:var(--text-2);padding:34px 20px;font-size:13px">还没有会话</div>`}
    </div>
  </div>`;
}

/* ── CHAT 详情：真实转录 + 工具阶段 + 审批 ─────────────── */
function stageTimeline(messages) {
  const tools = messages.filter((m) => m.role === 'tool');
  if (!tools.length) return '';
  const rows = tools.slice(-6).map((m) => {
    const text = String(m.text || '');
    return `<div class="stage done">
      <span class="dot"></span>
      <div><div class="sname">${esc(text.split(' ')[0] || 'tool')}</div><div class="sdesc">${esc(text.slice(0, 90))}</div></div>
      <span class="stime">${rel(m.at)}</span>
    </div>`;
  }).join('');
  return `<div class="reason" data-reason>
    <div class="reason-head" data-toggle-reason>
      <span class="ic">${IC.brain}</span>
      <span class="txt">Execution · ${tools.length} tool calls</span>
      <span class="chev">${IC.chev}</span>
    </div>
    <div class="reason-body">${rows}</div>
  </div>`;
}

function msgHTML(m) {
  if (m.role === 'user') {
    return `<div class="msg user"><div class="bubble"><div class="inner">${esc(m.text)}</div></div></div>`;
  }
  if (m.role === 'tool') {
    return `<div class="msg agent"><span class="av">D</span><div class="bubble">
      <div class="who">${IC.tool} tool call</div>
      <div class="inner"><code>${esc(m.text)}</code></div></div></div>`;
  }
  const md = typeof bubbleFor === 'function' ? null : null;
  return `<div class="msg agent ${m.pending ? 'pending' : ''}"><span class="av">D</span>
    <div class="bubble"><div class="who">DSH</div>
      <div class="inner" data-md="${encodeURIComponent(m.text || '')}"></div>
      ${m.pending ? '<div class="msg-state">sending…</div>' : ''}
    </div></div>`;
}

function viewDetail() {
  const msgs = (state.messages || []).slice();
  const draft = state.msgDraft || '';
  const approvals = (state.snapshot.approvals || []).filter((a) => !state.sessionId || a.sessionId === state.sessionId);
  const t = tasks().find((x) => x.id === state.sessionId);
  const nodes = msgs.map(msgHTML).join('')
    + (draft ? `<div class="msg agent streaming"><span class="av">D</span><div class="bubble"><div class="who">DSH</div><div class="inner" data-md="${encodeURIComponent(draft)}"></div></div></div>` : '');

  const apprCards = approvals.map((a) => `<div class="approval">
      <h5>${IC.shield} Approval required</h5>
      <p><b>${esc(a.tool || 'tool')}</b>${a.reason ? ' — ' + esc(a.reason) : ''}</p>
      <div class="acts">
        <button class="btn ghost" data-approve-no="${a.id}">Decline</button>
        <button class="btn primary" data-approve-yes="${a.id}">Approve</button>
      </div>
    </div>`).join('');

  return `<div class="view chat-scroll" id="chatScroll">
    ${t ? `<div class="detail-head"><div class="nm">${esc(t.name)}</div>
      <div class="meta">${esc(t.short)}${t.cwd ? ' · ' + esc(t.cwd) : ''} · <span class="status st-${t.status}">${t.status}</span></div></div>` : ''}
    ${apprCards}
    ${nodes || '<div class="card" style="text-align:center;color:var(--text-2);padding:34px 20px;font-size:13px">这个会话还没有消息内容</div>'}
  </div>
  <div class="composer">
    <div class="command" style="margin-top:0">
      <textarea id="chatInput" rows="1" placeholder="Message DSH…"></textarea>
      <div class="command-bar">
        <button class="cbtn" data-action="upload">${IC.clip}</button>
        ${state.snapshot.sessions.find((s) => s.id === state.sessionId && s.running)
          ? `<button class="cbtn" data-action="cancel-session">${IC.stop}</button>`
          : ''}
        <button class="cbtn send" id="chatSend" data-action="send-chat">${IC.send}</button>
      </div>
    </div>
  </div>`;
}

/* ── TASKS ────────────────────────────────────────────── */
function viewTasks() {
  const filters = ['All', 'Running', 'Waiting', 'Idle'];
  const all = tasks();
  const list = all.filter((t) => taskFilter === 'All' || t.status === taskFilter);
  return `<div class="view">
    <div class="hello" style="padding-bottom:0"><h1 style="font-size:23px">Tasks</h1>
      <p>${all.filter((t) => t.status === 'Running').length} running · ${all.filter((t) => t.status === 'Waiting').length} awaiting approval · ${all.length} total</p></div>
    <div class="filter-row">
      ${filters.map((f) => `<div class="fchip ${taskFilter === f ? 'on' : ''}" data-filter="${f}">${f}</div>`).join('')}
    </div>
    ${list.length ? list.map(taskCardFull).join('') : `<div class="card" style="text-align:center;color:var(--text-2);padding:34px 20px;font-size:13px">这个筛选下没有任务</div>`}
    <p class="hint" style="padding:6px 4px 0">任务即 dsh 会话。阶段与百分比由后端 <code>session/list</code> 提供不了，这里不填假数字；状态来自 running 与待审批。</p>
  </div>`;
}

function taskCardFull(t) {
  let acts = '';
  if (t.status === 'Running') {
    acts = `<button class="tbtn" data-cancel="${t.id}">${IC.stop} Stop</button>`;
  } else if (t.status === 'Waiting' && t.approvals[0]) {
    acts = `<button class="tbtn" data-approve-yes="${t.approvals[0].id}">${IC.check} Approve</button>
            <button class="tbtn" data-approve-no="${t.approvals[0].id}">Decline</button>`;
  } else {
    acts = `<button class="tbtn" data-go="chat-${t.id}">${IC.play} Open</button>`;
  }
  return `<div class="card task-card" style="margin-bottom:12px">
    <div class="top" data-go="chat-${t.id}">
      <span class="av">D</span>
      <div style="flex:1;min-width:0"><div class="nm">${esc(t.name)}</div>
        <div class="meta">${esc(t.short)}${t.cwd ? ' · ' + esc(t.cwd) : ''}</div></div>
      <span class="status st-${t.status}">${t.status}</span>
    </div>
    ${t.status === 'Idle' ? '' : '<div class="prog indet"><i></i></div>'}
    <div class="foot" style="margin-top:9px;display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);font-family:var(--mono)">
      <span>${t.approvals.length ? 'approval · ' + esc(t.approvals[0].tool) : 'last activity'}</span><span>${rel(t.at)}</span></div>
    <div class="task-actions">${acts}</div>
  </div>`;
}

/* ── SETTINGS ─────────────────────────────────────────── */
function viewSettings() {
  const cap = state.capabilities || null;
  const capRows = cap
    ? cap.methods.map((m) => `<div class="cap-row">
        <span class="cap-method">${esc(m.method)}</span>
        <span class="cap-state ${m.ok ? 'ok' : 'no'}">${m.ok ? '支持' : '未接入'}</span>
        <span style="color:var(--text-3)">${m.ms}ms</span></div>`).join('')
      + `<p class="hint">支持 ${cap.methods.filter((m) => m.ok).length} / ${cap.methods.length}。不支持的项即后端未提供。</p>`
    : '<p class="hint">还没探测。点下面的按钮，真的去问后端。</p>';

  return `<div class="view">
    <div class="hello" style="padding-bottom:6px"><h1 style="font-size:23px">Settings</h1>
      <p>${state.link === 'live' ? 'SSE live' : state.link === 'poll' ? 'polling' : 'offline'} · ${esc(state.base ? state.base.host : '—')}</p></div>

    <div class="sec-title">Runtime</div>
    <div class="card" style="display:flex;flex-direction:column;gap:8px">
      <div class="kv"><span>连接</span><code>${state.link === 'live' ? 'SSE 实时' : state.link === 'poll' ? '轮询降级' : '断开'}</code></div>
      <div class="kv"><span>设备</span><code>${esc(state.deviceName || '—')}</code></div>
      <div class="kv"><span>会话</span><code>${(state.snapshot.sessions || []).length}</code></div>
      <div class="kv"><span>内容同步</span><code>${state.snapshot.capabilities && state.snapshot.capabilities.sync ? '已启用' : '仅快照'}</code></div>
    </div>

    <div class="sec-title">Models &amp; Tools</div>
    <div class="card">
      <div class="cap-list" id="capList">${capRows}</div>
      <button class="btn ghost" data-action="probe" style="margin-top:10px">探测后端能力</button>
      <p class="hint">模型、MCP、工具的列表在移动端 API 里没有；这里只显示探测到的真实方法，
        没有就标「未接入」，不摆假模型卡。</p>
    </div>

    <div class="sec-title">Connection</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <label class="field"><span class="field-label">桌面地址</span><input id="set-base" type="url" value="${esc(displayBase(state.base))}" /></label>
      <label class="field"><span class="field-label">设备名</span><input id="set-name" type="text" value="${esc(state.deviceName || '')}" /></label>
      <button class="btn primary" data-action="save-conn">保存连接</button>
      <button class="btn ghost" data-go="home">返回首页</button>
    </div>

    <div class="sec-title">Relay</div>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <label class="field"><span class="field-label">中继地址</span><input id="set-relay" type="url" placeholder="wss://relay.example.com" value="${esc(state.relayUrl || '')}" /></label>
      <label class="field"><span class="field-label">房间号</span><input id="set-room" type="text" placeholder="my-room" value="${esc(state.room || '')}" /></label>
      <button class="btn" data-action="save-relay">保存并重连</button>
    </div>

    <div class="sec-title">Notifications</div>
    <div class="card"><label class="switch"><span>新审批时通知</span>
      <input id="set-notify" type="checkbox" ${state.notify ? 'checked' : ''} /></label></div>

    <div class="sec-title">Diagnostics</div>
    <div class="card" style="display:flex;flex-direction:column;gap:8px">
      <button class="btn ghost" data-action="probe-addr">自动探测地址</button>
      <button class="btn ghost" data-action="diag">导出诊断（仅数字码）</button>
      <button class="btn ghost" data-action="signout" style="color:var(--danger)">退出配对</button>
    </div>

    <p class="hint" style="padding:8px 4px 20px">DSH Mobile · 把桌面上的 dsh 变成手机上的 Agent 控制台</p>
  </div>`;
}

/* ── 渲染 & 事件 ──────────────────────────────────────── */
function render() {
  document.documentElement.dataset.theme = theme();
  const connect = document.getElementById('view-connect');
  const app = ROOT();
  const needPair = !state.token;
  connect.hidden = !needPair;
  app.style.display = needPair ? 'none' : '';
  if (needPair) {
    const mk = document.getElementById('connect-mark');
    if (mk) mk.innerHTML = mark(64);
    return;
  }

  renderBar();
  renderNav();
  elMain().innerHTML = route === 'home' ? viewHome()
    : route === 'tasks' ? viewTasks()
    : route.indexOf('chat-') === 0 ? viewDetail()
    : route === 'settings' ? viewSettings()
    : viewChat();

  // 消息正文用 markdown.js 渲染（不拼 innerHTML，安全）
  for (const node of elMain().querySelectorAll('[data-md]')) {
    const text = decodeURIComponent(node.getAttribute('data-md') || '');
    node.textContent = '';
    try {
      const frag = typeof renderMarkdown === 'function' ? renderMarkdown(text) : null;
      if (frag) node.append(frag); else node.textContent = text;
    } catch { node.textContent = text; }
  }
  bind();
}

function bind() {
  const main = elMain();
  for (const node of main.querySelectorAll('[data-go]')) {
    node.addEventListener('click', () => go(node.getAttribute('data-go')));
  }
  const appbar = document.getElementById('appbar');
  for (const node of appbar.querySelectorAll('[data-go]')) {
    node.addEventListener('click', () => go(node.getAttribute('data-go')));
  }
  for (const node of appbar.querySelectorAll('[data-action="theme"]')) {
    node.addEventListener('click', () => setTheme(theme() === 'light' ? 'dark' : 'light'));
  }
  const nav = document.getElementById('nav');
  for (const node of nav.querySelectorAll('[data-go]')) {
    node.addEventListener('click', () => go(node.getAttribute('data-go') === 'chat' ? 'chat' : node.getAttribute('data-go')));
  }
  for (const chip of main.querySelectorAll('[data-filter]')) {
    chip.addEventListener('click', () => { taskFilter = chip.getAttribute('data-filter'); render(); });
  }
  const cmd = main.querySelector('#cmdInput');
  if (cmd) {
    cmd.addEventListener('input', () => { cmd.style.height = 'auto'; cmd.style.height = Math.min(cmd.scrollHeight, 120) + 'px'; });
  }
  const chat = main.querySelector('#chatInput');
  if (chat) {
    chat.addEventListener('input', () => { chat.style.height = 'auto'; chat.style.height = Math.min(chat.scrollHeight, 120) + 'px'; });
  }
  for (const node of main.querySelectorAll('[data-action]')) {
    node.addEventListener('click', () => onAction(node.getAttribute('data-action'), node, main));
  }
  for (const node of main.querySelectorAll('[data-cancel]')) {
    node.addEventListener('click', () => cancelTask(node.getAttribute('data-cancel')));
  }
  for (const node of main.querySelectorAll('[data-approve-yes]')) {
    node.addEventListener('click', () => answerApproval(node.getAttribute('data-approve-yes'), 'allow'));
  }
  for (const node of main.querySelectorAll('[data-approve-no]')) {
    node.addEventListener('click', () => answerApproval(node.getAttribute('data-approve-no'), 'deny'));
  }
  for (const head of main.querySelectorAll('[data-toggle-reason]')) {
    head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
  }
}

async function onAction(action, node, main) {
  if (action === 'send-cmd') {
    const input = main.querySelector('#cmdInput');
    const text = (input && input.value || '').trim();
    if (!text) return;
    const target = sessions()[0];
    if (!target) { toast('电脑上还没有会话'); return; }
    const res = await write('api/prompt', { sessionId: target.id, text, mode: 'queue' }, { ok: () => toast('已发送'), unknown: '发送失败' });
    if (res && res.status === 200 && input) input.value = '';
    return;
  }
  if (action === 'send-chat') {
    const input = main.querySelector('#chatInput');
    const text = (input && input.value || '').trim();
    if (!text || !state.sessionId) return;
    const res = await write('api/prompt', { sessionId: state.sessionId, text, mode: 'queue' }, { ok: () => toast('已发送'), unknown: '发送失败' });
    if (res && res.status === 200 && input) input.value = '';
    return;
  }
  if (action === 'cancel-session') { await cancelTask(state.sessionId); return; }
  if (action === 'probe') { await probeCapabilities(); return; }
  if (action === 'save-conn') {
    const base = main.querySelector('#set-base');
    const name = main.querySelector('#set-name');
    if (base) state.base = normalizeBase(base.value);
    if (name) state.deviceName = name.value.trim();
    if (typeof saveConfig === 'function') saveConfig();
    if (typeof setLink === 'function') setLink('down');
    toast('已保存，正在重连');
    if (typeof pollOnce === 'function') void pollOnce();
    render();
    return;
  }
  if (action === 'save-relay') {
    const relay = main.querySelector('#set-relay');
    const room = main.querySelector('#set-room');
    state.relayUrl = relay ? relay.value.trim() : '';
    state.room = room ? room.value.trim() : '';
    if (typeof saveConfig === 'function') saveConfig();
    if (typeof relayConnect === 'function') relayConnect();
    toast('已保存');
    return;
  }
  if (action === 'diag') {
    if (typeof openDiag === 'function') openDiag();
    return;
  }
  if (action === 'probe-addr') {
    if (typeof probeAddresses === 'function') void probeAddresses();
    else toast('自动探测仅 App 内可用');
    return;
  }
  if (action === 'signout') {
    if (typeof signOut === 'function') signOut();
    else { localStorage.removeItem('dshpocket.token'); location.reload(); }
    return;
  }
  if (action === 'upload') {
    const file = document.getElementById('detail-file');
    if (file) file.click();
  }
}

async function cancelTask(sessionId) {
  if (!sessionId) return;
  await write('api/cancel', { sessionId }, { ok: () => { toast('已请求停止'); pollOnce(); }, unknown: '停止失败' });
}

async function probeCapabilities() {
  const row = document.getElementById('capList');
  if (row) row.innerHTML = '<p class="hint">探测中…</p>';
  const res = await rpc('api/capabilities', { method: 'GET' }).catch(() => null);
  state.capabilities = res && res.json ? res.json : { methods: [] };
  render();
}

/* ── 工具函数 ─────────────────────────────────────────── */
function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function rel(ts) {
  if (typeof relTime === 'function') return relTime(ts);
  if (!ts) return '—';
  const mins = Math.round((Date.now() - ts) / 60000);
  return mins < 1 ? 'just now' : mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h';
}

/* 初始渲染 + 状态变化时重绘（app.js 每帧会调它的 update*；这里监听一个轻量钩子） */
document.addEventListener('dsh:state', () => render());
window.addEventListener('hashchange', () => {
  const h = String(location.hash || '').replace('#/', '');
  if (h) { route = h; render(); }
});

/* app.js 的 pollOnce/SSE 会改 state；用 rAF 节流兜底重绘 */
let lastPaint = 0;
setInterval(() => {
  if (!state.token) return;
  const stamp = (state.snapshot && state.snapshot.now) || 0;
  const key = [stamp, state.link, (state.messages || []).length, state.msgDraft ? 1 : 0, state.sessionId].join('|');
  if (key !== window.__dshKey) {
    window.__dshKey = key;
    render();
  }
}, 700);

/* 供 app.js 主动触发重绘 */
window.__dshRender = () => { try { render(); } catch (err) { console.error('render failed', err); } };

/* 首帧：连接屏也要画品牌核 */
setTimeout(() => { if (elementReady()) render(); }, 0);
function elementReady() { return Boolean(document.getElementById('main')); }