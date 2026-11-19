'use strict';
// Traitement d'une requête HTTP Vercel : lecture du stockage, exécution de
// server.js, écriture si besoin, et limitation des essais de code/mot de passe.

const { executer } = require('./adaptateur');

const ESSAIS_MAX = 5;              // relectures si deux écritures se croisent
const ECHECS_MAX = 10;             // essais ratés autorisés…
const FENETRE_ECHECS = 15 * 60;    // …par fenêtre de 15 minutes (secondes)

function lireCorps(req) {
  return new Promise((ok, ko) => {
    const morceaux = []; let taille = 0;
    req.on('data', c => { taille += c.length; if (taille > 1e6) { ko(Object.assign(new Error('Trop gros'), { code: 413 })); req.destroy(); } else morceaux.push(c); });
    req.on('end', () => ok(Buffer.concat(morceaux)));
    req.on('error', ko);
  });
}

function cheminDemande(req) {
  const u = new URL(req.url, 'http://x');
  const c = u.searchParams.get('chemin');
  return c != null ? '/api/' + c.replace(/^\/+/, '') : u.pathname;
}

// Clé de limitation : par IP ET par pseudo (les spectateurs d'un même WiFi
// partagent souvent la même IP publique, on ne doit pas les bloquer ensemble).
function cleLimite(ip, chemin, corps) {
  if (chemin.startsWith('/api/admin/')) return 'echecs:admin:' + ip;
  if (corps && corps.pin != null && corps.pseudo) return 'echecs:' + String(corps.pseudo).trim().toLowerCase().slice(0, 40) + ':' + ip;
  return null;
}

function estEchec(chemin, status, reponse) {
  if (status === 401 || status === 403) return true;
  // /api/state ne renvoie pas d'erreur sur un mauvais code, seulement connecte:false
  return chemin === '/api/state' && reponse && reponse.connecte === false;
}

function envoyer(res, status, entetes, corps) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(entetes || {})) res.setHeader(k, v);
  res.end(corps);
}
const json = (res, status, obj) => envoyer(res, status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(obj));

function creerGestionnaire(fabriquerStockage, env = process.env) {
  return async function (req, res) {
    try {
      const chemin = cheminDemande(req);
      if (!chemin.startsWith('/api/')) return json(res, 404, { error: 'Introuvable' });

      const brut = await lireCorps(req);
      let corps = null; try { corps = brut.length ? JSON.parse(brut.toString('utf8')) : {}; } catch (e) { /* server.js répondra 400 */ }
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
      const cle = cleLimite(ip, chemin, corps);
      const stockage = fabriquerStockage(env);

      for (let essai = 0; essai < ESSAIS_MAX; essai++) {
        const etat = await stockage.lire(cle ? [cle] : []);
        if (cle && Number(etat.supp[0] || 0) >= ECHECS_MAX) {
          return json(res, 429, { error: 'Trop d’essais ratés, réessayez dans 15 minutes' });
        }
        const r = await executer({
          method: req.method,
          url: chemin,
          headers: req.headers,
          body: brut
        }, etat, env);

        if (r.nouvellesDonnees != null) {
          // on retire l'indentation pour économiser la place dans Redis
          let compact = r.nouvellesDonnees;
          try { compact = JSON.stringify(JSON.parse(compact)); } catch (e) { /* tel quel */ }
          for (const s of r.sauvegardes) await stockage.sauvegarder(s.nom, s.contenu);
          if (!(await stockage.ecrire(compact, etat.version))) continue; // conflit : on rejoue
        }

        if (cle) {
          let rep = null; try { rep = JSON.parse(r.body.toString('utf8')); } catch (e) {}
          if (estEchec(chemin, r.status, rep)) await stockage.incrementer(cle, FENETRE_ECHECS);
        }
        const corpsRep = chemin === '/api/admin/state' && r.status === 200 ? adresseSite(r.body, req) : r.body;
        return envoyer(res, r.status, r.headers, corpsRep);
      }
      return json(res, 503, { error: 'Serveur très sollicité, réessayez' });
    } catch (e) {
      const code = e.code >= 400 && e.code < 600 ? e.code : 500;
      if (code >= 500) console.error(e);
      return json(res, code, { error: e.message });
    }
  };
}

// La page admin affiche « l'adresse à donner aux spectateurs » sous la forme
// http://<ip>:<port>. Sur Vercel on y met l'adresse du site (le port 80
// redirige automatiquement vers https).
function adresseSite(corps, req) {
  try {
    const d = JSON.parse(corps.toString('utf8'));
    const hote = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (hote) { d.ips = [hote]; d.port = 80; }
    return JSON.stringify(d);
  } catch (e) { return corps; }
}

module.exports = { creerGestionnaire, cheminDemande, cleLimite, estEchec };
