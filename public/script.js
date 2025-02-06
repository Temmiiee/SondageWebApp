class GameManager {
  constructor() {
    this.initElements();
    this.initChart();
    this.loadData();
    this.setupEventListeners();
  }

  initElements() {
    this.elements = {
      mesJeux: document.getElementById('mes-jeux'),
      jeuForm: document.getElementById('jeuForm'),
      ajouterBtn: document.getElementById('ajouterBtn'),
      jeuInput: document.getElementById('jeuInput'),
      jeuxList: document.getElementById('jeuxList'),
      statsChart: document.getElementById('statsChart'),
      logoutBtn: document.getElementById('logoutBtn'),
      listeJeux: document.getElementById('liste-jeux')
    };
  }

  initChart() {
    this.chart = new Chart(this.elements.statsChart.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: [],
        datasets: [{
          label: 'Joueurs',
          data: [],
          backgroundColor: [
            '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF'
          ]
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom' }
        }
      }
    });
  }

  async loadData() {
    await this.loadUserGames();
    await this.loadAllGames();
    await this.loadStatistics();
  }

  async loadUserGames() {
    try {
      const response = await fetch('/api/jeux');
      const games = await response.json();
      this.renderUserGames(games);
    } catch (error) {
      console.error('Erreur chargement jeux utilisateur:', error);
    }
  }

  async loadAllGames() {
    try {
      const response = await fetch('/api/jeux/all');
      const games = await response.json();
      this.populateDatalist(games);
    } catch (error) {
      console.error('Erreur chargement tous les jeux:', error);
    }
  }

  async loadStatistics() {
    try {
      const response = await fetch('/api/statistiques');
      const stats = await response.json();
      this.updateChartData(stats);
      this.updateGameList(stats);
    } catch (error) {
      console.error('Erreur chargement statistiques:', error);
    }
  }

  renderUserGames(games) {
    this.elements.mesJeux.innerHTML = games.map(game => `
      <li class="list-group-item d-flex justify-content-between align-items-center">
        ${game}
        <button class="btn btn-danger btn-sm" data-game="${game}">Supprimer</button>
      </li>
    `).join('');
  }

  populateDatalist(games) {
    this.elements.jeuxList.innerHTML = games
      .map(game => `<option value="${game}">${game}</option>`)
      .join('');
  }

  updateChartData(stats) {
    this.chart.data.labels = stats.map(s => s.nom);
    this.chart.data.datasets[0].data = stats.map(s => s.votes);
    this.chart.update();
  }

  updateGameList(stats) {
    this.elements.listeJeux.innerHTML = '';

    stats.forEach(stat => {
      const li = document.createElement('li');
      li.classList.add('list-group-item');
      li.style.cursor = 'pointer';
      li.textContent = `${stat.nom} (${stat.votes} joueur${stat.votes > 1 ? 's' : ''})`;
      li.addEventListener('click', () => {
        this.handleGameSubmissionFromList(stat.nom);
      });
      this.elements.listeJeux.appendChild(li);
    });
  }

  setupEventListeners() {
    // Gestion du formulaire d'ajout manuel
    this.elements.ajouterBtn.addEventListener('click', () => {
      this.elements.jeuForm.style.display = 'block';
    });

    this.elements.jeuForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleGameSubmission();
    });

    // Gestion de la suppression d'un jeu de la liste de l'utilisateur
    this.elements.mesJeux.addEventListener('click', async (e) => {
      if (e.target.classList.contains('btn-danger')) {
        await this.handleGameDeletion(e.target.dataset.game);
      }
    });

    // Déconnexion
    this.elements.logoutBtn.addEventListener('click', () => {
      window.location.href = '/logout';
    });
  }

  async handleGameSubmission() {
    const gameName = this.elements.jeuInput.value.trim();
    
    if (!gameName) {
      alert('Veuillez entrer un nom de jeu valide');
      return;
    }

    try {
      await fetch('/api/ajouter-jeu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jeu: gameName })
      });

      this.elements.jeuInput.value = '';
      this.elements.jeuForm.style.display = 'none';
      await this.loadData();
    } catch (error) {
      console.error("Erreur lors de l'ajout:", error);
    }
  }

  // Gérer l'ajout via la liste cliquable
  async handleGameSubmissionFromList(gameName) {
    try {
      await fetch('/api/ajouter-jeu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jeu: gameName })
      });
      await this.loadData();
    } catch (error) {
      console.error("Erreur lors de l'ajout depuis la liste:", error);
    }
  }

  async handleGameDeletion(gameName) {
    try {
      await fetch('/api/supprimer-jeu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jeu: gameName })
      });

      await this.loadData();
    } catch (error) {
      console.error('Erreur suppression:', error);
    }
  }
}

// Initialisation de l'application
document.addEventListener('DOMContentLoaded', () => new GameManager());