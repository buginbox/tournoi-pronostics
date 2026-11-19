'use strict';
// Tests de la couche Vercel, lancés par GitHub Actions à chaque synchro avec le
// projet d'origine : s'ils échouent, c'est que server.js a changé d'une façon
// que l'adaptateur ne sait pas encore gérer.
//   node --test vercel/

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { creerGestionnaire } = require('./requete');
const { stockageMemoire } = require('./stockage');

const ENV = { ADMIN_PASSWORD: 'secret-de-test', NOM_TOURNOI: 'Tournoi test', DELAI_MINUTES: '0' };

async function demarrer(memoire = stockageMemoire(), env = ENV) {
  const srv = http.createServer(creerGestionnaire(() => memoire, env));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const api = async (chemin, corps, entetes = {}) => {
    const r = await fetch(base + chemin, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, entetes), body: JSON.stringify(corps || {}) });
    return { status: r.status, d: await r.json() };
  };
  return { srv, api, memoire };
}

test('aucun fichier n’est écrit sur le disque', async () => {
  const { srv, api } = await demarrer();
  try {
    await api('/api/state');
    await api('/api/entrer', { pseudo: 'Alice', pin: '1234' });
    const racine = path.join(__dirname, '..');
    for (const f of ['data.json', 'config.json', '.serveur.lock']) {
      assert.ok(!fs.existsSync(path.join(racine, f)), f + ' ne doit pas être créé');
    }
  } finally { srv.close(); }
});

test('parcours complet : compte, prono, résultat, classement', async () => {
  const { srv, api, memoire } = await demarrer();
  try {
    let r = await api('/api/state');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.d.nomTournoi, 'Tournoi test');
    assert.ok(r.d.matchs.length > 0, 'calendrier généré');
    const m = r.d.matchs[0];

    r = await api('/api/entrer', { pseudo: 'Alice', pin: '1234' });
    assert.deepStrictEqual(r.d, { pseudo: 'Alice', cree: true });

    r = await api('/api/prono', { pseudo: 'Alice', pin: '1234', matchId: m.id, score: '3-2' });
    assert.strictEqual(r.status, 200);

    r = await api('/api/admin/resultat', { password: 'mauvais', matchId: m.id, score: '3-2' });
    assert.strictEqual(r.status, 403);

    // avec DELAI_MINUTES=0, un prono placé juste avant compte ; on attend 5 ms
    await new Promise(ok => setTimeout(ok, 5));
    r = await api('/api/admin/resultat', { password: 'secret-de-test', matchId: m.id, score: '3-2' });
    assert.strictEqual(r.status, 200);

    r = await api('/api/state', { pseudo: 'Alice', pin: '1234' });
    assert.strictEqual(r.d.connecte, true);
    assert.strictEqual(r.d.classementParieurs[0].points, 1);

    // les données sont bien dans le stockage, pas en mémoire du module
    const enregistre = JSON.parse(memoire._m.get('data'));
    assert.ok(enregistre.parieurs.alice);
  } finally { srv.close(); }
});

test('admin : adresse du site à la place de l’IP locale', async () => {
  const { srv, api } = await demarrer();
  try {
    const r = await api('/api/admin/state', { password: 'secret-de-test' }, { 'X-Forwarded-Host': 'mon-tournoi.vercel.app' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.d.ips, ['mon-tournoi.vercel.app']);
  } finally { srv.close(); }
});

test('écritures concurrentes : aucune perte', async () => {
  const { srv, api, memoire } = await demarrer();
  try {
    await api('/api/state');
    const noms = Array.from({ length: 15 }, (_, i) => 'Joueur' + i);
    await Promise.all(noms.map(n => api('/api/entrer', { pseudo: n, pin: '0000' })));
    const d = JSON.parse(memoire._m.get('data'));
    assert.strictEqual(Object.keys(d.parieurs).length, 15);
  } finally { srv.close(); }
});

test('trop de codes faux : blocage temporaire', async () => {
  const { srv, api } = await demarrer();
  try {
    await api('/api/entrer', { pseudo: 'Bob', pin: '1111' });
    let dernier;
    for (let i = 0; i < 12; i++) dernier = await api('/api/state', { pseudo: 'Bob', pin: String(2000 + i) });
    assert.strictEqual(dernier.status, 429);
    // un autre pseudo depuis la même IP n'est pas bloqué
    const autre = await api('/api/state', { pseudo: 'Carole', pin: '1234' });
    assert.strictEqual(autre.status, 200);
  } finally { srv.close(); }
});

test('sans ADMIN_PASSWORD : erreur claire', async () => {
  const { srv, api } = await demarrer(stockageMemoire(), {});
  try {
    const r = await api('/api/state');
    assert.strictEqual(r.status, 500);
    assert.match(r.d.error, /ADMIN_PASSWORD/);
  } finally { srv.close(); }
});

test('chemin réécrit par Vercel (?chemin=…)', async () => {
  const { srv } = await demarrer();
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/tournoi?chemin=state`, { method: 'POST', body: '{}' });
    assert.strictEqual(r.status, 200);
    assert.ok((await r.json()).matchs);
  } finally { srv.close(); }
});

test('client Redis (API REST Upstash simulée)', async () => {
  const { stockageRedis } = require('./stockage');
  const kv = new Map(); const vus = [];
  const faux = http.createServer((req, res) => {
    let s = ''; req.on('data', c => s += c); req.on('end', () => {
      assert.strictEqual(req.headers.authorization, 'Bearer jeton');
      const exec = ([cmd, ...a]) => {
        vus.push(cmd);
        if (cmd === 'MGET') return a.map(k => kv.has(k) ? kv.get(k) : null);
        if (cmd === 'SET') { kv.set(a[0], a[1]); return 'OK'; }
        if (cmd === 'INCR') { const v = Number(kv.get(a[0]) || 0) + 1; kv.set(a[0], String(v)); return v; }
        if (cmd === 'EXPIRE') return 1;
        if (cmd === 'EVAL') { // reproduit le script d'écriture optimiste
          const [, , kData, kVer, attendu, data] = a;
          if ((kv.get(kVer) || '0') !== attendu) return -1;
          kv.set(kData, data); return exec(['INCR', kVer]);
        }
        throw new Error('commande inattendue ' + cmd);
      };
      const corps = JSON.parse(s);
      const out = req.url === '/pipeline' ? corps.map(c => ({ result: exec(c) })) : { result: exec(corps) };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(out));
    });
  });
  await new Promise(r => faux.listen(0, '127.0.0.1', r));
  try {
    const env = Object.assign({}, ENV, { KV_REST_API_URL: 'http://127.0.0.1:' + faux.address().port, KV_REST_API_TOKEN: 'jeton', VERCEL_ENV: 'production' });
    const { srv, api } = await demarrer(null, env);
    srv.removeAllListeners('request');
    srv.on('request', creerGestionnaire(stockageRedis, env));
    try {
      assert.strictEqual((await api('/api/entrer', { pseudo: 'Dan', pin: '4321' })).status, 200);
      assert.ok(JSON.parse(kv.get('tournoi:production:data')).parieurs.dan, 'données écrites sous le préfixe production');
      assert.strictEqual(kv.get('tournoi:production:version'), '1'); // une seule écriture par requête
      await api('/api/state', { pseudo: 'Dan', pin: '0000' });
      assert.strictEqual(kv.get('tournoi:production:echecs:dan:127.0.0.1'), '1');
      assert.ok(vus.includes('EVAL'));
    } finally { srv.close(); }
  } finally { faux.close(); }
});
