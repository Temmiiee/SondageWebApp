require('dotenv').config(); // Charger les variables d'environnement
const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Charger les variables sensibles depuis l'environnement
const { CLIENT_ID, CLIENT_SECRET, CALLBACK_URL, SESSION_SECRET } = process.env;

// --- Configuration de Helmet ---
// Helmet ajoute plusieurs en-têtes de sécurité par défaut
app.use(helmet());

// Configuration d'une Content Security Policy (CSP) personnalisée
// Adaptez les valeurs en fonction de vos besoins (ici on autorise self et le domaine Discord pour les images)
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // 'unsafe-inline' peut être nécessaire pour certains styles, mais à limiter si possible
      imgSrc: ["'self'", "https://cdn.discordapp.com"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  })
);

// --- Limitation du nombre de requêtes ---
// Pour éviter les abus, nous limitons le nombre de requêtes par IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limite à 100 requêtes par fenêtre
});
app.use(limiter);

// --- Configuration des middlewares ---
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // Cookies sécurisés en production (HTTPS obligatoire)
      httpOnly: true, // Empêche l'accès côté client via JavaScript
      maxAge: 1000 * 60 * 60 * 24, // 1 jour
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// --- Configuration de la stratégie Discord ---
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

// --- Middleware pour protéger les routes ---
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login.html');
}

// --- Servir les fichiers statiques ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Routes d'authentification via Discord ---
app.get('/auth/discord', passport.authenticate('discord'));

app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/login.html' }),
  (req, res) => {
    // Optionnel : stocker l'ID utilisateur dans un cookie
    res.cookie('user_id', req.user.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    });
    res.redirect('/');
  }
);

// Route principale (page index)
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