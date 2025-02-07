// db.js
import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';
dotenv.config();

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Fonction de normalisation d'un nom de jeu
function normalizeGameName(name) {
  let normalized = name.toLowerCase();
  normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // Retire les accents
  normalized = normalized.replace(/[^a-z0-9]/g, ''); // Supprime les caractères spéciaux
  normalized = normalized.replace(/(.)\1+/g, '$1'); // Supprime les répétitions de lettres
  return normalized;
}

/**
 * Ajoute un jeu s'il n'existe pas déjà (comparaison "floue")
 * ou retourne l'ID du jeu existant.
 */
export async function addOrGetJeu(jeuNom) {
  const norm = normalizeGameName(jeuNom);
  const existingGameId = await redis.hget('games:map', norm);
  if (existingGameId) {
    return existingGameId;
  } else {
    const gameId = await redis.incr('games:id'); // Génère un nouvel id
    await redis.hset(`game:${gameId}`, { nom: jeuNom });
    await redis.hset('games:map', norm, gameId);
    await redis.zadd('games:votes', { score: 0, member: String(gameId) });
    return gameId;
  }
}

/**
 * Recherche l'ID d'un jeu par son nom (comparaison floue).
 */
export async function getJeuIdByName(jeuNom) {
  const norm = normalizeGameName(jeuNom);
  const gamesMap = (await redis.hgetall('games:map')) || {};
  for (const key in gamesMap) {
    if (key.startsWith(norm) || norm.startsWith(key)) {
      return gamesMap[key];
    }
  }
  return null;
}

/**
 * Récupère un utilisateur par son identifiant.
 */
export async function getUserById(id) {
  const user = await redis.hgetall(`user:${id}`);
  return user && Object.keys(user).length > 0 ? user : null;
}

/**
 * Ajoute ou met à jour un utilisateur.
 */
export async function addOrUpdateUser(user) {
  await redis.hset(`user:${user.id}`, { username: user.username, avatar: user.avatar });
  return user;
}

/**
 * Ajoute un vote pour un utilisateur pour un jeu donné.
 */
export async function insertVote(userId, jeuId) {
  const added = await redis.sadd(`user:${userId}:games`, jeuId);
  if (added) {
    await redis.zincrby('games:votes', 1, jeuId);
  }
}

/**
 * Supprime le vote d'un utilisateur pour un jeu donné.
 */
export async function deleteVoteForUser(userId, jeuId) {
  const removed = await redis.srem(`user:${userId}:games`, jeuId);
  if (removed) {
    await redis.zincrby('games:votes', -1, jeuId);
  }
}

/**
 * Récupère la liste des jeux votés par un utilisateur.
 */
export async function getUserGames(userId) {
  const gameIds = await redis.smembers(`user:${userId}:games`);
  const games = [];
  for (let id of gameIds) {
    const game = await redis.hgetall(`game:${id}`);
    if (game && game.nom) {
      games.push(game.nom);
    }
  }
  return games;
}

/**
 * Récupère tous les jeux enregistrés.
 */
export async function getAllJeux() {
  const map = (await redis.hgetall('games:map')) || {};
  const jeux = [];
  for (let norm in map) {
    const gameId = map[norm];
    const game = await redis.hgetall(`game:${gameId}`);
    if (game && game.nom) {
      jeux.push(game.nom);
    }
  }
  return jeux;
}

/**
 * Récupère les statistiques globales (nom du jeu et nombre de votes).
 */
export async function getGlobalStatistics() {
  // Récupère tous les jeux avec leurs scores
  const gameVotes = await redis.zrange('games:votes', 0, -1, { withScores: true });

  const stats = [];
  for (let i = 0; i < gameVotes.length; i += 2) {
    const gameId = gameVotes[i];
    const votes = parseInt(gameVotes[i + 1], 10);

    // Récupère le nom du jeu correspondant à l'ID
    const gameData = await redis.hgetall(`game:${gameId}`);
    if (gameData.nom) {
      stats.push({ nom: gameData.nom, votes });
    }
  }

  return stats;
}

/**
 * Supprime tous les votes d'un utilisateur.
 */
export async function deleteAllVotesForUser(userId) {
  const gameIds = await redis.smembers(`user:${userId}:games`);
  for (let id of gameIds) {
    await redis.srem(`user:${userId}:games`, id);
    await redis.zincrby('games:votes', -1, id);
  }
}

// Alias pour compatibilité
export const getStatistiques = getGlobalStatistics;
