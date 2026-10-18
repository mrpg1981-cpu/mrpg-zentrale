'use strict';
// KI-Hub: ruft die offiziellen CLIs mit Abo-Login auf – keine API-Keys
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readJSON, writeJSON } = require('./util');

// mode: 'chat' = nur antworten, 'edit' = Dateien ändern erlaubt, 'full' = alles erlaubt (auch Befehle)
const PROVIDERS = {
  claude: {
    name: 'Claude', bin: 'claude', login: [], agent: true, npm: '@anthropic-ai/claude-code',
    env: (auth) => ({ CLAUDE_CONFIG_DIR: auth }),
    args: (p, o) => [
      '-p', p, '--output-format', 'stream-json', '--verbose',
      ...(o.model ? ['--model', o.model] : []),
      ...(o.session ? ['--resume', o.session] : []),
      ...(o.mode === 'edit' ? ['--permission-mode', 'acceptEdits'] : o.mode === 'full' ? ['--dangerously-skip-permissions'] : []),
    ],
    parse: 'claude-json',
  },
  codex: {
    name: 'Codex', bin: 'codex', login: ['login'], agent: true, npm: '@openai/codex',
    env: (auth) => ({ CODEX_HOME: auth }),
    args: (p, o) => [
      'exec', '--skip-git-repo-check',
      ...(o.mode === 'edit' ? ['--full-auto'] : o.mode === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']),
      ...(o.model ? ['-m', o.model] : []), p,
    ],
    parse: 'text',
  },
  gemini: {
    name: 'Gemini', bin: 'gemini', login: [], agent: true, npm: '@google/gemini-cli',
    env: (auth) => ({ HOME: auth, USERPROFILE: auth }),
    args: (p, o) => [
      ...(o.model ? ['-m', o.model] : []),
      ...(o.mode === 'edit' ? ['--approval-mode', 'auto_edit'] : o.mode === 'full' ? ['--yolo'] : []),
      '-p', p,
    ],
    parse: 'text',
  },
  ollama: {
    name: 'Ollama (lokal)', bin: 'ollama', login: null, agent: false,
    env: () => ({}),
    args: (p, o) => ['run', o.model || 'llama3.2', p],
    parse: 'text',
  },
};

module.exports = function createKi({ dataDir, runEnv, which }) {
  const authDir = (id) => path.join(dataDir, 'auth', id);
  const usageFile = path.join(dataDir, 'usage.json');

  function track(id, extra = {}) {
    const u = readJSON(usageFile, {});
    const day = new Date().toISOString().slice(0, 10);
    const d = (u[day] = u[day] || {});
    const p = (d[id] = d[id] || { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, seconds: 0 });
    p.requests += extra.requests || 0;
    p.costUsd += extra.costUsd || 0;
    p.inputTokens += extra.inputTokens || 0;
    p.outputTokens += extra.outputTokens || 0;
    p.seconds += extra.seconds || 0;
    // nur die letzten 90 Tage behalten
    for (const k of Object.keys(u).sort().slice(0, -90)) delete u[k];
    writeJSON(usageFile, u);
  }

  function status() {
    return Object.entries(PROVIDERS).map(([id, p]) => {
      const bin = which(p.bin);
      let loggedIn = null;
      if (p.login) {
        const d = authDir(id);
        loggedIn = fs.existsSync(d) && fs.readdirSync(d).length > 0;
      }
      return { id, name: p.name, installed: !!bin, path: bin, loggedIn, agent: p.agent, installable: !!p.npm };
    });
  }

  // Claude stream-json in einheitliche Ereignisse übersetzen
  function claudeEvents(line, send, stats) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) send('session', m.session_id);
    else if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type === 'text' && c.text) send('chunk', c.text);
        if (c.type === 'tool_use') send('tool', { name: c.name, input: c.input });
      }
    } else if (m.type === 'result') {
      if (m.is_error) send('error', m.result || 'Claude meldet einen Fehler');
      stats.costUsd = m.total_cost_usd || 0;
      if (m.usage) { stats.inputTokens = m.usage.input_tokens || 0; stats.outputTokens = m.usage.output_tokens || 0; }
    }
  }

  // Startet eine Anfrage. send(event, data) bekommt: session, chunk, tool, log, error, done
  function ask({ provider = 'claude', prompt, model, mode = 'chat', cwd, session }, send) {
    const p = PROVIDERS[provider];
    if (!p) throw Object.assign(new Error('Unbekanntes Modell: ' + provider), { status: 400 });
    if (!prompt) throw Object.assign(new Error('Prompt fehlt'), { status: 400 });
    if (mode !== 'chat' && !p.agent) throw Object.assign(new Error(`${p.name} kann nicht als Agent arbeiten`), { status: 400 });
    if (p.login) fs.mkdirSync(authDir(provider), { recursive: true });

    const started = Date.now();
    const stats = {};
    const child = spawn(p.bin, p.args(prompt, { model, mode, session: typeof session === 'string' && /^[\w-]+$/.test(session) ? session : null }), {
      cwd: cwd || dataDir,
      env: { ...runEnv(), ...p.env(authDir(provider)), NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let buf = '';
    let sentText = false;
    child.stdout.on('data', (d) => {
      if (p.parse === 'text') { sentText = true; return send('chunk', d.toString()); }
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) claudeEvents(l, (e, x) => { if (e === 'chunk') sentText = true; send(e, x); }, stats);
    });
    // Ollama schreibt Fortschrittsbalken nach stderr – das ist kein Fehler
    child.stderr.on('data', (d) => send('log', d.toString()));
    child.on('error', (e) => {
      send('error', e.code === 'ENOENT' ? `${p.name}-CLI nicht gefunden – installieren oder in runtime/bin ablegen.` : e.message);
    });
    child.on('close', (code) => {
      if (buf) claudeEvents(buf, send, stats);
      track(provider, { requests: 1, seconds: Math.round((Date.now() - started) / 1000), ...stats });
      send('done', { code, sentText, seconds: (Date.now() - started) / 1000, costUsd: stats.costUsd || 0 });
    });
    return child;
  }

  function usage(days = 30) {
    const u = readJSON(usageFile, {});
    return Object.keys(u).sort().slice(-days).map((day) => ({ day, ...u[day] }));
  }

  function loginCommand(id) {
    const p = PROVIDERS[id];
    if (!p || !p.login) return null;
    fs.mkdirSync(authDir(id), { recursive: true });
    return { bin: p.bin, args: p.login, env: p.env(authDir(id)), name: p.name };
  }

  // Installiert die CLI portabel nach data/npm-global (liegt im PATH der Zentrale)
  function installCommand(id) {
    const p = PROVIDERS[id];
    if (!p || !p.npm) return null;
    const prefix = path.join(dataDir, 'npm-global');
    return `npm install -g --prefix ${JSON.stringify(prefix)} ${p.npm}@latest`;
  }

  // Anmeldung entfernen (Ordner data/auth/<id> leeren)
  function logout(id) {
    if (!PROVIDERS[id] || !PROVIDERS[id].login) return;
    fs.rmSync(authDir(id), { recursive: true, force: true });
  }

  return { PROVIDERS, status, ask, usage, loginCommand, installCommand, logout, authDir };
};
