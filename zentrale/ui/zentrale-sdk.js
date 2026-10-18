// Zentrale-SDK – in jedem Modul einbinden: <script src="/zentrale-sdk.js"></script>
(function () {
  const moduleId = (location.pathname.match(/^\/(?:modules|core)\/([\w-]+)/) || [])[1] || 'zentrale';

  async function api(method, url, body, raw) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {},
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    if (res.status === 401) { (window.top || window).location.href = '/login.html'; throw new Error('Nicht angemeldet'); }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }
  const q = (o) => new URLSearchParams(o).toString();

  // Server-Sent-Events per fetch lesen (POST-fähig)
  async function readSSE(res, handlers) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const part of parts) {
        const ev = (part.match(/^event: (.*)$/m) || [])[1];
        const raw = (part.match(/^data: (.*)$/m) || [])[1];
        if (ev && raw != null && handlers[ev]) handlers[ev](JSON.parse(raw));
      }
    }
  }

  function sharedHost() {
    try {
      if (window.parent !== window && window.parent.location.origin === location.origin && window.parent.zentrale) return window.parent.zentrale;
    } catch { /* anderes Fenster/Origin */ }
    return null;
  }

  // Ein gemeinsamer Event-Stream pro Seite
  let es = null;
  const evHandlers = new Set();
  function events() {
    if (!es) {
      es = new EventSource('/api/events');
      es.onmessage = (e) => { const m = JSON.parse(e.data); for (const h of evHandlers) h(m); };
    }
    return es;
  }

  const zentrale = {
    moduleId,
    api,

    // ---- KI über die CLIs (Abo-Login, keine API-Keys) ----
    ki: {
      status: () => api('GET', '/api/ki/status'),
      usage: (days = 30) => api('GET', '/api/ki/usage?days=' + days),
      login: (provider) => api('POST', '/api/ki/login', { provider }),
      logout: (provider) => api('POST', '/api/ki/logout', { provider }),
      install: (provider) => api('POST', '/api/ki/install', { provider }),
      // mode: 'chat' | 'edit' | 'full'; project: Ordner im Projektordner (Agent arbeitet dort)
      // session: nur Claude – Gespräch fortsetzen (kommt als result.session zurück)
      async ask({ provider, prompt, model, mode = 'chat', project, session, onChunk, onTool, onLog, signal } = {}) {
        if (!provider) provider = (await zentrale.settings.get()).defaultProvider || 'claude';
        const res = await fetch('/api/ki/ask', {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, prompt, model, mode, project, session }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        let full = '', error = null, done = null, sid = null;
        await readSSE(res, {
          session: (id) => { sid = id; },
          chunk: (t) => { full += t; onChunk && onChunk(t, full); },
          tool: (t) => onTool && onTool(t),
          log: (t) => onLog && onLog(t),
          error: (e) => { error = e; },
          done: (d) => { done = d; },
        });
        if (error && !full) throw new Error(error);
        return { text: full, error, session: sid, ...done };
      },
    },

    // ---- Dateien (nur innerhalb des Projektordners) ----
    fs: {
      list: (path = '') => api('GET', '/api/fs/list?' + q({ path })),
      read: (path) => api('GET', '/api/fs/read?' + q({ path })),
      rawUrl: (path) => '/api/fs/raw?' + q({ path }),
      write: (path, content) => api('PUT', '/api/fs/write', { path, content }),
      mkdir: (path) => api('POST', '/api/fs/mkdir', { path }),
      rename: (from, to) => api('POST', '/api/fs/rename', { from, to }),
      remove: (path) => api('DELETE', '/api/fs?' + q({ path })),
    },

    // ---- Prozesse ----
    run: {
      list: () => api('GET', '/api/procs'),
      start: ({ name, cmd, project }) => api('POST', '/api/procs', { name, cmd, project }),
      stop: (id) => api('POST', `/api/procs/${id}/stop`),
      remove: (id) => api('DELETE', `/api/procs/${id}`),
      // onLine({t,s,line}), onStatus(info) – gibt Funktion zum Beenden zurück
      follow(id, { onLine, onStatus } = {}) {
        const ctrl = new AbortController();
        fetch(`/api/procs/${id}/stream`, { signal: ctrl.signal })
          .then((res) => readSSE(res, { line: (l) => onLine && onLine(l), status: (s) => onStatus && onStatus(s) }))
          .catch(() => {});
        return () => ctrl.abort();
      },
    },

    // ---- Terminal ----
    terminal: {
      list: () => api('GET', '/api/terminals'),
      create: ({ project, title, input } = {}) => api('POST', '/api/terminals', { project, title, input }),
      kill: (id) => api('DELETE', '/api/terminals/' + id),
      socketUrl: (id) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal/${id}`,
    },

    // KI-Team: mehrere Modelle arbeiten zusammen
    team: {
      recipes: () => api('GET', '/api/team/recipes'),
      list: () => api('GET', '/api/team'),
      // { recipe: 'bauen'|'diskussion'|'zweitmeinung'|'kette', task, roles, project, mode, options }
      start: (opts) => api('POST', '/api/team', opts),
      stop: (id) => api('POST', `/api/team/${id}/stop`),
      remove: (id) => api('DELETE', `/api/team/${id}`),
      // onFull(run), onStep(step), onChunk({step,text}), onRun(summary)
      follow(id, { onFull, onStep, onChunk, onRun } = {}) {
        const ctrl = new AbortController();
        fetch(`/api/team/${id}/stream`, { signal: ctrl.signal })
          .then((res) => readSSE(res, { full: (r) => onFull && onFull(r), step: (s) => onStep && onStep(s), chunk: (c) => onChunk && onChunk(c), run: (r) => onRun && onRun(r) }))
          .catch(() => {});
        return () => ctrl.abort();
      },
    },

    projects: {
      list: () => api('GET', '/api/projects'),
      create: (name, clone) => api('POST', '/api/projects', { name, clone }),
    },
    system: () => api('GET', '/api/system'),

    // ---- Speicher: eigener (store.get()) oder gemeinsamer (store.get('prompts')) ----
    store: {
      get: (id = moduleId) => api('GET', '/api/store/' + id),
      set: (obj, id = moduleId) => api('PUT', '/api/store/' + id, obj),
      async update(fn, id = moduleId) { const cur = await zentrale.store.get(id); const next = (await fn(cur)) || cur; await zentrale.store.set(next, id); return next; },
    },

    settings: {
      get: () => api('GET', '/api/settings'),
      set: (patch) => api('PUT', '/api/settings', patch),
    },

    // ---- Nachrichten zwischen Modulen ----
    events: {
      emit: (type, payload) => api('POST', '/api/events', { type, payload, from: moduleId }),
      on(type, fn) {
        // Im Dashboard die Verbindung der Shell mitbenutzen – Browser erlauben nur ~6 offene Verbindungen pro Server
        const host = sharedHost();
        if (host) {
          const off = host.events.on(type, fn);
          window.addEventListener('pagehide', off);
          return off;
        }
        events();
        const h = (m) => { if (type === '*' || m.type === type) fn(m.payload, m); };
        evHandlers.add(h);
        return () => evHandlers.delete(h);
      },
    },

    // Toast im Dashboard anzeigen. type: info | ok | warn | err
    notify: (text, type = 'info') => zentrale.events.emit('notify', { text, type }),

    info: () => api('GET', '/api/info'),
    modules: () => api('GET', '/api/modules'),

    // Anderes Modul öffnen, optional mit Parametern (z. B. { project: 'xyz' })
    open(id, params) {
      if (window.parent !== window) window.parent.postMessage({ zentrale: 'open', id, params }, location.origin);
    },
    // Parameter empfangen, mit denen dieses Modul geöffnet wurde
    onParams(fn) {
      window.addEventListener('message', (e) => {
        if (e.origin === location.origin && e.data && e.data.zentrale === 'params') fn(e.data.params || {});
      });
      if (window.parent !== window) window.parent.postMessage({ zentrale: 'ready', id: moduleId }, location.origin);
    },
  };

  // Theme/Akzentfarbe aus den Einstellungen übernehmen
  zentrale.applyTheme = (s) => {
    const r = document.documentElement;
    r.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
    // Standard-Cyan ist auf hellem Hintergrund zu blass -> dunklere Variante
    const accent = s.theme === 'light' && (!s.accent || s.accent.toLowerCase() === '#67f5ff') ? '#0a8fa0' : s.accent || '#67f5ff';
    r.style.setProperty('--cyan', accent);
    r.style.setProperty('--cyan-soft', accent + '22');
  };
  zentrale.settings.get().then(zentrale.applyTheme).catch(() => {});
  zentrale.events.on('settings.changed', zentrale.applyTheme);

  // Hilfsfunktionen für Module
  zentrale.util = {
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    bytes: (n) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; },
    ago: (ms) => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'gerade eben' : s < 3600 ? `vor ${Math.floor(s / 60)} Min.` : s < 86400 ? `vor ${Math.floor(s / 3600)} Std.` : `vor ${Math.floor(s / 86400)} Tagen`; },
  };

  // Strg+K öffnet auch innerhalb eines Moduls die Befehlspalette
  if (window.parent !== window) {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); window.parent.postMessage({ zentrale: 'palette' }, location.origin); }
    });
  }

  window.zentrale = zentrale;
})();
