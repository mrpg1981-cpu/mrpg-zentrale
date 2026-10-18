'use strict';
// Passwortschutz: scrypt-Hash in settings.json, Sitzungen per HttpOnly-Cookie
const crypto = require('crypto');

const COOKIE = 'zentrale_sid';
const SESSION_DAYS = 30;

module.exports = function createAuth(settings) {
  const sessions = new Map(); // token -> ablauf
  const fails = new Map();    // ip -> { n, until }

  // Passwort per Umgebungsvariable vorgeben (z. B. in Docker)
  if (process.env.ZENTRALE_PASSWORD && !settings.get().passwordHash) setPassword(process.env.ZENTRALE_PASSWORD);

  function hash(pw, salt = crypto.randomBytes(16).toString('hex')) {
    return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
  }
  function verify(pw, stored) {
    const [salt, h] = String(stored).split(':');
    if (!salt || !h) return false;
    const a = Buffer.from(h, 'hex');
    const b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function setPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 4) throw Object.assign(new Error('Passwort muss mindestens 4 Zeichen haben'), { status: 400 });
    settings.setInternal('passwordHash', hash(pw));
    sessions.clear();
  }

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function newSession(res) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_DAYS * 864e5);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
  }

  return {
    isSetup: () => !!settings.get().passwordHash,

    isAuthed(req) {
      const t = parseCookies(req)[COOKIE];
      const exp = t && sessions.get(t);
      if (!exp) return false;
      if (exp < Date.now()) { sessions.delete(t); return false; }
      return true;
    },

    setup(pw, res) {
      if (settings.get().passwordHash) throw Object.assign(new Error('Passwort ist bereits gesetzt'), { status: 409 });
      setPassword(pw);
      newSession(res);
    },

    login(pw, req, res) {
      const ip = req.socket.remoteAddress;
      const f = fails.get(ip);
      if (f && f.until > Date.now()) throw Object.assign(new Error('Zu viele Versuche – bitte kurz warten'), { status: 429 });
      if (!verify(pw || '', settings.get().passwordHash)) {
        const n = (f ? f.n : 0) + 1;
        fails.set(ip, { n, until: n >= 5 ? Date.now() + 60e3 : 0 });
        throw Object.assign(new Error('Falsches Passwort'), { status: 401 });
      }
      fails.delete(ip);
      newSession(res);
    },

    logout(req, res) {
      sessions.delete(parseCookies(req)[COOKIE]);
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    },

    change(oldPw, newPw, res) {
      if (!verify(oldPw || '', settings.get().passwordHash)) throw Object.assign(new Error('Altes Passwort falsch'), { status: 401 });
      setPassword(newPw);
      newSession(res);
    },
  };
};
