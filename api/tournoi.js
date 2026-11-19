'use strict';
// Point d'entrée Vercel : toutes les URL /api/* arrivent ici (voir vercel.json).
const { creerGestionnaire } = require('../vercel/requete');
const { stockageRedis } = require('../vercel/stockage');

module.exports = creerGestionnaire(stockageRedis);
