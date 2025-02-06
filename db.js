// db.js
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbFile = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbFile);

// Création des tables
db.serialize(() => {
  // Table des utilisateurs
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      avatar TEXT
    )
  `);

  // Table des jeux
  db.run(`
    CREATE TABLE IF NOT EXISTS jeux (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT UNIQUE
    )
  `);

  // Table des votes (association entre user et jeu)
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      jeu_id INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (jeu_id) REFERENCES jeux(id),
      UNIQUE(user_id, jeu_id)
    )
  `);
});

module.exports = {
  // Gestion des utilisateurs
  getUserByDiscordId: (id) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  addOrUpdateUser: (user) => {
    return new Promise((resolve, reject) => {
      // On essaie d'insérer l'utilisateur ou de le mettre à jour
      db.run(
        `INSERT INTO users(id, username, avatar) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, avatar = excluded.avatar`,
        [user.id, user.username, user.avatar],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(user);
          }
        }
      );
    });
  },

  getUserById: (id) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  },

  getGlobalStatistics: () => {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT j.nom, COUNT(v.user_id) as votes
        FROM jeux j
        LEFT JOIN votes v ON j.id = v.jeu_id
        GROUP BY j.nom
        HAVING COUNT(v.user_id) > 0
        ORDER BY votes DESC
      `;
      db.all(query, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },  

  getUserGames: (userId) => {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT j.nom 
        FROM votes v
        JOIN jeux j ON v.jeu_id = j.id
        WHERE v.user_id = ?
      `;
      db.all(query, [userId], (err, rows) => {
        if (err) reject(err);
        resolve(rows.map(r => r.nom));
      });
    });
  },

  getAllJeux: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT nom FROM jeux', (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(row => row.nom));
        }
      });
    });
  },

  addOrGetJeu: (jeuNom) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT id FROM jeux WHERE nom = ?', [jeuNom], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          resolve(row.id); // Si le jeu existe déjà, on retourne son ID
        } else {
          // Si le jeu n'existe pas, on l'ajoute
          db.run('INSERT INTO jeux(nom) VALUES(?)', [jeuNom], function (err) {
            if (err) {
              reject(err);
            } else {
              resolve(this.lastID); // Retourner l'ID du jeu nouvellement ajouté
            }
          });
        }
      });
    });
  },

  getJeuIdByName: (jeuNom) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT id FROM jeux WHERE nom = ?', [jeuNom], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.id : null); // Retourner l'ID si le jeu existe
        }
      });
    });
  },  

  // Gestion des votes
  deleteVoteForUser: (userId, jeuId) => {
    return new Promise((resolve, reject) => {
      db.run('DELETE FROM votes WHERE user_id = ? AND jeu_id = ?', [userId, jeuId], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  },  

  insertVote: (user_id, jeuId) => {
    return new Promise((resolve, reject) => {
      db.run('INSERT OR IGNORE INTO votes(user_id, jeu_id) VALUES(?, ?)', [user_id, jeuId], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  },

  // Statistiques
  getStatistiques: () => {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT jeux.nom, COUNT(votes.jeu_id) as votes
        FROM jeux
        LEFT JOIN votes ON jeux.id = votes.jeu_id
        GROUP BY jeux.nom
        ORDER BY votes DESC
      `;
      db.all(query, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }  
};
