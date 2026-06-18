// ══════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════
const App = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  config: { warnSeconds: 480, limitSeconds: 600 },
  meta: { stages: [] },
  activeExits: [],
  history: [],
  statsExits: [],
  notifications: [],
  fired: new Set(), // `${exitId}:warn` / `${exitId}:over`
  tab: null,
  es: null,
};

const NAV = {
  admin: [
    { id: 'data', label: '🏛️ البيانات الأساسية' },
    { id: 'accounts', label: '👥 الحسابات' },
    { id: 'overview', label: '👀 المتابعة العامة' },
  ],
  deputy: [
    { id: 'overview', label: '👀 المتابعة العامة' },
    { id: 'map', label: '🗺️ خريطة الفصول' },
    { id: 'stats', label: '📊 الإحصائيات' },
    { id: 'history', label: '📋 السجل' },
    { id: 'notif', label: '🔔 التنبيهات' },
  ],
  counselor: [
    { id: 'overview', label: '👀 متابعة مرحلتي' },
    { id: 'map', label: '🗺️ خريطة الفصول' },
    { id: 'stats', label: '📊 الإحصائيات' },
    { id: 'history', label: '📋 السجل' },
    { id: 'notif', label: '🔔 التنبيهات' },
  ],
  teacher: [
    { id: 'grant', label: '📤 منح إذن الخروج' },
    { id: 'history', label: '📋 سجل طلابي' },
  ],
};

const ROLE_LABEL = { admin: 'مدير النظام', deputy: 'وكيل شؤون الطلاب', counselor: 'مرشد طلابي', teacher: 'معلم' };

// ══════════════════════════════════════════════
//  API HELPER
// ══════════════════════════════════════════════
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (App.token) headers.Authorization = `Bearer ${App.token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

// ══════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════
function showToast(msg, type) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

// ══════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════
async function boot() {
  if (App.token && App.user) {
    try {
      await api('/api/me');
      await startApp();
      return;
    } catch (e) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      App.token = null; App.user = null;
    }
  }
  renderLogin();
}
boot();

// ══════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════
function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">نظام الاستئذان <span>الذكي</span></div>
        <div class="login-sub">تسجيل الدخول للمتابعة والربط بين المعلم والمرشد ووكيل شؤون الطلاب</div>
        <div class="login-error" id="login-error"></div>
        <label>الاسم</label>
        <input type="text" id="login-name" placeholder="اكتب اسمك">
        <label>الرقم السري</label>
        <input type="text" id="login-pin" placeholder="••••••" maxlength="6" inputmode="numeric">
        <button class="btn btn-primary" id="login-btn" onclick="App.doLogin()">دخول</button>
      </div>
    </div>`;
  document.getElementById('login-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') App.doLogin(); });
}

App.doLogin = async function () {
  const name = document.getElementById('login-name').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  const errBox = document.getElementById('login-error');
  errBox.classList.remove('show');
  if (!name || !pin) { errBox.textContent = 'يرجى تعبئة الاسم والرقم السري'; errBox.classList.add('show'); return; }
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'جاري الدخول...';
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ name, pin }) });
    App.token = data.token; App.user = data.user;
    localStorage.setItem('token', App.token);
    localStorage.setItem('user', JSON.stringify(App.user));
    await startApp();
  } catch (e) {
    errBox.textContent = e.message; errBox.classList.add('show');
    btn.disabled = false; btn.textContent = 'دخول';
  }
};

App.logout = async function () {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  localStorage.removeItem('token'); localStorage.removeItem('user');
  if (App.es) App.es.close();
  App.token = null; App.user = null;
  renderLogin();
};

// ══════════════════════════════════════════════
//  APP SHELL
// ══════════════════════════════════════════════
async function startApp() {
  const [configRes, metaRes] = await Promise.all([api('/api/config'), api('/api/meta')]);
  App.config = configRes;
  App.meta = metaRes;
  const nav = NAV[App.user.role];
  App.tab = nav[0].id;
  renderShell();
  await refreshAll();
  connectStream();
  setInterval(tick, 1000);
  setInterval(refreshAll, 5000);
}

