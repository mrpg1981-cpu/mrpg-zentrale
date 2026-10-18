// Zentrale-SDK – in jedem Modul einbinden: <script src="/zentrale-sdk.js"></script>
(function () {
  const json = (r) => r.json();
  const moduleId = (location.pathname.match(/^\/modules\/([\w-]+)/) || [])[1] || 'zentrale';

  const zentrale = {
    moduleId,

    // KI über die CLIs. onChunk erhält Text-Stücke live.
    ki: {
      status: () => fetch('/api/ki/status').then(json),
      async ask({ provider = 'claude', prompt, model, onChunk, onLog, signal } = {}) {
        const res = await fetch('/api/ki/ask', {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, prompt, model }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '', full = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n'); buf = parts.pop();
          for (const part of parts) {
            const ev = (part.match(/^event: (.*)$/m) || [])[1];
            const raw = (part.match(/^data: (.*)$/m) || [])[1];
            if (!ev || raw == null) continue;
            const data = JSON.parse(raw);
            if (ev === 'chunk') { full += data; onChunk && onChunk(data, full); }
            else if (ev === 'log') onLog && onLog(data);
            else if (ev === 'error') throw new Error(data);
          }
        }
        return full;
      },
    },

    // Modul-eigener Speicher (liegt in data/store/<modul>.json)
    store: {
      get: () => fetch('/api/store/' + moduleId).then(json),
      set: (obj) => fetch('/api/store/' + moduleId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }).then(json),
    },

    // Nachrichten zwischen Modulen
    events: {
      emit: (type, payload) => fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload, from: moduleId }) }),
      on(type, fn) {
        const es = new EventSource('/api/events');
        es.onmessage = (e) => { const m = JSON.parse(e.data); if (type === '*' || m.type === type) fn(m.payload, m); };
        return () => es.close();
      },
    },

    info: () => fetch('/api/info').then(json),
    modules: () => fetch('/api/modules').then(json),

    // Dashboard steuern (z. B. anderes Modul öffnen)
    open: (id) => window.parent !== window && window.parent.postMessage({ zentrale: 'open', id }, '*'),
  };

  window.zentrale = zentrale;
})();
