// =====================================================================
// DONNÉES D'EXEMPLE POUR LE PROGRAMME D'ENTRAÎNEMENT
// =====================================================================

window.trainingProgram = {
    sessions: {
        "2025-12-01": {
            session_type: "Endurance fondamentale",
            duration_minutes: 90,
            description: "Ride facile à 65-75% de FC max",
            target_zone: "Z2"
        },
        "2025-12-02": {
            session_type: "VMA",
            duration_minutes: 60,
            description: "Séries de 3 min à 95% FC max",
            target_zone: "Z4-Z5"
        },
        "2025-12-03": {
            session_type: "Repos",
            duration_minutes: 0,
            description: "Jour de récupération",
            target_zone: "Repos"
        },
        "2025-12-04": {
            session_type: "Tempo",
            duration_minutes: 120,
            description: "Rapide soutenu à 80-85% FC max",
            target_zone: "Z3"
        },
        "2025-12-05": {
            session_type: "Force",
            duration_minutes: 75,
            description: "Côtes en danseuse 3x8 min",
            target_zone: "Z4"
        },
        "2025-12-06": {
            session_type: "Endurance recovery",
            duration_minutes: 60,
            description: "Ride très facile",
            target_zone: "Z1-Z2"
        }
    }
};

window.userProgress = {
    "2025-12-01": {
        completed: true,
        completedAt: "2025-12-01T19:30:00Z",
        zoneTimes: [45, 30, 10, 5, 0], // Temps passé dans chaque zone
        notes: "Parfait, maintenu bien dans Z2",
        rating: 8
    },
    "2025-12-02": {
        completed: true,
        completedAt: "2025-12-02T18:45:00Z",
        zoneTimes: [15, 10, 20, 10, 5],
        notes: "Bon effort, les séries étaient intenses",
        rating: 7
    },
    "2025-12-03": {
        completed: true,
        completedAt: "2025-12-03T00:00:00Z",
        zoneTimes: [0, 0, 0, 0, 0],
        notes: "Repos respecté",
        rating: 10
    },
    "2025-12-04": {
        completed: false,
        completedAt: null,
        zoneTimes: [0, 0, 0, 0, 0],
        notes: "Session non effectuée",
        rating: null
    },
    "2025-12-05": {
        completed: false,
        completedAt: null,
        zoneTimes: [0, 0, 0, 0, 0],
        notes: "Reportée à demain",
        rating: null
    },
    "2025-12-06": {
        completed: false,
        completedAt: null,
        zoneTimes: [0, 0, 0, 0, 0],
        notes: "Planifié pour ce soir",
        rating: null
    }
};

console.log("📚 Données d'entraînement chargées !");
console.log("📊 Sessions totales:", Object.keys(window.trainingProgram.sessions).length);
console.log("✅ Sessions complétées:", Object.values(window.userProgress).filter(p => p.completed).length);