function renderShell() {
  const nav = NAV[App.user.role];
  const stageLine = App.user.role === 'counselor' ? `<div class="sidebar-role">مرحلة: ${App.user.stageName || '-'}</div>` : '';
  document.getElementById('app').innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-logo">الاستئذان <span>الذكي</span></div>
        <div class="sidebar-role">${ROLE_LABEL[App.user.role]}</div>
        ${stageLine}
        <nav class="sidebar-nav">
          ${nav.map(n => `<div class="nav-item" data-tab="${n.id}">${n.label}</div>`).join('')}
        </nav>
        <div class="sidebar-foot">
          <div class="sidebar-user">👤 ${App.user.name}</div>
          <button class="sidebar-logout" onclick="App.logout()">تسجيل الخروج</button>
        </div>
      </aside>
      <div class="main-area">
        <header class="topbar">
          <div class="topbar-title" id="topbar-title"></div>
          <div class="topbar-meta">
            <div class="live-badge"><div class="live-dot"></div>مباشر</div>
            <div class="clock" id="clock">--:--</div>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>`;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => switchTab(el.dataset.tab));
  });
  updateClock();
  setInterval(updateClock, 1000);
  switchTab(App.tab);
}

function updateClock() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
}

function switchTab(id) {
  App.tab = id;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === id));
  const titles = {};
  NAV[App.user.role].forEach(n => titles[n.id] = n.label.replace(/^\S+\s/, ''));
  document.getElementById('topbar-title').textContent = titles[id] || '';
  renderTab();
}

function renderTab() {
  const c = document.getElementById('content');
  if (!c) return;
  if (App.tab === 'overview') return renderOverview(c);
  if (App.tab === 'map') return renderMap(c);
  if (App.tab === 'stats') return renderStats(c);
  if (App.tab === 'history') return renderHistory(c);
  if (App.tab === 'notif') return renderNotif(c);
  if (App.tab === 'grant') return renderGrant(c);
  if (App.tab === 'data') return renderAdminData(c);
  if (App.tab === 'accounts') return renderAdminAccounts(c);
}

// ══════════════════════════════════════════════
//  DATA REFRESH + SSE + TICK
// ══════════════════════════════════════════════
async function refreshAll() {
  try {
    const [active, hist] = await Promise.all([api('/api/exits/active'), api('/api/exits/history')]);
    App.activeExits = active.exits;
    App.history = hist.exits;
    if (App.tab === 'stats') {
      const stats = await api('/api/stats');
      App.statsExits = stats.exits;
    }
    renderTab();
  } catch (e) { /* ignore transient errors */ }
}

function connectStream() {
  if (App.es) App.es.close();
  const es = new EventSource('/api/stream');
  es.addEventListener('exit_created', () => refreshAll());
  es.addEventListener('exit_returned', () => refreshAll());
  es.onerror = () => {}; // browser auto-reconnects
  App.es = es;
}

function fmtSec(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function timerClass(elapsed) {
  if (elapsed > App.config.limitSeconds) return 'red';
  if (elapsed >= App.config.warnSeconds) return 'yellow';
  return '';
}
function badgeData(elapsed) {
  if (elapsed > App.config.limitSeconds) return ['red', '🔴 متجاوز'];
  if (elapsed >= App.config.warnSeconds) return ['yellow', '🟡 يوشك'];
  return ['green', '🟢 في الوقت'];
}

function tick() {
  if (!App.activeExits.length) {
    if (App.tab === 'overview' || App.tab === 'grant') renderTab();
    return;
  }
  const now = Date.now();
  App.activeExits.forEach(e => {
    e.elapsed = Math.floor((now - e.startTs) / 1000);
    const warnKey = `${e.id}:warn`, overKey = `${e.id}:over`;
    if (e.elapsed >= App.config.warnSeconds && e.elapsed <= App.config.limitSeconds && !App.fired.has(warnKey)) {
      App.fired.add(warnKey);
      addNotification(e, 'warn');
      showToast(`⚠️ ${e.studentName} اقترب من تجاوز الوقت`, 'yellow');
    }
    if (e.elapsed > App.config.limitSeconds && !App.fired.has(overKey)) {
      App.fired.add(overKey);
      addNotification(e, 'urgent');
      showToast(`🚨 تنبيه! ${e.studentName} تجاوز الوقت المسموح`, 'red');
    }
  });
  if (['overview', 'grant', 'map'].includes(App.tab)) renderTab();
}

function addNotification(exit, type) {
  const timeStr = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
  App.notifications.unshift({
    type, icon: type === 'urgent' ? '🚨' : '⚠️',
    title: type === 'urgent' ? `تجاوز وقت الاستئذان — ${exit.studentName}` : `تحذير: اقتراب من الحد — ${exit.studentName}`,
    desc: `فصل ${exit.classLabel} (${exit.stageName}) | ${exit.reason} | بواسطة: ${exit.initiatorName}`,
    time: timeStr,
  });
  if (App.tab === 'notif') renderTab();
}

// ══════════════════════════════════════════════
//  OVERVIEW
// ══════════════════════════════════════════════
function renderOverview(c) {
  const exits = App.activeExits;
  const overdue = exits.filter(e => e.elapsed > App.config.limitSeconds).length;
  const warn = exits.filter(e => e.elapsed >= App.config.warnSeconds && e.elapsed <= App.config.limitSeconds).length;
  const todayCount = App.history.length + exits.length;
  c.innerHTML = `
    <div class="kpi-bar">
      <div class="kpi green"><div class="kpi-num">${exits.length}</div><div class="kpi-label">خارج الفصل الآن</div></div>
      <div class="kpi red"><div class="kpi-num">${overdue}</div><div class="kpi-label">تجاوزوا الوقت</div></div>
      <div class="kpi yellow"><div class="kpi-num">${warn}</div><div class="kpi-label">يقتربون من الحد</div></div>
      <div class="kpi"><div class="kpi-num">${todayCount}</div><div class="kpi-label">إجمالي اليوم</div></div>
    </div>
    <div class="section-title">👀 الطلاب خارج الفصول الآن</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>الفصل</th><th>الطالب</th><th>السبب</th><th>وقت الخروج</th><th>المدة</th><th>الحالة</th></tr></thead>
        <tbody>
          ${exits.length ? exits.map(e => {
            const [bc, bl] = badgeData(e.elapsed || 0);
            return `<tr>
              <td><strong>${e.classLabel}</strong></td>
              <td>${e.studentName}</td>
              <td>${e.reason}</td>
              <td>${new Date(e.startTs).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}</td>
              <td><strong style="font-variant-numeric:tabular-nums;color:var(--${timerClass(e.elapsed || 0) || 'ink'})">${fmtSec(e.elapsed || 0)}</strong></td>
              <td><span class="badge ${bc}"><span class="badge-dot"></span>${bl}</span></td>
            </tr>`;
          }).join('') : `<tr><td colspan="6"><div class="empty"><div class="empty-icon">✅</div><p>لا يوجد طلاب خارج الفصول حالياً</p></div></td></tr>`}
        </tbody>
      </table>
    </div>`;
}

// ══════════════════════════════════════════════
//  GRANT (TEACHER)
// ══════════════════════════════════════════════
function renderGrant(c) {
  const mine = App.activeExits;
  const classOptions = App.meta.stages.map(s =>
    `<optgroup label="${s.name}">${s.classes.map(cl => `<option value="${cl.id}">${cl.label}</option>`).join('')}</optgroup>`
  ).join('');
  c.innerHTML = `
    <div class="panel-grid">
      <div class="panel-card">
        <div class="panel-card-header">📤 منح إذن الخروج</div>
        <div class="panel-card-body">
          <label>الفصل</label>
          <select id="g-class"><option value="">اختر الفصل</option>${classOptions}</select>
          <label>اسم الطالب</label>
          <input type="text" id="g-student" placeholder="اكتب اسم الطالب">
          <label>سبب الخروج</label>
          <select id="g-reason">
            <option value="">اختر السبب</option>
            <option>دورة المياه</option><option>المرشد الطلابي</option><option>العيادة المدرسية</option>
            <option>الإدارة</option><option>مكتب الوكيل</option><option>أخرى</option>
          </select>
          <button class="btn btn-primary" onclick="App.grantExit()">✅ منح إذن الخروج وبدء العداد</button>
        </div>
      </div>
      <div class="panel-card">
        <div class="panel-card-header">⏱️ الطلاب خارج فصلك الآن</div>
        <div class="panel-card-body">
          <div class="exit-list">
            ${mine.length ? mine.map(e => {
              const tc = timerClass(e.elapsed || 0);
              return `<div class="exit-item ${tc === 'red' ? 'alert-red' : tc === 'yellow' ? 'alert-yellow' : ''}">
                <div class="exit-info"><div class="exit-name">${e.studentName}</div><div class="exit-meta">${e.classLabel} • ${e.reason}</div></div>
                <div class="timer-display ${tc}">${fmtSec(e.elapsed || 0)}</div>
                <button class="btn-small" onclick="App.returnStudent(${e.id})">✅ عاد</button>
              </div>`;
            }).join('') : `<div class="empty"><div class="empty-icon">🟢</div><p>لا يوجد طلاب خارج الفصل</p></div>`}
          </div>
        </div>
      </div>
    </div>`;
}

App.grantExit = async function () {
  const classId = document.getElementById('g-class').value;
  const studentName = document.getElementById('g-student').value.trim();
  const reason = document.getElementById('g-reason').value;
  if (!classId || !studentName || !reason) { showToast('يرجى تعبئة جميع الحقول', 'yellow'); return; }
  try {
    await api('/api/exits', { method: 'POST', body: JSON.stringify({ classId: Number(classId), studentName, reason }) });
    showToast(`تم منح إذن الخروج للطالب ${studentName}`, 'green');
    document.getElementById('g-student').value = '';
    document.getElementById('g-reason').value = '';
    await refreshAll();
  } catch (e) { showToast(e.message, 'red'); }
};

App.returnStudent = async function (id) {
  try {
    const { exit } = await api(`/api/exits/${id}/return`, { method: 'POST' });
    showToast(`عاد الطالب ${exit.studentName} (${fmtSec(exit.duration)})`, 'green');
    await refreshAll();
  } catch (e) { showToast(e.message, 'red'); }
};

// ══════════════════════════════════════════════
//  MAP
// ══════════════════════════════════════════════
function renderMap(c) {
  const stages = App.user.role === 'counselor'
    ? App.meta.stages.filter(s => s.id === App.user.stageId)
    : App.meta.stages;
  c.innerHTML = stages.map((s, si) => {
    const idx = App.meta.stages.findIndex(x => x.id === s.id);
    return `
    <div class="stage-block">
      <div class="stage-block-head"><span class="stage-tag s${idx % 3}">${s.name}</span></div>
      <div class="map-grid">
        ${s.classes.map(cl => {
          const exits = App.activeExits.filter(e => e.classId === cl.id);
          const over = exits.filter(e => (e.elapsed || 0) > App.config.limitSeconds).length;
          const cls = over > 0 ? 'has-alert' : exits.length > 0 ? 'has-exit' : '';
          const badge = exits.length > 0 ? `<div class="exit-count-badge">${exits.length}</div>` : '';
          return `<div class="classroom-block ${cls}">
            ${badge}
            <div class="classroom-name">فصل ${cl.label}</div>
            <div class="classroom-count">${exits.length > 0 ? `${exits.length} خارج الفصل` : 'لا أحد خارج'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('') || `<div class="empty"><div class="empty-icon">🗺️</div><p>لا توجد فصول</p></div>`;
}

// ══════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════
function barBlock(title, entries, colorFn) {
  if (!entries.length) return `<p style="color:var(--muted);font-size:13px">لا توجد بيانات بعد</p>`;
  const max = entries[0][1] || 1;
  return entries.map(([label, cnt], i) => `
    <div class="bar-row">
      <div class="bar-label" title="${label}">${label}</div>
      <div class="bar-track"><div class="bar-fill ${colorFn ? colorFn(i) : ''}" style="width:${cnt / max * 100}%"></div></div>
      <div class="bar-val">${cnt}</div>
    </div>`).join('');
}

function renderStats(c) {
  const all = App.statsExits.length ? App.statsExits : [...App.history, ...App.activeExits];
  const count = (key) => {
    const m = {};
    all.forEach(h => { m[h[key]] = (m[h[key]] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const topStudents = count('studentName').slice(0, 5);
  const topReasons = count('reason');
  const topClasses = count('classLabel').slice(0, 5);
  const delayed = App.history.filter(h => h.status === 'late').length;
  const avgDur = App.history.length ? Math.round(App.history.reduce((a, h) => a + h.duration, 0) / App.history.length) : 0;

  c.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card"><div class="stats-card-title">أكثر الطلاب خروجاً</div><div>${barBlock('', topStudents)}</div></div>
      <div class="stats-card"><div class="stats-card-title">أسباب الخروج</div><div>${barBlock('', topReasons, (i) => ['', 'yellow', 'red', '', 'yellow'][i] || '')}</div></div>
      <div class="stats-card"><div class="stats-card-title">أكثر الفصول خروجاً</div><div>${barBlock('', topClasses)}</div></div>
      <div class="stats-card">
        <div class="stats-card-title">ملخص اليوم</div>
        <div class="bar-row" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div style="font-size:14px">📊 إجمالي الاستئذانات: <strong>${all.length}</strong></div>
          <div style="font-size:14px">🔴 حالات التأخير: <strong style="color:var(--red)">${delayed}</strong></div>
          <div style="font-size:14px">🟢 ضمن الوقت: <strong style="color:var(--green)">${App.history.length - delayed}</strong></div>
          <div style="font-size:14px">⏱️ متوسط مدة الخروج: <strong>${fmtSec(avgDur)}</strong></div>
          <div style="font-size:14px">👁️ خارج الفصل الآن: <strong>${App.activeExits.length}</strong></div>
        </div>
      </div>
    </div>`;
}

// ══════════════════════════════════════════════
//  HISTORY
// ══════════════════════════════════════════════
function renderHistory(c) {
  const rows = App.history;
  c.innerHTML = `
    <div class="section-title">📋 سجل الاستئذانات</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>الفصل</th><th>الطالب</th><th>السبب</th><th>الخروج</th><th>العودة</th><th>المدة</th><th>الحالة</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(h => {
            const statusColor = h.status === 'late' ? 'red' : 'green';
            const statusLabel = h.status === 'late' ? 'تأخير' : 'عادي';
            return `<tr>
              <td>${h.classLabel}</td><td>${h.studentName}</td><td>${h.reason}</td>
              <td>${new Date(h.startTs).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}</td>
              <td>${new Date(h.returnTs).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}</td>
              <td>${fmtSec(h.duration)}</td>
              <td><span class="badge ${statusColor}"><span class="badge-dot"></span>${statusLabel}</span></td>
            </tr>`;
          }).join('') : `<tr><td colspan="7"><div class="empty"><div class="empty-icon">📋</div><p>لا يوجد سجلات بعد</p></div></td></tr>`}
        </tbody>
      </table>
    </div>`;
}

// ══════════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════════
function renderNotif(c) {
  const list = App.notifications;
  c.innerHTML = `
    <div class="section-title">🔔 التنبيهات الواردة</div>
    <div class="notif-list">
      ${list.length ? list.slice(0, 30).map(n => `
        <div class="notif-item ${n.type}">
          <div class="notif-icon">${n.icon}</div>
          <div class="notif-body">
            <div class="notif-title">${n.title}</div>
            <div class="notif-desc">${n.desc}</div>
            <div class="notif-time">${n.time}</div>
          </div>
        </div>`).join('') : `<div class="empty"><div class="empty-icon">🔕</div><p>لا توجد تنبيهات بعد</p></div>`}
    </div>`;
}

// ══════════════════════════════════════════════
//  ADMIN — DATA
// ══════════════════════════════════════════════
function renderAdminData(c) {
  const stages = App.meta.stages;
  c.innerHTML = `
    <div class="section-title">🏛️ المراحل والفصول</div>
    <div class="panel-card" style="margin-bottom:20px">
      <div class="panel-card-body">
        <div class="inline-form">
          <div><label>اسم المرحلة الجديدة</label><input type="text" id="new-stage-name" placeholder="مثال: أول متوسط"></div>
          <div><label>عدد الفصول</label><input type="number" id="new-stage-count" min="0" value="1"></div>
          <button class="btn btn-ghost" onclick="App.addStage()">➕ إضافة مرحلة</button>
        </div>
      </div>
    </div>
    ${stages.map(s => `
      <div class="panel-card" style="margin-bottom:16px">
        <div class="panel-card-header" style="justify-content:space-between">
          <span>${s.name}</span>
          <div class="admin-table-actions">
            <button class="btn-danger btn" style="width:auto" onclick="App.removeStage(${s.id})">🗑️ حذف المرحلة</button>
          </div>
        </div>
        <div class="panel-card-body">
          <div>${s.classes.map(cl => `<span class="class-chip">${cl.label} <button onclick="App.removeClass(${cl.id})">×</button></span>`).join('') || '<span style="color:var(--muted);font-size:13px">لا توجد فصول</span>'}</div>
          <div class="inline-form" style="margin-top:14px">
            <div><input type="text" id="add-class-${s.id}" placeholder="اسم/رقم الفصل الجديد"></div>
            <button class="btn btn-ghost" onclick="App.addClass(${s.id})">➕ إضافة فصل</button>
          </div>
        </div>
      </div>`).join('')}`;
}

App.addStage = async function () {
  const name = document.getElementById('new-stage-name').value.trim();
  const count = document.getElementById('new-stage-count').value;
  if (!name) { showToast('يرجى كتابة اسم المرحلة', 'yellow'); return; }
  try {
    await api('/api/admin/stages', { method: 'POST', body: JSON.stringify({ name, classCount: count }) });
    App.meta = await api('/api/meta');
    showToast('تمت إضافة المرحلة', 'green');
    renderTab();
  } catch (e) { showToast(e.message, 'red'); }
};
App.removeStage = async function (id) {
  if (!confirm('سيتم حذف المرحلة وجميع فصولها. متابعة؟')) return;
  await api(`/api/admin/stages/${id}`, { method: 'DELETE' });
  App.meta = await api('/api/meta');
  renderTab();
};
App.addClass = async function (stageId) {
  const input = document.getElementById(`add-class-${stageId}`);
  const label = input.value.trim();
  if (!label) return;
  try {
    await api(`/api/admin/stages/${stageId}/classes`, { method: 'POST', body: JSON.stringify({ label }) });
    App.meta = await api('/api/meta');
    renderTab();
  } catch (e) { showToast(e.message, 'red'); }
};
App.removeClass = async function (id) {
  await api(`/api/admin/classes/${id}`, { method: 'DELETE' });
  App.meta = await api('/api/meta');
  renderTab();
};

// ══════════════════════════════════════════════
//  ADMIN — ACCOUNTS
// ══════════════════════════════════════════════
let adminUsers = [];
async function loadAdminUsers() {
  const data = await api('/api/admin/users');
  adminUsers = data.users;
}

function renderAdminAccounts(c) {
  c.innerHTML = `<div class="section-title">👥 إدارة الحسابات</div><div id="accounts-body">جارٍ التحميل...</div>`;
  loadAdminUsers().then(() => renderAccountsBody());
}

function renderAccountsBody() {
  const body = document.getElementById('accounts-body');
  if (!body) return;
  const stageOptions = App.meta.stages.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  body.innerHTML = `
    <div class="panel-card" style="margin-bottom:20px">
      <div class="panel-card-header">➕ إنشاء حساب جديد</div>
      <div class="panel-card-body">
        <label>الاسم</label>
        <input type="text" id="new-user-name" placeholder="اسم المستخدم">
        <label>الدور</label>
        <select id="new-user-role" onchange="App.toggleStageField()">
          <option value="teacher">معلم</option>
          <option value="counselor">مرشد طلابي</option>
          <option value="deputy">وكيل شؤون الطلاب</option>
          <option value="admin">مدير النظام</option>
        </select>
        <div id="stage-field">
          <label>المرحلة (للمرشد)</label>
          <select id="new-user-stage"><option value="">اختر المرحلة</option>${stageOptions}</select>
        </div>
        <button class="btn btn-primary" onclick="App.createUser()">إنشاء الحساب وتوليد الرقم السري</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>الاسم</th><th>الدور</th><th>المرحلة</th><th>الحالة</th><th>إجراءات</th></tr></thead>
        <tbody>
          ${adminUsers.length ? adminUsers.map(u => `
            <tr>
              <td>${u.name}</td>
              <td>${ROLE_LABEL[u.role]}</td>
              <td>${u.stage_name || '-'}</td>
              <td><span class="badge ${u.active ? 'green' : 'red'}"><span class="badge-dot"></span>${u.active ? 'مفعل' : 'معطل'}</span></td>
              <td class="admin-table-actions">
                <button class="btn-small" style="background:var(--primary)" onclick="App.resetPin(${u.id})">🔑 إعادة تعيين الرقم</button>
                <button class="btn-small" style="background:${u.active ? 'var(--yellow)' : 'var(--green)'}" onclick="App.toggleActive(${u.id}, ${u.active ? 0 : 1})">${u.active ? 'تعطيل' : 'تفعيل'}</button>
                <button class="btn-small" style="background:var(--red)" onclick="App.deleteUser(${u.id})">حذف</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="5"><div class="empty"><p>لا يوجد مستخدمون بعد</p></div></td></tr>`}
        </tbody>
      </table>
    </div>`;
  App.toggleStageField();
}

App.toggleStageField = function () {
  const role = document.getElementById('new-user-role').value;
  document.getElementById('stage-field').style.display = role === 'counselor' ? 'block' : 'none';
};

function showPinModal(name, pin) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">تم إنشاء/تحديث حساب: ${name}</div>
      <div class="pin-reveal">
        <div class="pin-num">${pin}</div>
        <div class="pin-hint">هذا الرقم السري — يرجى تسليمه للمستخدم. لن يظهر مرة أخرى.</div>
      </div>
      <button class="btn btn-primary" id="pin-modal-close">تم</button>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('pin-modal-close').onclick = () => overlay.remove();
}

App.createUser = async function () {
  const name = document.getElementById('new-user-name').value.trim();
  const role = document.getElementById('new-user-role').value;
  const stageId = document.getElementById('new-user-stage').value;
  if (!name) { showToast('يرجى كتابة اسم المستخدم', 'yellow'); return; }
  if (role === 'counselor' && !stageId) { showToast('يرجى اختيار المرحلة للمرشد', 'yellow'); return; }
  try {
    const data = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ name, role, stageId: stageId ? Number(stageId) : null }) });
    showPinModal(name, data.pin);
    await loadAdminUsers();
    renderAccountsBody();
  } catch (e) { showToast(e.message, 'red'); }
};

App.resetPin = async function (id) {
  const u = adminUsers.find(x => x.id === id);
  const data = await api(`/api/admin/users/${id}/reset-pin`, { method: 'POST' });
  showPinModal(u ? u.name : '', data.pin);
};

App.toggleActive = async function (id, active) {
  await api(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
  await loadAdminUsers();
  renderAccountsBody();
};

App.deleteUser = async function (id) {
  if (!confirm('سيتم حذف الحساب نهائياً. متابعة؟')) return;
  await api(`/api/admin/users/${id}`, { method: 'DELETE' });
  await loadAdminUsers();
  renderAccountsBody();
};
