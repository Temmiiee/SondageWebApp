import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

// Configuration Redis
const redis = new Redis(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? `rediss://default:${process.env.UPSTASH_REDIS_REST_TOKEN}@${process.env.UPSTASH_REDIS_REST_URL.replace('https://', '')}:6379`
    : process.env.REDIS_URL,
  {
    tls: { rejectUnauthorized: false },
    retryStrategy: (times) => Math.min(times * 500, 5000)
  }
);

// Helpers
const handleRedis = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    console.error('Erreur Redis:', error);
    throw error;
  }
};

const normalizeGameName = (name) => 
  name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

// Fonctions DB
export async function addOrGetJeu(jeuNom) {
  return handleRedis(async () => {
    const norm = normalizeGameName(jeuNom);
    const existingId = await redis.hget('games:map', norm);
    if (existingId) return existingId;

    const gameId = await redis.incr('games:id');
    await redis.multi()
      .hset(`game:${gameId}`, 'nom', jeuNom)
      .hset('games:map', norm, gameId)
      .zadd('games:votes', 0, gameId)
      .exec();
    return gameId;
  });
}

export async function getJeuId(nomJeu) {
  return handleRedis(() => 
    redis.hget('games:map', normalizeGameName(nomJeu))
  );
}

export async function getUserById(id) {
  return handleRedis(async () => {
    const user = await redis.hgetall(`user:${id}`);
    return Object.keys(user).length ? user : null;
  });
}

export async function addOrUpdateUser({ id, username, avatar }) {
  return handleRedis(async () => {
    await redis.hset(`user:${id}`, { 
      username: username, 
      avatar: avatar || 'default_avatar'
    });
    
    // Retourne un objet utilisateur brut (sans méthodes)
    return { 
      id: String(id),
      username, 
      avatar 
    };
  });
}

export async function insertVote(userId, jeuId) {
  return handleRedis(() => 
    redis.multi()
      .sadd(`user:${userId}:games`, jeuId)
      .zincrby('games:votes', 1, jeuId)
      .exec()
  );
}

export async function deleteVoteForUser(userId, jeuId) {
  return handleRedis(() => 
    redis.multi()
      .srem(`user:${userId}:games`, jeuId)
      .zincrby('games:votes', -1, jeuId)
      .exec()
  );
}

export async function hasUserVoted(userId, jeuId) {
  return handleRedis(() => 
    redis.sismember(`user:${userId}:games`, jeuId)
  );
}

export async function getUserGames(userId) {
  return handleRedis(async () => {
    const gameIds = await redis.smembers(`user:${userId}:games`);
    const pipeline = redis.pipeline();
    gameIds.forEach(id => pipeline.hget(`game:${id}`, 'nom'));
    return (await pipeline.exec()).map(([, nom]) => nom).filter(Boolean);
  });
}

export async function getAllJeux() {
  return handleRedis(async () => {
    const gamesMap = await redis.hgetall('games:map');
    const pipeline = redis.pipeline();
    Object.values(gamesMap).forEach(id => pipeline.hget(`game:${id}`, 'nom'));
    return (await pipeline.exec()).map(([, nom]) => nom).filter(Boolean);
  });
}

export async function getGlobalStatistics() {
  return handleRedis(async () => {
    const votes = await redis.zrange('games:votes', 0, -1, 'WITHSCORES');
    const stats = [];
    
    for (let i = 0; i < votes.length; i += 2) {
      const gameId = votes[i];
      const score = parseInt(votes[i + 1], 10);
      const nom = await redis.hget(`game:${gameId}`, 'nom');
      if (nom) stats.push({ nom, votes: score });
    }
    
    return stats;
  });
}

export const getStatistiques = getGlobalStatistics;