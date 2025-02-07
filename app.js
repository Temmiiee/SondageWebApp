require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const redis = require('redis');
const RedisStore = require('connect-redis').default;
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurer Express pour faire confiance au proxy
app.set('trust proxy', 1);

// Chargement des variables sensibles
const {
  CLIENT_ID,
  CLIENT_SECRET,
  CALLBACK_URL,
  SESSION_SECRET,
  REDIS_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN
} = process.env;

if (!SESSION_SECRET) {
  console.error("SESSION_SECRET n'est pas défini dans l'environnement.");
  process.exit(1);
}

// Construction de l'URL Redis à utiliser.
// Priorité aux variables Upstash si elles sont définies.
let redisUrl = REDIS_URL;
if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
  // Remplace "https://" par "rediss://default:<token>@" pour la connexion sécurisée.
  redisUrl = UPSTASH_REDIS_REST_URL.replace(
    /^https:\/\//,
    `rediss://default:${UPSTASH_REDIS_REST_TOKEN}@`
  );
}

// Choix du store de session : si une URL Redis est définie, on utilise RedisStore, sinon SQLiteStore
let sessionStore;
if (redisUrl) {
  // Création du client Redis avec l'URL construite
  const redisClient = redis.createClient({
    url: redisUrl,
    socket: {
      tls: true,
      rejectUnauthorized: false,
    },
  });
  redisClient.connect().catch(console.error);
  redisClient.on('error', (err) => console.error('Erreur Redis:', err));
  sessionStore = new RedisStore({ client: redisClient });
} else {
  // S'assurer que le dossier 'data' existe pour SQLiteStore
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }
  sessionStore = new SQLiteStore({
    db: 'sessions.sqlite',
    dir: dataDir,
  });
}

// Configuration de Helmet pour sécuriser les en-têtes HTTP
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "https://cdn.discordapp.com"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      objectSrc: ["'none'"]
    },
  })
);

// Limitation des requêtes pour prévenir certains abus
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});
app.use(limiter);

// Middleware pour parser le corps des requêtes
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Configuration des sessions
app.use(
  session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // Cookie sécurisé en production (HTTPS)
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24, // 1 jour
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// Configuration de la stratégie Discord
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

// Middleware pour protéger les routes
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login.html');
}

// Middleware pour protéger l'accès direct à /index.html
app.use((req, res, next) => {
  if (req.path === '/index.html' && !(req.isAuthenticated && req.isAuthenticated())) {
    return res.redirect('/login.html');
  }
  next();
});

// Servir les fichiers statiques (désactivation de l'index automatique)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Routes d'authentification via Discord
app.get('/auth/discord', passport.authenticate('discord'));

app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/login.html' }),
  (req, res) => {
    // Définir un cookie pour l'ID utilisateur (optionnel, car la session contient déjà cette info)
    res.cookie('user_id', req.user.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    });
    res.redirect('/');
  }
);

// Route principale (accès restreint)
app.get('/', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Déconnexion
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      console.error(err);
      return next(err);
    }
    req.session.destroy((err) => {
      if (err) {
        console.error(err);
      }
      res.redirect('/login.html');
    });
  });
});

// --- API ---

// Récupérer les jeux de l'utilisateur
app.get('/api/jeux', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getUserGames(req.user.id);
    res.json(jeux);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération des jeux.' });
  }
});

// Récupérer tous les jeux
app.get('/api/jeux/all', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getAllJeux();
    res.json(jeux);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération des jeux.' });
  }
});

// Enregistrer les votes (liste de jeux)
app.post('/api/vote', ensureAuthenticated, async (req, res) => {
  const { jeux } = req.body;
  if (!jeux || !Array.isArray(jeux)) {
    return res.status(400).json({ error: 'Une liste de jeux est requise.' });
  }
  try {
    // Suppression des votes précédents de l'utilisateur
    await db.deleteVotesForUser(req.user.id);
    for (let jeu of jeux) {
      const jeuNormalise = jeu.trim().toLowerCase();
      if (jeuNormalise) {
        const jeuId = await db.addOrGetJeu(jeuNormalise);
        await db.insertVote(req.user.id, jeuId);
      }
    }
    res.json({ message: 'Vos jeux ont été mis à jour avec succès.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour des votes.' });
  }
});

// Ajouter un jeu à la liste de l'utilisateur
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

// Supprimer un jeu de la liste de l'utilisateur
app.post('/api/supprimer-jeu', ensureAuthenticated, async (req, res) => {
  const { jeu } = req.body;
  if (!jeu) {
    return res.status(400).json({ error: 'Le nom du jeu est requis.' });
  }
  try {
    const jeuId = await db.getJeuIdByName(jeu);
    if (!jeuId) {
      return res.status(404).json({ error: 'Jeu non trouvé.' });
    }
    await db.deleteVoteForUser(req.user.id, jeuId);
    res.json({ message: 'Jeu supprimé avec succès de vos jeux.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la suppression du jeu.' });
  }
});

// Supprimer un vote via l'ID du jeu
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

// Récupérer les jeux de l'utilisateur (autre endpoint)
app.get('/api/mes-jeux', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getUserGames(req.user.id);
    res.json(jeux);
  } catch (error) {
    res.status(500).json({ error: 'Erreur de récupération des jeux' });
  }
});

// Récupérer les statistiques globales (jeux avec votes)
app.get('/api/statistiques', async (req, res) => {
  try {
    const stats = await db.getGlobalStatistics();
    res.json(stats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur statistiques' });
  }
});

// Récupérer les informations de l'utilisateur connecté
app.get('/api/user', ensureAuthenticated, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    const avatarURL = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    res.json({ ...user, avatarURL });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération des informations utilisateur.' });
  }
});

// Gestion des routes non définies (404)
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée' });
});

// Middleware pour forcer la CSP sur toutes les réponses, y compris pour les fichiers statiques
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

// Gestion centralisée des erreurs non capturées
app.use((err, req, res, next) => {
  console.error('Erreur interne :', err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
