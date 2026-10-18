// Dashboard-Shell: Module laden, Tabs verwalten, Befehlspalette
(async function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const open = new Map(); // id -> { tab, frame }
  let modules = [];
  let active = 'home';

  function activate(id) {
    active = id;
    $('#home').classList.toggle('active', id === 'home');
    for (const [mid, o] of open) {
      o.tab.classList.toggle('active', mid === id);
      o.frame.classList.toggle('active', mid === id);
    }
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
    $('#side').classList.remove('mobile');
    try { localStorage.setItem('zentrale.tabs', JSON.stringify({ open: [...open.keys()], active })); } catch {}
  }

  function openModule(id) {
    const m = modules.find((x) => x.id === id);
    if (!m) return;
    if (!open.has(id)) {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.innerHTML = `<span>${esc(m.icon)}</span><span>${esc(m.name)}</span><span class="x" title="Schließen">✕</span>`;
      tab.onclick = (e) => (e.target.classList.contains('x') ? closeModule(id) : activate(id));
      const frame = document.createElement('iframe');
      frame.src = m.url;
      frame.title = m.name;
      $('#tabs').appendChild(tab);
      $('#views').appendChild(frame);
      open.set(id, { tab, frame });
    }
    activate(id);
  }

  function closeModule(id) {
    const o = open.get(id);
    if (!o) return;
    o.tab.remove(); o.frame.remove(); open.delete(id);
    if (active === id) activate([...open.keys()].pop() || 'home');
  }

  // Module laden
  modules = await zentrale.modules();
  $('#nav').innerHTML = `<button data-id="home">⌂ Start</button>` +
    modules.map((m) => `<button data-id="${esc(m.id)}">${esc(m.icon)} ${esc(m.name)}</button>`).join('');
  $('#nav').onclick = (e) => { const b = e.target.closest('button'); if (b) b.dataset.id === 'home' ? activate('home') : openModule(b.dataset.id); };
  $('#tiles').innerHTML = modules.map((m) => `<div class="card tile" data-id="${esc(m.id)}"><div class="ic">${esc(m.icon)}</div><b>${esc(m.name)}</b><div class="muted">${esc(m.description || '')}</div></div>`).join('')
    || '<div class="muted">Noch keine Module in <code>modules/</code>.</div>';
  $('#tiles').onclick = (e) => { const t = e.target.closest('.tile'); if (t) openModule(t.dataset.id); };

  // KI-Status
  async function refreshKi() {
    const st = await zentrale.ki.status();
    $('#ki').innerHTML = st.map((p) => {
      const cls = !p.installed ? 'err' : p.loggedIn === false ? 'warn' : 'ok';
      const txt = !p.installed ? 'CLI nicht gefunden' : p.loggedIn === false ? `nicht angemeldet – <code>node server.js login ${p.id}</code>` : 'bereit';
      return `<div class="card"><div class="ki-row"><span class="dot ${cls}"></span><b>${esc(p.name)}</b></div><div class="muted" style="margin-top:6px">${txt}</div></div>`;
    }).join('');
    $('#stKi').textContent = 'KI: ' + st.filter((p) => p.installed).map((p) => p.name).join(', ') || 'KI: keine';
  }
  refreshKi();

  const info = await zentrale.info();
  $('#stInfo').textContent = `v${info.version} · ${info.docker ? 'Docker' : info.platform}`;

  zentrale.events.on('*', (payload, m) => { $('#stEvt').textContent = `⇄ ${m.from}: ${m.type}`; });

  // Module dürfen andere Module öffnen
  window.addEventListener('message', (e) => { if (e.data && e.data.zentrale === 'open') openModule(e.data.id); });

  // Tabs wiederherstellen
  try {
    const saved = JSON.parse(localStorage.getItem('zentrale.tabs') || 'null');
    if (saved) { saved.open.forEach(openModule); activate(open.has(saved.active) ? saved.active : 'home'); }
  } catch {}

  $('#brand').onclick = () => activate('home');
  $('#sideBtn').onclick = () => $('#side').classList.toggle('mobile');

  // Befehlspalette
  const commands = () => [
    { label: '⌂ Start', run: () => activate('home') },
    ...modules.map((m) => ({ label: `${m.icon} ${m.name}`, run: () => openModule(m.id) })),
    { label: '↻ KI-Status aktualisieren', run: refreshKi },
    ...[...open.keys()].map((id) => ({ label: `✕ ${id} schließen`, run: () => closeModule(id) })),
  ];
  let sel = 0, list = [];
  function renderPal() {
    const q = $('#palIn').value.toLowerCase();
    list = commands().filter((c) => c.label.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, list.length - 1));
    $('#palList').innerHTML = list.map((c, i) => `<li class="${i === sel ? 'sel' : ''}" data-i="${i}">${esc(c.label)}</li>`).join('');
  }
  const pal = (show) => { $('#palette').classList.toggle('open', show); if (show) { $('#palIn').value = ''; sel = 0; renderPal(); $('#palIn').focus(); } };
  $('#palBtn').onclick = () => pal(true);
  $('#palette').onclick = (e) => { if (e.target.id === 'palette') pal(false); const li = e.target.closest('li'); if (li) { list[li.dataset.i].run(); pal(false); } };
  $('#palIn').oninput = () => { sel = 0; renderPal(); };
  $('#palIn').onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, list.length - 1); renderPal(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderPal(); e.preventDefault(); }
    if (e.key === 'Enter' && list[sel]) { list[sel].run(); pal(false); }
    if (e.key === 'Escape') pal(false);
  };
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal(true); } });
})();
