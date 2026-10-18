'use strict';
// Skills & Agenten – von allen KIs nutzbar.
// Skill  = wiederverwendbare Anleitung (SKILL.md mit name/description im Kopf, wie bei Claude Code)
// Agent  = feste Rolle: Anweisungen + Skills + bevorzugtes Modell/Rechte. Jede KI kann einen Agenten ausführen.
const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON, httpError } = require('./util');

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'neu';

function parseSkill(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, ''); }
  return { name: meta.name || '', description: meta.description || '', body: (m ? m[2] : text).trim() };
}
const skillText = ({ name, description, body }) =>
  `---\nname: ${String(name).replace(/\n/g, ' ')}\ndescription: ${String(description || '').replace(/\n/g, ' ')}\n---\n\n${String(body || '').trim()}\n`;

module.exports = function createLibrary({ root, dataDir }) {
  // Eingebaute Vorlagen (im Git) + eigene (data/) – eigene überschreiben eingebaute mit gleicher ID
  const dirs = {
    skills: [path.join(root, 'library', 'skills'), path.join(dataDir, 'skills')],
    agents: [path.join(root, 'library', 'agents'), path.join(dataDir, 'agents')],
  };
  fs.mkdirSync(dirs.skills[1], { recursive: true });
  fs.mkdirSync(dirs.agents[1], { recursive: true });

  // ---------- Skills ----------
  function listSkills() {
    const out = new Map();
    dirs.skills.forEach((d, i) => {
      if (!fs.existsSync(d)) return;
      for (const id of fs.readdirSync(d)) {
        const f = path.join(d, id, 'SKILL.md');
        if (!ID.test(id) || !fs.existsSync(f)) continue;
        const s = parseSkill(fs.readFileSync(f, 'utf8'));
        out.set(id, { id, name: s.name || id, description: s.description, builtin: i === 0, body: s.body });
      }
    });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  const getSkill = (id) => listSkills().find((s) => s.id === id) || null;

  function saveSkill({ id, name, description, body }) {
    if (!name || !String(name).trim()) throw httpError(400, 'Name fehlt');
    id = id && ID.test(id) ? id : slug(name);
    const dir = path.join(dirs.skills[1], id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillText({ name, description, body }));
    return getSkill(id);
  }
  function deleteSkill(id) {
    if (!ID.test(id)) throw httpError(400, 'Ungültige ID');
    fs.rmSync(path.join(dirs.skills[1], id), { recursive: true, force: true });
  }

  // ---------- Agenten ----------
  function listAgents() {
    const out = new Map();
    dirs.agents.forEach((d, i) => {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        const id = f.replace(/\.json$/, '');
        if (!f.endsWith('.json') || !ID.test(id)) continue;
        const a = readJSON(path.join(d, f), null);
        if (a) out.set(id, { icon: '◆', provider: '', model: '', mode: 'chat', skills: [], instructions: '', description: '', ...a, id, builtin: i === 0 });
      }
    });
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  const getAgent = (id) => listAgents().find((a) => a.id === id) || null;

  function saveAgent(a) {
    if (!a.name || !String(a.name).trim()) throw httpError(400, 'Name fehlt');
    const id = a.id && ID.test(a.id) ? a.id : slug(a.name);
    const clean = {
      name: String(a.name).trim(), icon: String(a.icon || '◆').slice(0, 4), description: String(a.description || ''),
      provider: String(a.provider || ''), model: String(a.model || ''),
      mode: ['chat', 'edit', 'full'].includes(a.mode) ? a.mode : 'chat',
      skills: Array.isArray(a.skills) ? a.skills.filter((s) => ID.test(s)) : [],
      instructions: String(a.instructions || ''),
    };
    writeJSON(path.join(dirs.agents[1], id + '.json'), clean);
    return getAgent(id);
  }
  function deleteAgent(id) {
    if (!ID.test(id)) throw httpError(400, 'Ungültige ID');
    fs.rmSync(path.join(dirs.agents[1], id + '.json'), { force: true });
  }

  // ---------- Prompt zusammensetzen ----------
  // Ergebnis: { prompt, provider, model, mode } – Agent-Vorgaben gelten, wenn nichts anderes verlangt ist
  function compose({ prompt, skills = [], agent, provider, model, mode }) {
    const a = agent ? getAgent(agent) : null;
    if (agent && !a) throw httpError(404, `Agent „${agent}“ nicht gefunden`);
    const ids = [...new Set([...(a ? a.skills : []), ...(skills || [])])];
    const found = ids.map(getSkill).filter(Boolean);
    let head = '';
    if (a) head += `# Deine Rolle: ${a.name}\n${a.instructions.trim()}\n\n`;
    if (found.length) {
      head += `# Skills\nBefolge diese Anleitungen, wo sie zur Aufgabe passen:\n\n` +
        found.map((s) => `## Skill: ${s.name}\n${s.body}`).join('\n\n') + '\n\n';
    }
    return {
      prompt: head ? `${head}# Aufgabe\n${prompt}` : prompt,
      provider: provider || (a && a.provider) || undefined,
      model: model || (a && a.model) || undefined,
      mode: mode || (a && a.mode) || undefined,
      agent: a, skills: found.map((s) => s.id),
    };
  }

  // Kurzkatalog für die Chef-KI (nur Name + Beschreibung – spart Tokens)
  function catalog() {
    return {
      skills: listSkills().map(({ id, name, description }) => ({ id, name, description })),
      agents: listAgents().map(({ id, name, description, provider, mode }) => ({ id, name, description, provider, mode })),
    };
  }

  return { listSkills, getSkill, saveSkill, deleteSkill, listAgents, getAgent, saveAgent, deleteAgent, compose, catalog, slug };
};
