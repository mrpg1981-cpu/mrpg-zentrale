'use strict';
// KI-Team: mehrere Modelle arbeiten mit festen Rollen nacheinander an einer Aufgabe.
// Läuft auf dem Server – ein Team arbeitet weiter, auch wenn der Browser-Tab zu ist.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { readJSON, writeJSON } = require('./util');

const MAX_CONTEXT = 40000; // Zeichen, die von einem Schritt an den nächsten weitergegeben werden
const clip = (s, n = MAX_CONTEXT) => (s && s.length > n ? s.slice(0, n) + '\n…(gekürzt)' : s || '');
const APPROVED = /\bFREIGABE\b/;

// ---------- Rezepte: wie das Team zusammenarbeitet ----------
const RECIPES = {
  bauen: {
    name: 'Planen → Bauen → Prüfen',
    description: 'Einer plant, einer setzt im Projekt um, einer prüft den Diff. Bei Mängeln bessert der Umsetzer nach – bis zur Freigabe.',
    needsProject: true,
    roles: [
      { key: 'planer', label: 'Planer', prefer: ['claude', 'gemini', 'codex'] },
      { key: 'umsetzer', label: 'Umsetzer', prefer: ['codex', 'claude', 'gemini'] },
      { key: 'pruefer', label: 'Prüfer', prefer: ['gemini', 'claude', 'codex'] },
    ],
    options: { rounds: 3 },
  },
  diskussion: {
    name: 'Diskussion',
    description: 'Alle Modelle antworten, lesen dann die Antworten der anderen, verbessern ihre eigene – ein Moderator fasst das beste Ergebnis zusammen.',
    needsProject: false,
    roles: [
      { key: 'teilnehmer', label: 'Teilnehmer', multi: true, prefer: ['claude', 'codex', 'gemini', 'ollama'] },
      { key: 'moderator', label: 'Moderator', prefer: ['claude', 'gemini', 'codex'] },
    ],
    options: { rounds: 2 },
  },
  zweitmeinung: {
    name: 'Zweitmeinung',
    description: 'Ein Modell antwortet, ein zweites kritisiert, das erste überarbeitet seine Antwort.',
    needsProject: false,
    roles: [
      { key: 'autor', label: 'Autor', prefer: ['claude', 'codex', 'gemini'] },
      { key: 'kritiker', label: 'Kritiker', prefer: ['gemini', 'codex', 'claude'] },
    ],
    options: {},
  },
  kette: {
    name: 'Eigene Kette',
    description: 'Eigene Schritte: jedes Modell bekommt die Aufgabe und das Ergebnis des vorherigen Schritts ({{aufgabe}}, {{vorher}}).',
    needsProject: false,
    roles: [],
    options: {},
  },
};

