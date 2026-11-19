'use strict';
// Adaptateur Vercel pour server.js, SANS modifier server.js.
//
// Principe : pour chaque requête, on exécute server.js dans un « bac à sable »
// où fs, http, os, child_process et process sont remplacés :
//   - config.json est fabriqué à partir des variables d'environnement Vercel ;
//   - data.json est lu depuis le stockage (Redis) avant la requête,
//     puis réécrit dans le stockage si server.js l'a modifié ;
//   - http.createServer() ne démarre rien : on récupère juste le « handler ».
// Ainsi les évolutions du projet d'origine (routes, règles, pages) sont
// reprises telles quelles, tant que server.js garde ce fonctionnement général.

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const http = require('http');
const Module = require('module');
const childProcess = require('child_process');
const { Readable, Writable } = require('stream');

const RACINE = path.join(__dirname, '..');
const SERVEUR = path.join(RACINE, 'server.js');
const PUBLIC_DIR = path.join(RACINE, 'public');
const CONFIG_FILE = path.join(RACINE, 'config.json');
const DATA_FILE = path.join(RACINE, 'data.json');
const DELAI_MAX_MS = 9000;

// ---------- configuration (remplace config.json) ----------
function configDepuisEnv(env = process.env) {
  const mdp = env.ADMIN_PASSWORD || env.MOT_DE_PASSE_ADMIN;
  if (!mdp) throw erreur(500, 'Variable ADMIN_PASSWORD absente dans Vercel (Settings > Environment Variables)');
  let extra = {};
  if (env.TOURNOI_CONFIG) {
    try { extra = JSON.parse(env.TOURNOI_CONFIG); }
    catch (e) { throw erreur(500, 'TOURNOI_CONFIG n’est pas du JSON valide'); }
  }
  const cfg = Object.assign({}, extra, { motDePasseAdmin: mdp, ouvrirNavigateur: false });
  if (env.NOM_TOURNOI) cfg.nomTournoi = env.NOM_TOURNOI;
  if (env.DELAI_MINUTES) cfg.delaiMinutes = Number(env.DELAI_MINUTES);
  return JSON.stringify(cfg);
}

// ---------- compilation de server.js (une seule fois par instance) ----------
let fonctionServeur = null;
function compiler() {
  if (!fonctionServeur) {
    const src = fs.readFileSync(SERVEUR, 'utf8').replace(/^#!.*/, '');
    fonctionServeur = vm.compileFunction(src,
      ['exports', 'require', 'module', '__filename', '__dirname', 'process'],
      { filename: SERVEUR });
  }
  return fonctionServeur;
}

function erreur(code, msg) { const e = new Error(msg); e.code = code; return e; }
function enoent(p) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; return e; }

// Tout fichier à la racine du projet (hors public/) est virtuel : config.json,
// data.json, .serveur.lock, sauvegardes « corrompu »… Le reste passe au vrai fs.
function estVirtuel(p) {
  const abs = path.resolve(String(p));
  return abs.startsWith(RACINE + path.sep) && !abs.startsWith(PUBLIC_DIR + path.sep) && abs !== SERVEUR;
}

function fabriquerFs(fichiers, journal) {
  const v = p => estVirtuel(p);
  const k = p => path.resolve(String(p));
  return Object.assign(Object.create(fs), {
    existsSync: p => v(p) ? fichiers.has(k(p)) : fs.existsSync(p),
    readFileSync: (p, o) => {
      if (!v(p)) return fs.readFileSync(p, o);
      if (!fichiers.has(k(p))) throw enoent(p);
      const s = fichiers.get(k(p));
      return (typeof o === 'string' || (o && o.encoding)) ? s : Buffer.from(s);
    },
    writeFileSync: (p, d) => {
      if (!v(p)) throw erreur('EROFS', 'Écriture refusée hors du stockage virtuel : ' + p);
      fichiers.set(k(p), String(d)); journal.ecrits.add(k(p));
    },
    renameSync: (a, b) => {
      if (!v(a) || !v(b)) throw erreur('EROFS', 'Renommage refusé : ' + a);
      if (!fichiers.has(k(a))) throw enoent(a);
      fichiers.set(k(b), fichiers.get(k(a))); fichiers.delete(k(a));
      journal.renommes.push([k(a), k(b)]); journal.ecrits.add(k(b));
    },
    unlinkSync: p => { if (v(p)) { fichiers.delete(k(p)); return; } throw erreur('EROFS', 'Suppression refusée : ' + p); }
  });
}

