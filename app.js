require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const RedisStore = require('connect-redis').default;
const redis = require('redis');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Charger les variables sensibles
const { CLIENT_ID, CLIENT_SECRET, CALLBACK_URL, SESSION_SECRET, REDIS_URL } = process.env;

// Choix du store de session : si REDIS_URL est défini, on utilise RedisStore, sinon SQLiteStore
let sessionStore;
if (REDIS_URL) {
  // Création du client Redis
  const redisClient = redis.createClient({
    url: REDIS_URL, // Exemple : redis://localhost:6379
  });
  redisClient.on('error', (err) => console.error('Erreur Redis:', err));
  sessionStore = new RedisStore({ client: redisClient });
} else {
  sessionStore = new SQLiteStore({
    db: 'sessions.sqlite',
    dir: './data', // dossier où sera stockée la base de données de sessions
  });
}

// Configuration de Helmet
app.use(helmet());
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https://cdn.discordapp.com"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  })
);

// Limitation des requêtes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
});
app.use(limiter);

// Middlewares pour parser le corps des requêtes
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Configuration des sessions avec le store choisi (RedisStore ou SQLiteStore)
app.use(
  session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // nécessite HTTPS en prod
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

passport.serializeUser((user, done) => done(null, user.id));

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

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Routes d'authentification via Discord
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
// API pour récupérer les jeux de l'utilisateur
app.get('/api/jeux', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getUserGames(req.user.id);
    res.json(jeux);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération des jeux.' });
  }
});

// API pour récupérer tous les jeux
app.get('/api/jeux/all', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getAllJeux();
    res.json(jeux);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la récupération des jeux.' });
  }
});

// API pour enregistrer les votes (liste de jeux)
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

// API pour ajouter un jeu à la liste de l'utilisateur
app.post('/api/ajouter-jeu', ensureAuthenticated, async (req, res) => {
  const { jeu } = req.body;
  if (!jeu) {
    return res.status(400).json({ error: 'Le nom du jeu est requis.' });
  }
  try {
    const jeuId = await db.addOrGetJeu(jeu);
    await db.insertVote(req.user.id, jeuId);
    res.status(200).json({ message: 'Jeu ajouté avec succès à vos jeux.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de l\'ajout du jeu.' });
  }
});

// API pour supprimer un jeu de la liste de l'utilisateur
app.post('/api/supprimer-jeu', ensureAuthenticated, async (req, res) => {
  const { jeu } = req.body;
  if (!jeu) {
    return res.status(400).json({ error: 'Le nom du jeu est requis.' });
  }
  try {
    const jeuId = await db.getJeuIdByName(jeu);
    await db.deleteVoteForUser(req.user.id, jeuId);
    res.status(200).json({ message: 'Jeu supprimé avec succès de vos jeux.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de la suppression du jeu.' });
  }
});

// API pour supprimer un vote via l'ID du jeu
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

// API pour récupérer les jeux de l'utilisateur (autre endpoint)
app.get('/api/mes-jeux', ensureAuthenticated, async (req, res) => {
  try {
    const jeux = await db.getUserGames(req.user.id);
    res.json(jeux);
  } catch (error) {
    res.status(500).json({ error: 'Erreur de récupération des jeux' });
  }
});

// API pour récupérer les statistiques globales (jeux avec votes)
app.get('/api/statistiques', async (req, res) => {
  try {
    const stats = await db.getGlobalStatistics();
    res.json(stats);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur statistiques' });
  }
});

// API pour récupérer les informations de l'utilisateur connecté
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

// --- Gestion centralisée des erreurs non capturées ---
app.use((err, req, res, next) => {
  console.error('Erreur interne :', err);
  res.status(500).json({ error: 'Erreur interne du serveur.' });
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
