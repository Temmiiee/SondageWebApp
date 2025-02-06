require('dotenv').config(); // Charger les variables d'environnement
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Charger les variables sensibles
const { CLIENT_ID, CLIENT_SECRET, CALLBACK_URL, SESSION_SECRET } = process.env;

// Configuration du middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Utiliser cookies sécurisés en prod
    httpOnly: true, // Empêche l'accès côté client
    maxAge: 1000 * 60 * 60 * 24, // Durée du cookie (1 jour)
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Configuration de la stratégie Discord
passport.use(new DiscordStrategy({
    clientID: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
    scope: ['identify']
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const userData = {
        id: profile.id,
        username: profile.username,
        avatar: profile.avatar
      };
      const user = await db.addOrUpdateUser(userData);
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.getUserById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

app.get('/', ensureAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware pour protéger les routes
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login.html');
}

// Servir les fichiers statiques depuis le dossier public
app.use(express.static(path.join(__dirname, 'public')));

// Routes d'authentification via Discord
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/login.html' }),
  (req, res) => {
    res.cookie('user_id', req.user.id);  // Optionnel: pour stocker l'ID de l'utilisateur dans un cookie
    res.redirect('/'); // Rediriger vers la page principale
  }
);

// Déconnexion
app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Erreur de déconnexion');
    }
    req.session.destroy((err) => {
      if (err) {
        console.error(err);
      }
      res.redirect('/login.html');
    });
  });
});

// API pour la page de vote
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
    res.status(500).json({ error: 'Erreur lors de la récupération des jeux.' });
  }
});

app.post('/api/vote', ensureAuthenticated, async (req, res) => {
  const { jeux } = req.body;
  if (!jeux || !Array.isArray(jeux)) {
    return res.status(400).json({ error: 'Une liste de jeux est requise.' });
  }
  try {
    await db.deleteVotesForUser(req.user.id);
    for (let jeu of jeux) {
      const jeuNormalise = jeu.trim().toLowerCase(); // Normalisation du jeu
      if (jeuNormalise) {
        const jeuId = await db.addOrGetJeu(jeuNormalise); // Ajout du jeu dans la base
        await db.insertVote(req.user.id, jeuId); // Enregistrement du vote
      }
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
    // Ajouter le jeu à la table des jeux si ce n'est pas déjà présent
    const jeuId = await db.addOrGetJeu(jeu);
    
    // Ajouter l'association avec l'utilisateur dans la table des votes
    await db.insertVote(req.user.id, jeuId);
    
    res.status(200).json({ message: 'Jeu ajouté avec succès à vos jeux.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erreur lors de l\'ajout du jeu.' });
  }
});

app.post('/api/supprimer-jeu', ensureAuthenticated, async (req, res) => {
  const { jeu } = req.body;
  if (!jeu) {
    return res.status(400).json({ error: 'Le nom du jeu est requis.' });
  }

  try {
    // Récupérer l'ID du jeu
    const jeuId = await db.getJeuIdByName(jeu);
    
    // Supprimer l'association avec l'utilisateur
    await db.deleteVoteForUser(req.user.id, jeuId);
    
    res.status(200).json({ message: 'Jeu supprimé avec succès de vos jeux.' });
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
    res.status(500).json({ error: 'Erreur de récupération des jeux' });
  }
});

// Modifier la route de statistiques
app.get('/api/statistiques', async (req, res) => {
  try {
    const stats = await db.getGlobalStatistics();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Erreur statistiques' });
  }
});

app.get('/api/user', ensureAuthenticated, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    const avatarURL = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
    res.json({ ...user, avatarURL });
  } catch (error) {
    res.status(500).json({ error: 'Erreur lors de la récupération des informations utilisateur.' });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
