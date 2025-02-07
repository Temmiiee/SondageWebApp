import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import SQLiteStoreFactory from 'connect-sqlite3';
const SQLiteStore = SQLiteStoreFactory(session);
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import passport from 'passport';
import Redis from 'ioredis';
import connectRedis from 'connect-redis';
import { Strategy as DiscordStrategy } from 'passport-discord';
import * as db from './db.js';
import { fileURLToPath } from 'url';

// Configuration ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Configuration Redis
const redisClient = new Redis(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ? `rediss://default:${process.env.UPSTASH_REDIS_REST_TOKEN}@${process.env.UPSTASH_REDIS_REST_URL.replace('https://', '')}:6379`
    : process.env.REDIS_URL,
  {
    tls: { rejectUnauthorized: false },
    retryStrategy: (times) => Math.min(times * 500, 5000)
  }
);

// Configuration des sessions
const RedisStore = connectRedis(session);
let sessionStore;

if (redisClient.status === 'ready') {
  sessionStore = new RedisStore({
    client: redisClient,
    prefix: 'sess:',
    disableTouch: true
  });
} else {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  sessionStore = new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir });
}

// Middlewares de sécurité
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "https://cdn.discordapp.com", "data:", "https://*.upstash.io"],
      connectSrc: ["'self'", "https://*.upstash.io", "https://discord.com"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      frameSrc: ["'self'", "https://discord.com"],
      objectSrc: ["'none'"]
    }
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  unset: 'destroy',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 86400000
  }
}));

// Configuration Passport
app.use(passport.initialize());
app.use(passport.session());
passport.use(new DiscordStrategy({
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL,
  scope: ['identify'],
  passReqToCallback: true
}, async (req, accessToken, refreshToken, profile, done) => {
  try {
    console.log('Profile complet:', profile);
    
    const user = await db.addOrUpdateUser({
      id: profile.id,
      username: profile.username,
      avatar: profile.avatar || profile.id
    });

    console.log('Utilisateur créé:', user);
    done(null, user);
  } catch (error) {
    console.error('Erreur auth Discord:', error);
    done(error);
  }
}));

// Sérialisation
passport.serializeUser((user, done) => {
  if (!user?.id) {
    return done(new Error('User ID manquant'));
  }
  done(null, user.id); // Stocke uniquement l'ID
});

// Désérialisation
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.getUserById(id);
    if (!user) return done(new Error('Utilisateur non trouvé'));
    done(null, {
      id: String(id), // Conversion explicite
      username: user.username,
      avatar: user.avatar
    });
  } catch (error) {
    done(error);
  }
});

app.use((req, res, next) => {
  console.log('Session actuelle:', req.session);
  console.log('Utilisateur auth:', req.user);
  next();
});

// Middleware d'authentification
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.redirect('/login.html');
}

// Protection de l'accès direct à /index.html
app.use((req, res, next) => {
  if (req.path === '/index.html' && !(req.isAuthenticated && req.isAuthenticated())) {
    return res.redirect('/login.html');
  }
  next();
});

// Fichiers statiques (sans auto-index)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Routes d'authentification Discord
app.get('/auth/discord', passport.authenticate('discord'));
app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/login.html' }),
  (req, res) => {
    res.cookie('user_id', req.user.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    });
    res.redirect('/');
  }
);

// Route principale protégée
app.get('/', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Déconnexion
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy((err) => {
      if (err) console.error(err);
      res.redirect('/login.html');
    });
  });
});

/** --- Routes API --- **/

app.get('/api/jeux', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getUserGames(req.user.id);
    res.json(jeux);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération des jeux.' });
  }
});

app.get('/api/jeux/all', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getAllJeux();
    res.json(jeux);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération de tous les jeux.' });
  }
});

app.post('/api/vote', ensureAuthenticated, async (req, res) => {
  const { jeux } = req.body;
  if (!jeux || !Array.isArray(jeux)) {
    return res.status(400).json({ error: 'Une liste de jeux est requise.' });
  }
  try {
    await db.deleteAllVotesForUser(req.user.id);
    for (let jeu of jeux) {
      const jeuId = await db.addOrGetJeu(jeu);
      await db.insertVote(req.user.id, jeuId);
    }
    res.json({ message: 'Vos jeux ont été mis à jour avec succès.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour des votes.' });
  }
});

app.post('/api/ajouter-jeu', ensureAuthenticated, async (req, res) => {
  const { jeu } = req.body;
  if (!jeu) {
    return res.status(400).json({ error: 'Le nom du jeu est requis.' });
  }
  try {
    const jeuId = await db.addOrGetJeu(jeu);
    await db.insertVote(req.user.id, jeuId);
    res.json({ message: 'Jeu ajouté avec succès à vos jeux.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lors de l'ajout du jeu." });
  }
});

app.post('/api/supprimer-jeu', ensureAuthenticated, async (req, res) => {
  const { jeu } = req.body;
  try {
    const jeuId = await db.getJeuId(jeu);
    
    if (!jeuId) {
      return res.status(404).json({ error: 'Jeu non trouvé' });
    }

    await db.deleteVoteForUser(req.user.id, jeuId);
    res.json({ message: 'Jeu supprimé avec succès.' });
    
  } catch (error) {
    console.error('Erreur suppression:', error);
    res.status(500).json({ error: 'Erreur technique lors de la suppression' });
  }
});

app.delete('/api/vote/:jeuId', ensureAuthenticated, async (req, res) => {
  const jeuId = req.params.jeuId;
  try {
    await db.deleteVoteForUser(req.user.id, jeuId);
    res.json({ message: 'Jeu supprimé avec succès.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la suppression du jeu.' });
  }
});

app.get('/api/mes-jeux', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getUserGames(req.user.id);
    res.json(jeux);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur de récupération des jeux.' });
  }
});

// Route pour récupérer les statistiques globales des jeux
app.get('/api/statistiques', async (req, res) => {
  try {
    const stats = await db.getGlobalStatistics();
    res.json(stats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur statistiques.' });
  }
});

app.get('/api/user', ensureAuthenticated, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    const avatarURL = `https://cdn.discordapp.com/avatars/${req.user.id}/${user.avatar}.png`;
    res.json({ ...user, avatarURL });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération des informations utilisateur.' });
  }
});

// Gestion centralisée des erreurs non capturées
app.use((err, req, res, next) => {
  console.error('Erreur interne :', err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