module.exports = function createTeam({ dataDir, ki, emit, resolveProject }) {
  const dir = path.join(dataDir, 'team');
  fs.mkdirSync(dir, { recursive: true });
  const runs = new Map();       // id -> run (nur im Speicher: aktive + zuletzt geladene)
  const subs = new Map();       // id -> Set(send)
  const children = new Map();   // id -> Set laufender CLI-Prozesse (Diskussion läuft parallel)

  const file = (id) => path.join(dir, id + '.json');
  const save = (run) => writeJSON(file(run.id), run);
  const publish = (run, event, data) => { for (const fn of subs.get(run.id) || []) fn(event, data); };
  const stepUpdate = (run, step) => { save(run); publish(run, 'step', step); };

  function setStatus(run, status, error) {
    run.status = status;
    if (error) run.error = error;
    if (status !== 'läuft') run.ended = Date.now();
    save(run);
    publish(run, 'run', summary(run));
    emit('team.' + (status === 'läuft' ? 'start' : 'end'), summary(run));
  }

  function summary(run) {
    const { steps, ...rest } = run;
    return { ...rest, stepCount: steps.length };
  }

  // Einen Schritt mit einer KI ausführen; Antwort live an Zuschauer streamen
  function runStep(run, { role, provider, mode = 'chat', prompt, title }) {
    if (run.cancel) return Promise.reject(new Error('abgebrochen'));
    const step = { id: run.steps.length + 1, role, title: title || role, provider, mode, prompt, output: '', tools: [], status: 'läuft', started: Date.now() };
    run.steps.push(step);
    stepUpdate(run, step);

    return new Promise((resolve, reject) => {
      let error = null, settled = false, lastPush = 0, child = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (children.has(run.id)) children.get(run.id).delete(child);
        step.ended = Date.now();
        step.status = run.cancel ? 'abgebrochen' : ok ? 'fertig' : 'fehler';
        if (error) step.error = error;
        stepUpdate(run, step);
        if (run.cancel) reject(new Error('abgebrochen'));
        else if (!ok) reject(new Error(`${provider}: ${error || 'keine Antwort'}`));
        else resolve(step.output);
      };
      try {
        child = ki.ask({ provider, prompt, mode, cwd: run.cwd }, (ev, data) => {
          if (ev === 'chunk') {
            step.output += data;
            publish(run, 'chunk', { step: step.id, text: data });
            if (Date.now() - lastPush > 3000) { lastPush = Date.now(); save(run); }
          } else if (ev === 'tool') {
            step.tools.push({ name: data.name, target: (data.input && (data.input.file_path || data.input.path || data.input.command)) || '' });
            publish(run, 'step', step);
          } else if (ev === 'error') error = data;
          else if (ev === 'done') finish(!!step.output.trim());
        });
      } catch (e) { error = e.message; return finish(false); }
      if (!children.has(run.id)) children.set(run.id, new Set());
      children.get(run.id).add(child);
      child.on('error', () => setTimeout(() => finish(false), 50));
    });
  }

  function gitDiff(cwd) {
    return new Promise((resolve) => {
      execFile('git', ['-C', cwd, 'diff', 'HEAD', '--stat', '--patch', '--no-color'], { maxBuffer: 20e6, timeout: 20000 }, (err, out) => {
        if (err) return resolve(null);
        execFile('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], { timeout: 10000 }, (e2, untracked) => {
          resolve(out + (untracked && untracked.trim() ? `\n\nNeue, nicht versionierte Dateien:\n${untracked}` : ''));
        });
      });
    });
  }

  // ---------- Abläufe der Rezepte ----------
  const FLOWS = {
    async bauen(run) {
      const { planer, umsetzer, pruefer } = run.roles;
      const rounds = Math.max(1, Math.min(6, Number(run.options.rounds) || 3));
      const plan = await runStep(run, {
        role: 'planer', provider: planer, title: 'Plan', mode: 'chat',
        prompt: `Du bist der PLANER in einem Team aus mehreren KIs. Ein anderes Modell setzt deinen Plan danach im Projekt um, ein drittes prüft das Ergebnis.\n` +
          `Sieh dir das Projekt im aktuellen Ordner an (nur lesen, nichts ändern) und erstelle einen konkreten, nummerierten Umsetzungsplan: betroffene Dateien, Schritte, Randfälle, wie man es testet.\n\nAUFGABE:\n${run.task}`,
      });
      let feedback = '';
      for (let r = 1; r <= rounds; r++) {
        await runStep(run, {
          role: 'umsetzer', provider: umsetzer, title: r === 1 ? 'Umsetzung' : `Nachbesserung ${r - 1}`, mode: run.mode,
          prompt: r === 1
            ? `Du bist der UMSETZER in einem KI-Team. Setze die Aufgabe im aktuellen Projekt um – ändere die Dateien direkt. Halte dich an den Plan des Planers, weiche nur ab, wenn er offensichtlich falsch ist (dann kurz begründen). Fasse am Ende zusammen, was du geändert hast.\n\nAUFGABE:\n${run.task}\n\nPLAN (vom Planer, ${planer}):\n${clip(plan)}`
            : `Du bist der UMSETZER in einem KI-Team. Der Prüfer hat deine Umsetzung NICHT freigegeben. Behebe die genannten Punkte direkt in den Dateien und fasse kurz zusammen, was du geändert hast.\n\nAUFGABE:\n${run.task}\n\nKRITIK DES PRÜFERS (${pruefer}):\n${clip(feedback)}`,
        });
        const diff = await gitDiff(run.cwd);
        const review = await runStep(run, {
          role: 'pruefer', provider: pruefer, title: `Prüfung ${r}`, mode: 'chat',
          prompt: `Du bist der PRÜFER in einem KI-Team. Prüfe kritisch, ob die Aufgabe korrekt und vollständig umgesetzt ist: Bugs, Randfälle, Sicherheit, Lesbarkeit. Du kannst die Dateien im aktuellen Ordner lesen.\n` +
            `Antworte mit einer kurzen Begründung. Wenn alles in Ordnung ist, schreibe in die LETZTE Zeile genau: FREIGABE\nSonst liste die konkreten Mängel nummeriert auf (ohne das Wort FREIGABE).\n\n` +
            `AUFGABE:\n${run.task}\n\nPLAN:\n${clip(plan, 15000)}\n\n` + (diff ? `ÄNDERUNGEN (git diff):\n${clip(diff)}` : 'Kein Git im Projekt – bitte die Dateien direkt ansehen.'),
        });
        if (APPROVED.test(review.split('\n').slice(-3).join('\n'))) { run.result = `✓ Vom Prüfer (${pruefer}) in Runde ${r} freigegeben.`; return; }
        feedback = review;
      }
      run.result = `⚠ Nach ${rounds} Runden keine Freigabe – letzte Kritik siehe Prüfung.`;
    },

    async diskussion(run) {
      const people = run.roles.teilnehmer;
      const rounds = Math.max(1, Math.min(4, Number(run.options.rounds) || 2));
      if (!people || people.length < 2) throw new Error('Für eine Diskussion mindestens zwei Teilnehmer wählen.');
      let answers = {};
      // Runde 1: alle gleichzeitig
      const first = await Promise.allSettled(people.map((p) => runStep(run, {
        role: 'teilnehmer', provider: p, title: `Runde 1 · ${p}`,
        prompt: `Du nimmst an einer Diskussion mehrerer KI-Modelle teil (${people.join(', ')}). Beantworte die Frage so gut du kannst. Danach siehst du die Antworten der anderen.\n\nFRAGE / AUFGABE:\n${run.task}`,
      })));
      first.forEach((r, i) => { if (r.status === 'fulfilled') answers[people[i]] = r.value; });
      if (run.cancel) throw new Error('abgebrochen');
      for (let r = 2; r <= rounds; r++) {
        const prev = answers;
        const next = {};
        const res = await Promise.allSettled(Object.keys(prev).map((p) => runStep(run, {
          role: 'teilnehmer', provider: p, title: `Runde ${r} · ${p}`,
          prompt: `Diskussion mehrerer KI-Modelle, Runde ${r}. Hier sind die bisherigen Antworten aller Teilnehmer.\n\n` +
            Object.entries(prev).map(([who, a]) => `=== ${who}${who === p ? ' (DU)' : ''} ===\n${clip(a, 12000)}`).join('\n\n') +
            `\n\nFRAGE / AUFGABE:\n${run.task}\n\nLies die anderen Antworten kritisch: Wo haben sie recht, wo irren sie? Gib danach deine VERBESSERTE Antwort. Übernimm Gutes, widersprich begründet.`,
        })));
        Object.keys(prev).forEach((p, i) => { if (res[i].status === 'fulfilled') next[p] = res[i].value; });
        if (run.cancel) throw new Error('abgebrochen');
        answers = Object.keys(next).length ? next : prev;
      }
      run.result = await runStep(run, {
        role: 'moderator', provider: run.roles.moderator, title: 'Ergebnis (Moderator)',
        prompt: `Du bist MODERATOR einer Diskussion mehrerer KI-Modelle. Fasse die beste, korrekte Gesamtantwort zusammen. Nenne kurz, wo sich die Modelle einig waren und wo nicht – und entscheide begründet.\n\nFRAGE / AUFGABE:\n${run.task}\n\n` +
          Object.entries(answers).map(([who, a]) => `=== ${who} ===\n${clip(a, 15000)}`).join('\n\n'),
      });
    },

    async zweitmeinung(run) {
      const { autor, kritiker } = run.roles;
      const draft = await runStep(run, { role: 'autor', provider: autor, title: 'Entwurf', mode: 'chat', prompt: run.task });
      const critique = await runStep(run, {
        role: 'kritiker', provider: kritiker, title: 'Kritik',
        prompt: `Du bist KRITIKER. Ein anderes KI-Modell (${autor}) hat folgende Antwort geschrieben. Finde Fehler, Lücken und Verbesserungen – konkret und nummeriert.\n\nAUFGABE:\n${run.task}\n\nANTWORT VON ${autor}:\n${clip(draft)}`,
      });
      run.result = await runStep(run, {
        role: 'autor', provider: autor, title: 'Überarbeitung',
        prompt: `Du hast diese Aufgabe beantwortet. Ein anderes KI-Modell (${kritiker}) hat deine Antwort kritisiert. Prüfe die Kritik, übernimm was stimmt, und gib die überarbeitete, finale Antwort.\n\nAUFGABE:\n${run.task}\n\nDEINE ANTWORT:\n${clip(draft)}\n\nKRITIK:\n${clip(critique)}`,
      });
    },

    async kette(run) {
      const steps = run.options.steps || [];
      if (!steps.length) throw new Error('Keine Schritte definiert.');
      const outs = [];
      for (const [i, s] of steps.entries()) {
        const tpl = s.prompt && s.prompt.trim() ? s.prompt : (i === 0 ? '{{aufgabe}}' : 'AUFGABE:\n{{aufgabe}}\n\nERGEBNIS DES VORHERIGEN SCHRITTS:\n{{vorher}}');
        const prompt = tpl
          .replace(/\{\{aufgabe\}\}/g, run.task)
          .replace(/\{\{vorher\}\}/g, clip(outs[outs.length - 1] || ''))
          .replace(/\{\{schritt:(\d+)\}\}/g, (_, n) => clip(outs[n - 1] || ''));
        outs.push(await runStep(run, { role: s.label || `Schritt ${i + 1}`, provider: s.provider, mode: run.cwd ? s.mode || 'chat' : 'chat', title: s.label || `Schritt ${i + 1}`, prompt }));
      }
      run.result = outs[outs.length - 1];
    },
  };

  // ---------- Öffentliche Funktionen ----------
  async function start({ recipe, task, roles = {}, project, mode = 'edit', options = {}, title }) {
    const R = RECIPES[recipe];
    if (!R) throw Object.assign(new Error('Unbekanntes Rezept'), { status: 400 });
    if (!task || !task.trim()) throw Object.assign(new Error('Aufgabe fehlt'), { status: 400 });
    if (R.needsProject && !project) throw Object.assign(new Error('Für dieses Rezept ein Projekt wählen'), { status: 400 });
    if (!['chat', 'edit', 'full'].includes(mode)) mode = 'edit';
    const known = Object.keys(ki.PROVIDERS);
    const valid = (p) => (Array.isArray(p) ? p.every((x) => known.includes(x)) : known.includes(p));
    for (const r of R.roles) if (!valid(roles[r.key])) throw Object.assign(new Error(`Rolle „${r.label}“: Modell wählen`), { status: 400 });
    if (recipe === 'kette') for (const s of options.steps || []) if (!known.includes(s.provider)) throw Object.assign(new Error('Jeder Schritt braucht ein Modell'), { status: 400 });

    const run = {
      id: Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      title: title || task.trim().split('\n')[0].slice(0, 70),
      recipe, task, roles, project: project || '', mode, options,
      cwd: project ? await resolveProject(project) : undefined,
      status: 'läuft', created: Date.now(), ended: null, steps: [], result: null, error: null,
    };
    runs.set(run.id, run);
    setStatus(run, 'läuft');
    FLOWS[recipe](run)
      .then(() => setStatus(run, 'fertig'))
      .catch((e) => setStatus(run, run.cancel ? 'abgebrochen' : 'fehler', run.cancel ? null : e.message));
    return summary(run);
  }

  function get(id) {
    if (!/^[\w]+$/.test(id)) return null;
    if (runs.has(id)) return runs.get(id);
    const r = readJSON(file(id), null);
    if (r && r.status === 'läuft') { r.status = 'abgebrochen'; r.error = 'Server wurde neu gestartet'; } // verwaister Lauf
    return r;
  }

  function list() {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => { const id = f.slice(0, -5); const r = runs.get(id) || get(id); return r && summary(r); })
      .filter(Boolean).sort((a, b) => b.created - a.created).slice(0, 100);
  }

  function stop(id) {
    const run = runs.get(id);
    if (!run || run.status !== 'läuft') return;
    run.cancel = true;
    for (const c of children.get(id) || []) try { c.kill('SIGTERM'); } catch {}
  }

  function remove(id) {
    stop(id);
    runs.delete(id);
    try { fs.unlinkSync(file(id)); } catch {}
  }

  function subscribe(id, send) {
    const run = get(id);
    if (!run) throw Object.assign(new Error('Team-Lauf nicht gefunden'), { status: 404 });
    send('full', run);
    if (!subs.has(id)) subs.set(id, new Set());
    subs.get(id).add(send);
    return () => subs.get(id) && subs.get(id).delete(send);
  }

  return { RECIPES, start, get, list, stop, remove, subscribe, stopAll: () => { for (const id of runs.keys()) stop(id); } };
};