function fabriquerProcess() {
  const p = Object.create(process);
  Object.defineProperty(p, 'exitCode', { value: undefined, writable: true });
  Object.defineProperty(p, 'env', { value: Object.assign({}, process.env, { NO_BROWSER: '1' }) });
  p.on = p.once = p.addListener = function () { return p; };
  p.exit = c => { throw erreur(500, 'server.js a voulu s’arrêter (process.exit ' + c + ')'); };
  p.kill = () => { throw erreur('ESRCH', 'pas de processus'); };
  return p;
}

// ---------- exécution d'une requête ----------
// requete : { method, url, headers, body: Buffer }
// etat    : { data: string|null }  (contenu actuel de data.json)
async function executer(requete, etat, env = process.env) {
  const fichiers = new Map([[CONFIG_FILE, configDepuisEnv(env)]]);
  if (etat.data != null) fichiers.set(DATA_FILE, etat.data);
  const journal = { ecrits: new Set(), renommes: [] };
  const capture = {};

  const vraiRequire = Module.createRequire(SERVEUR);
  const modules = {
    fs: fabriquerFs(fichiers, journal),
    http: Object.assign(Object.create(http), {
      createServer(h) {
        capture.handler = h;
        const faux = { once: () => faux, on: () => faux, listen: () => faux, close: () => faux, address: () => null };
        return faux;
      }
    }),
    os: Object.assign(Object.create(os), { networkInterfaces: () => ({}) }),
    child_process: Object.assign(Object.create(childProcess), {
      exec: (c, o, cb) => { const f = typeof o === 'function' ? o : cb; if (f) f(null, '', ''); }
    })
  };
  const fauxRequire = nom => modules[String(nom).replace(/^node:/, '')] || vraiRequire(nom);
  const module = { exports: {} };
  compiler()(module.exports, fauxRequire, module, SERVEUR, RACINE, fabriquerProcess());

  const handler = capture.handler || module.exports.handler;
  if (typeof handler !== 'function') {
    throw erreur(500, 'server.js n’a pas créé de serveur HTTP : l’adaptateur Vercel doit être mis à jour');
  }

  const req = Readable.from(requete.body && requete.body.length ? [requete.body] : []);
  req.method = requete.method; req.url = requete.url; req.headers = requete.headers || {};
  const res = new FausseReponse();
  let minuteurId;
  const minuteur = new Promise((_, rej) => {
    minuteurId = setTimeout(() => rej(erreur(504, 'server.js n’a pas répondu')), DELAI_MAX_MS);
  });
  try {
    await Promise.race([Promise.resolve(handler(req, res)).then(() => res.fini), minuteur]);
  } finally { clearTimeout(minuteurId); }

  const sauvegardes = journal.renommes
    .filter(([a]) => a === DATA_FILE)
    .map(([, b]) => ({ nom: path.basename(b), contenu: fichiers.get(b) }));
  return {
    status: res.statusCode,
    headers: res.entetes,
    body: Buffer.concat(res.morceaux),
    nouvellesDonnees: journal.ecrits.has(DATA_FILE) ? fichiers.get(DATA_FILE) : null,
    sauvegardes
  };
}

class FausseReponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200; this.entetes = {}; this.morceaux = [];
    this.fini = new Promise(r => this.once('finish', r));
  }
  writeHead(code, h) { this.statusCode = code; Object.assign(this.entetes, h || {}); return this; }
  setHeader(k, v) { this.entetes[k] = v; }
  getHeader(k) { return this.entetes[k]; }
  _write(c, enc, cb) { this.morceaux.push(Buffer.isBuffer(c) ? c : Buffer.from(c, enc)); cb(); }
}

module.exports = { executer, configDepuisEnv, RACINE };
