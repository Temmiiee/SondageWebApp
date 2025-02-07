// app.js (ESM)
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
import { createClient } from 'redis';
import { RedisStore } from 'connect-redis';
import { Strategy as DiscordStrategy } from 'passport-discord';
import * as db from './db.js';
import { fileURLToPath } from 'url';

// Pour ESM, définir __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// Variables d'environnement
const {
  CLIENT_ID,
  CLIENT_SECRET,
  CALLBACK_URL,
  SESSION_SECRET,
  REDIS_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

if (!SESSION_SECRET) {
  console.error("SESSION_SECRET n'est pas défini dans l'environnement.");
  process.exit(1);
}

// Construction du client Redis (Upstash ou autre)
let redisClient;
if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  const upstashUrl = UPSTASH_REDIS_REST_URL.replace(
    /^https:\/\//,
    `rediss://default:${UPSTASH_REDIS_REST_TOKEN}@`
  );
  redisClient = createClient({
    url: upstashUrl,
    socket: { tls: true, rejectUnauthorized: false },
  });
} else if (REDIS_URL) {
  redisClient = createClient({
    url: REDIS_URL,
    socket: { tls: true, rejectUnauthorized: false },
  });
}

// Définition du store des sessions
let sessionStore;
if (redisClient) {
  redisClient.connect().catch(console.error);
  redisClient.on('error', (err) => console.error('Erreur Redis:', err));
  sessionStore = new RedisStore({ client: redisClient });
} else {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  sessionStore = new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir });
}

// Helmet et Content Security Policy
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://cdn.jsdelivr.net",
        "'unsafe-inline'",
        "'unsafe-eval'"
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "https://cdn.discordapp.com"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  })
);

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
      "img-src 'self' https://cdn.discordapp.com; " +
      "connect-src 'self'; " +
      "font-src 'self' https://cdn.jsdelivr.net; " +
      "object-src 'none'"
  );
  next();
});

// Limitation des requêtes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

// Parsing JSON et urlencoded
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Sessions
app.use(
  session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Stratégie Discord
passport.use(
  new DiscordStrategy(
    {
      clientID: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      callbackURL: CALLBACK_URL,
      scope: ['identify'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const userData = {
          id: profile.id,
          username: profile.username,
          avatar: profile.avatar,
        };
        const user = await db.addOrUpdateUser(userData);
        return done(null, user);
      } catch (err) {
        console.error("Erreur dans la stratégie Discord :", err);
        return done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.getUserById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
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
  if (!jeu) {
    return res.status(400).json({ error: 'Le nom du jeu est requis.' });
  }
  try {
    const jeuId = await db.getJeuId(jeu);
    if (!jeuId) {
      return res.status(404).json({ error: 'Jeu non trouvé.' });
    }
    await db.deleteVoteForUser(req.user.id, jeuId);
    res.json({ message: 'Jeu supprimé avec succès.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la suppression du jeu.' });
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
