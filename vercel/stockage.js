'use strict';
// Stockage de data.json : Redis (Upstash, via son API REST, donc sans dépendance npm)
// ou mémoire (tests et essais en local).
//
// Écriture « optimiste » : on n'écrit que si personne d'autre n'a écrit entre-temps
// (numéro de version). Sinon l'appelant relit et rejoue la requête.

const SCRIPT_ECRITURE = `
local v = redis.call('GET', KEYS[2]) or '0'
if v ~= ARGV[1] then return -1 end
redis.call('SET', KEYS[1], ARGV[2])
return redis.call('INCR', KEYS[2])`;

function prefixeParDefaut(env) {
  // Production et Preview n'utilisent jamais les mêmes clés : une préprod
  // (ex. branche de synchro) ne peut pas abîmer les données du vrai tournoi.
  return env.TOURNOI_PREFIXE || ('tournoi:' + (env.VERCEL_ENV || 'local') + ':');
}

function stockageRedis(env = process.env) {
  const url = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const jeton = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !jeton) {
    const e = new Error('Base Redis non configurée : ajoutez Upstash Redis au projet Vercel (Storage > Marketplace)');
    e.code = 500; throw e;
  }
  const P = prefixeParDefaut(env);
  const K = { data: P + 'data', version: P + 'version' };

  async function appel(chemin, corps) {
    const r = await fetch(url + chemin, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jeton, 'Content-Type': 'application/json' },
      body: JSON.stringify(corps)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) { const e = new Error('Redis : ' + (d.error || r.status)); e.code = 503; throw e; }
    return d.result;
  }

  return {
    async lire(clesSupp = []) {
      const res = await appel('/', ['MGET', K.data, K.version, ...clesSupp.map(c => P + c)]);
      return { data: res[0], version: res[1] || '0', supp: res.slice(2) };
    },
    async ecrire(data, version) {
      const r = await appel('/', ['EVAL', SCRIPT_ECRITURE, '2', K.data, K.version, String(version), data]);
      return r !== -1;
    },
    async incrementer(cle, ttlSecondes) {
      await appel('/pipeline', [['INCR', P + cle], ['EXPIRE', P + cle, String(ttlSecondes), 'NX']]);
    },
    async sauvegarder(nom, contenu) {
      await appel('/', ['SET', P + 'sauvegarde:' + nom, contenu]);
    }
  };
}

function stockageMemoire() {
  const m = new Map();
  let version = 0;
  return {
    _m: m,
    async lire(clesSupp = []) {
      return { data: m.has('data') ? m.get('data') : null, version: String(version), supp: clesSupp.map(c => m.get(c) || null) };
    },
    async ecrire(data, v) {
      if (String(v) !== String(version)) return false;
      m.set('data', data); version++; return true;
    },
    async incrementer(cle) { m.set(cle, String(Number(m.get(cle) || 0) + 1)); },
    async sauvegarder(nom, contenu) { m.set('sauvegarde:' + nom, contenu); }
  };
}

module.exports = { stockageRedis, stockageMemoire };
