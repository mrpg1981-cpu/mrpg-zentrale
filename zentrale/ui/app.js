// Dashboard-Shell: Module, Tabs, Startseite, Toasts, Befehlspalette
(async function () {
  const $ = (s) => document.querySelector(s);
  const { esc, bytes, ago } = zentrale.util;
  const open = new Map(); // id -> { tab, frame, ready, pending }
  let modules = [];
  let projects = [];
  let active = 'home';
  let settings = {};

  // ---------- Tabs ----------
  function persist() {
    try { localStorage.setItem('zentrale.tabs', JSON.stringify({ open: [...open.keys()], active })); } catch {}
  }

  function activate(id) {
    active = id;
    $('#home').classList.toggle('active', id === 'home');
    for (const [mid, o] of open) {
      o.tab.classList.toggle('active', mid === id);
      o.frame.classList.toggle('active', mid === id);
    }
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    $('#side').classList.remove('mobile');
    const m = modules.find((x) => x.id === id);
    document.title = m ? `${m.name} · MRPG Zentrale` : 'MRPG Zentrale';
    if (id === 'home') refreshHome();
    persist();
  }

  function openModule(id, params) {
    const m = modules.find((x) => x.id === id);
    if (!m) return toast(`Modul „${id}“ nicht gefunden`, 'warn');
    let o = open.get(id);
    if (!o) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.innerHTML = `<span>${esc(m.icon)}</span><span>${esc(m.name)}</span><span class="x" title="Schließen">✕</span>`;
      tab.onclick = (e) => (e.target.classList.contains('x') ? closeModule(id) : activate(id));
      tab.onauxclick = (e) => { if (e.button === 1) closeModule(id); };
      const frame = document.createElement('iframe');
      frame.src = m.url;
      frame.title = m.name;
      $('#tabs').appendChild(tab);
      $('#views').appendChild(frame);
      o = { tab, frame, ready: false, pending: null };
      open.set(id, o);
    }
    if (params) {
      if (o.ready) o.frame.contentWindow.postMessage({ zentrale: 'params', params }, location.origin);
      else o.pending = params;
    }
    activate(id);
  }

  function closeModule(id) {
    const o = open.get(id);
    if (!o) return;
    o.tab.remove(); o.frame.remove(); open.delete(id);
    if (active === id) activate([...open.keys()].pop() || 'home');
    else persist();
  }

  // Nachrichten aus Modulen (öffnen, bereit)
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.zentrale === 'open') openModule(e.data.id, e.data.params);
    if (e.data.zentrale === 'ready') {
      const o = open.get(e.data.id);
      if (!o) return;
      o.ready = true;
      if (o.pending) { o.frame.contentWindow.postMessage({ zentrale: 'params', params: o.pending }, location.origin); o.pending = null; }
    }
  });

  // ---------- Toasts & Benachrichtigungen ----------
  function toast(text, type = 'info', onClick) {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = text;
    t.onclick = () => { if (onClick) onClick(); t.remove(); };
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'err' ? 9000 : 5000);
    if (settings.notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('MRPG Zentrale', { body: text, icon: '/icon.svg' });
    }
  }

  zentrale.events.on('*', (payload, m) => {
    $('#stEvt').textContent = `⇄ ${m.from}: ${m.type}`;
    if (m.type === 'notify') toast(payload.text, payload.type);
    if (m.type === 'proc.exit') {
      const ok = payload.status === 'fertig';
      if (payload.status !== 'gestoppt') toast(`${ok ? '✓' : '✕'} ${payload.name} ${ok ? 'fertig' : `beendet (Code ${payload.code})`}`, ok ? 'ok' : 'err', () => openModule('prozesse', { id: payload.id }));
    }
    // kurze Chef-Antworten aus dem KI-Chat nicht extra melden
    if (m.type === 'team.end' && !(payload.recipe === 'chef' && payload.stepCount <= 2)) {
      const ok = payload.status === 'fertig';
      toast(`⚭ KI-Team ${ok ? 'fertig' : payload.status}: ${payload.title}`, ok ? 'ok' : 'err', () => openModule('ki-team', { run: payload.id }));
    }
    if (m.type === 'settings.changed') settings = payload;
    if (active === 'home' && /^proc\./.test(m.type)) refreshProcs();
  });

  // ---------- Navigation ----------
  function renderNav() {
    const groups = {};
    for (const m of modules) (groups[m.group] = groups[m.group] || []).push(m);
    let html = `<button data-id="home"><span class="ic">⌂</span>Start</button>`;
    for (const [g, list] of Object.entries(groups)) {
      html += `<div class="grp">${esc(g)}</div>` + list.map((m) => `<button data-id="${esc(m.id)}"><span class="ic">${esc(m.icon)}</span>${esc(m.name)}</button>`).join('');
    }
    if (!modules.some((m) => !m.core)) html += `<div class="grp">Module</div><div class="hint">Noch keine eigenen Module.<br>Siehe <code>modules/_vorlage</code></div>`;
    $('#nav').innerHTML = html;
    $('#tiles').innerHTML = modules.map((m) => `<div class="card tile" data-id="${esc(m.id)}"><div class="ic">${esc(m.icon)}</div><b>${esc(m.name)}</b><div class="muted small">${esc(m.description || '')}</div></div>`).join('');
  }
  $('#nav').onclick = (e) => { const b = e.target.closest('button'); if (b) b.dataset.id === 'home' ? activate('home') : openModule(b.dataset.id); };
  $('#tiles').onclick = (e) => { const t = e.target.closest('.tile'); if (t) openModule(t.dataset.id); };
  document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openModule(b.dataset.open)));

  // ---------- Startseite ----------
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const barCls = (p) => (p > 90 ? 'err' : p > 75 ? 'warn' : '');

  async function refreshSys() {
    try {
      const s = await zentrale.system();
      const mem = pct(s.memTotal - s.memFree, s.memTotal);
      const disk = s.disks.find((d) => d.mount === '/') || s.disks[0];
      const dp = disk ? pct(disk.used, disk.size) : 0;
      const up = s.uptime > 86400 ? `${Math.floor(s.uptime / 86400)} T ${Math.floor((s.uptime % 86400) / 3600)} Std` : `${Math.floor(s.uptime / 3600)} Std ${Math.floor((s.uptime % 3600) / 60)} Min`;
      const dockerRun = s.docker ? s.docker.filter((c) => c.state === 'running').length : null;
      $('#sys').innerHTML = `
        <div class="card stat"><span class="muted">CPU (${s.cpus} Kerne)</span><b>${s.cpu}%</b><div class="bar ${barCls(s.cpu)}"><i style="width:${s.cpu}%"></i></div></div>
        <div class="card stat"><span class="muted">RAM</span><b>${mem}%</b><div class="bar ${barCls(mem)}"><i style="width:${mem}%"></i></div><div class="muted small" style="margin-top:6px">${bytes(s.memTotal - s.memFree)} / ${bytes(s.memTotal)}</div></div>
        ${disk ? `<div class="card stat"><span class="muted">Speicher ${esc(disk.mount)}</span><b>${dp}%</b><div class="bar ${barCls(dp)}"><i style="width:${dp}%"></i></div><div class="muted small" style="margin-top:6px">${bytes(disk.used)} / ${bytes(disk.size)}</div></div>` : ''}
        <div class="card stat"><span class="muted">${esc(s.host)}</span><b>${up}</b><div class="muted small">${s.inDocker ? 'Docker' : esc(s.platform)}${dockerRun !== null ? ` · ${dockerRun} Container aktiv` : ''}</div></div>`;
    } catch (e) { $('#sys').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  }

  async function refreshProjects() {
    try {
      const r = await zentrale.projects.list();
      projects = r.items;
      if (!r.exists) { $('#proj').innerHTML = `<div class="card">Projektordner <code>${esc(r.base)}</code> existiert nicht. <a href="#" data-open-set>In den Einstellungen ändern</a></div>`; return; }
      $('#proj').innerHTML = projects.slice(0, 6).map((p) => `
        <div class="card tile" data-proj="${esc(p.name)}">
          <div class="row"><b style="margin:0">${esc(p.name)}</b><span class="grow"></span>${p.git ? `<span class="badge ${p.git.changes ? 'warn' : 'ok'}">${esc(p.git.branch)}${p.git.changes ? ' · ' + p.git.changes : ''}</span>` : ''}</div>
          <div class="muted small" style="margin-top:6px">${p.git && p.git.last ? esc(p.git.last.subject) + ' · ' + esc(p.git.last.when) : p.type.join(', ') || 'Ordner'}</div>
        </div>`).join('') || `<div class="muted">Noch keine Projekte in <code>${esc(r.base)}</code>.</div>`;
    } catch (e) { $('#proj').innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  }
  $('#proj').onclick = (e) => {
    const t = e.target.closest('[data-proj]'); if (t) return openModule('projekte', { project: t.dataset.proj });
    if (e.target.closest('[data-open-set]')) { e.preventDefault(); openModule('einstellungen'); }
  };

  async function refreshKi() {
    const st = await zentrale.ki.status();
    $('#ki').innerHTML = st.map((p) => {
      const cls = !p.installed ? 'err' : p.loggedIn === false ? 'warn' : 'ok';
      const txt = !p.installed ? 'CLI nicht installiert' : p.loggedIn === false ? 'nicht angemeldet' : 'bereit';
      return `<div class="card tile" data-open-ki><div class="row"><span class="dot ${cls}"></span><b style="margin:0">${esc(p.name)}</b></div><div class="muted small" style="margin-top:6px">${txt}</div></div>`;
    }).join('');
    const ready = st.filter((p) => p.installed && p.loggedIn !== false).map((p) => p.name);
    $('#stKi').textContent = 'KI: ' + (ready.join(', ') || 'keine bereit');
  }
  $('#ki').onclick = (e) => { if (e.target.closest('[data-open-ki]')) openModule('ki-konten'); };

  async function refreshProcs() {
    const list = (await zentrale.run.list()).filter((p) => p.status === 'läuft');
    $('#procs').innerHTML = list.length
      ? `<table class="list card" style="padding:0">${list.map((p) => `<tr data-pid="${p.id}" style="cursor:pointer"><td><span class="dot ok"></span></td><td class="mono">${esc(p.name)}</td><td class="muted small">${ago(p.started)}</td></tr>`).join('')}</table>`
      : '<div class="muted">Keine laufenden Prozesse.</div>';
  }
  $('#procs').onclick = (e) => { const r = e.target.closest('[data-pid]'); if (r) openModule('prozesse', { id: r.dataset.pid }); };

  function refreshHome() { refreshSys(); refreshProjects(); refreshKi(); refreshProcs(); }
  setInterval(() => { if (active === 'home' && !document.hidden) refreshSys(); }, 5000);

  // ---------- Start ----------
  [modules, settings] = await Promise.all([zentrale.modules(), zentrale.settings.get()]);
  renderNav();
  const info = await zentrale.info();
  $('#stInfo').textContent = `v${info.version} · ${info.docker ? 'Docker' : info.platform}`;
  const h = new Date().getHours();
  $('#greet').textContent = `${h < 11 ? 'Guten Morgen' : h < 18 ? 'Hallo' : 'Guten Abend'} – alle Projekte, Apps und KI-Modelle an einem Ort.`;

  try {
    const saved = JSON.parse(localStorage.getItem('zentrale.tabs') || 'null');
    if (saved) { saved.open.forEach((id) => modules.some((m) => m.id === id) && openModule(id)); activate(open.has(saved.active) ? saved.active : 'home'); }
    else activate('home');
  } catch { activate('home'); }

  $('#brand').onclick = () => activate('home');
  $('#sideBtn').onclick = () => $('#side').classList.toggle('mobile');
  $('#logoutBtn').onclick = async () => { await zentrale.api('POST', '/api/auth/logout'); location.href = '/login.html'; };

  if (settings.notifications && 'Notification' in window && Notification.permission === 'default') {
    document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // ---------- Befehlspalette ----------
  const commands = () => [
    { label: '⌂ Start', run: () => activate('home') },
    ...modules.map((m) => ({ label: `${m.icon} ${m.name}`, run: () => openModule(m.id) })),
    ...projects.map((p) => ({ label: `▣ Projekt: ${p.name}`, run: () => openModule('projekte', { project: p.name }) })),
    ...projects.map((p) => ({ label: `⌨ Terminal in ${p.name}`, run: () => openModule('terminal', { project: p.name }) })),
    ...projects.map((p) => ({ label: `✦ KI-Agent in ${p.name}`, run: () => openModule('ki-chat', { project: p.name, mode: 'edit' }) })),
    ...projects.map((p) => ({ label: `⚭ KI-Team in ${p.name}`, run: () => openModule('ki-team', { project: p.name, recipe: 'bauen' }) })),
    ...[...open.keys()].map((id) => ({ label: `✕ ${id} schließen`, run: () => closeModule(id) })),
    { label: '⏻ Abmelden', run: () => $('#logoutBtn').click() },
  ];
  let sel = 0, list = [];
  function renderPal() {
    const words = $('#palIn').value.toLowerCase().split(/\s+/).filter(Boolean);
    list = commands().filter((c) => words.every((w) => c.label.toLowerCase().includes(w))).slice(0, 50);
    sel = Math.min(sel, Math.max(0, list.length - 1));
    $('#palList').innerHTML = list.map((c, i) => `<li class="${i === sel ? 'sel' : ''}" data-i="${i}">${esc(c.label)}</li>`).join('');
    const s = $('#palList .sel'); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  const pal = (show) => { $('#palette').classList.toggle('open', show); if (show) { $('#palIn').value = ''; sel = 0; renderPal(); $('#palIn').focus(); } };
  $('#palBtn').onclick = () => pal(true);
  $('#palette').onclick = (e) => { if (e.target.id === 'palette') pal(false); const li = e.target.closest('li'); if (li) { pal(false); list[li.dataset.i].run(); } };
  $('#palIn').oninput = () => { sel = 0; renderPal(); };
  $('#palIn').onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, list.length - 1); renderPal(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderPal(); e.preventDefault(); }
    if (e.key === 'Enter' && list[sel]) { pal(false); list[sel].run(); }
    if (e.key === 'Escape') pal(false);
  };
  const keys = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal(true); }
  };
  document.addEventListener('keydown', keys);
  // Strg+K auch innerhalb der Module abfangen
  window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.zentrale === 'palette') pal(true); });
})();
