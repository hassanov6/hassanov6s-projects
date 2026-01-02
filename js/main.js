/* ========================================
   VARIABLES GLOBALES ET CONSTANTES
   ======================================== */
 
import { db, auth, ref, set, get, onValue, push, update, remove, authenticateUser, WEATHER_CONFIG } from "./firebase-config.js";

let currentUser = null;
let DATA_PATH = null;
const LOCAL_ROUTER_HOSTS = [
  '192.168.2.1', // remplace par l'IP/hostname réel du portail OpenWrt
  'cycling-tracker.lan',
  'router.local'
];

function detectEnvironment() {
  const host = window.location.hostname;
  const isLocalIP = host.startsWith('192.168.2') || host.startsWith('10.') || host === 'localhost';
  if (LOCAL_ROUTER_HOSTS.includes(host) || isLocalIP) {
    return 'router';
  }
  return 'cloud';
}

const CURRENT_ENV = detectEnvironment();
console.log(`🌍 Environnement détecté : ${CURRENT_ENV}`);

// Variables d'état - Initialisation avec structure par défaut
let trainingProgramData = {
    program_info: {},
    sessions: {}
};

let currentEditingDate = null;
let userProgress = JSON.parse(localStorage.getItem('cyclingProgress')) || {};
let nutritionLog = JSON.parse(localStorage.getItem('nutritionLog')) || {};
let performanceData = JSON.parse(localStorage.getItem('performanceData')) || {};
let monthlyStats = JSON.parse(localStorage.getItem('monthlyStats')) || {};
let brytonActivities = JSON.parse(localStorage.getItem('brytonActivities')) || {};
let savedRoutes = JSON.parse(localStorage.getItem('savedRoutes')) || [];
let currentRouteCoordinates = null;
let currentRouteMetadata = {};
let selectedRouteId = null;

// Variables pour la carte
let fitMap = null;
let fitMapReady = false;
const fitRouteSourceId = 'fitRoute';
const fitRouteLayerId = 'fitRouteLine';

// Variables pour les graphiques
let yearlyProgressChartInstance = null;
let heartRateChartInstance = null;
let zonesChartInstance = null;
let phaseChartInstance = null;
let performanceChartInstance = null;
let monthlyStatsChartInstance = null;
let sessionTypeChartInstance = null;

/* ========================================
   SYSTÈME DE SYNCHRONISATION FIREBASE AMÉLIORÉ
   ======================================== */

// Variables de synchronisation
let remoteStateVersion = parseInt(localStorage.getItem('dataVersion') || 1);
let remoteSaveTimer = null;
let remoteSaveInFlight = false;
let syncInProgress = false;
let lastSyncTime = 0;
let syncInterval = 30000; // 30 secondes
let onlineStatus = navigator.onLine;
let pendingSync = false;

// Détection du statut de connexion
window.addEventListener('online', () => {
    onlineStatus = true;
    console.log("🌐 Connexion rétablie");
    showSyncNotification('success', 'Connexion rétablie');
    
    // Synchroniser les données en attente
    if (localStorage.getItem('pendingSync') === 'true' && DATA_PATH && currentUser) {
        persistToFirebase();
        localStorage.removeItem('pendingSync');
    }
});

window.addEventListener('offline', () => {
    onlineStatus = false;
    console.log("📫 Hors ligne - Mode local activé");
    showSyncNotification('error', 'Hors ligne - Mode local activé');
});

// Fonction principale de synchronisation
async function syncWithFirebase(force = false) {
    if (!onlineStatus && !force) {
        console.log("📫 Hors ligne - Synchronisation en attente");
        pendingSync = true;
        return false;
    }

    if (syncInProgress) {
        console.log("⏳ Synchronisation déjà en cours...");
        return false;
    }

    const now = Date.now();
    if (!force && (now - lastSyncTime) < syncInterval) {
        console.log("⏰ Dernière synchronisation trop récente");
        return false;
    }

    syncInProgress = true;
    pendingSync = false;

    try {
        // Récupérer les données distantes
        const remoteData = await fetchRemoteData();
        
        // Fusionner les données locales et distantes
        const mergedData = mergeData(remoteData);
        
        // Sauvegarder les données fusionnées
        await saveToFirebase(mergedData);
        
        // Mettre à jour les données locales
        applyMergedData(mergedData);
        
        lastSyncTime = now;
        console.log("✅ Synchronisation Firebase réussie");
        
        // Mettre à jour l'indicateur de synchronisation
        updateSyncIndicator(true);
        
        return true;
    } catch (error) {
        console.error("❌ Erreur de synchronisation Firebase:", error);
        updateSyncIndicator(false);
        return false;
    } finally {
        syncInProgress = false;
    }
}

// Récupérer les données depuis Firebase
async function fetchRemoteData() {
    if (!DATA_PATH || !currentUser) {
        console.warn("⚠️ Pas d'utilisateur authentifié, retour de données par défaut");
        return {
            version: 0,
            lastModified: 0,
            trainingProgramData: { program_info: {}, sessions: {} },
            userProgress: {},
            nutritionLog: {},
            performanceData: {},
            monthlyStats: {},
            brytonActivities: {},
            savedRoutes: []
        };
    }

    const dataRef = ref(db, DATA_PATH);
    const snapshot = await get(dataRef);
    
    if (snapshot.exists()) {
        return snapshot.val();
    }
    
    return {
        version: 0,
        lastModified: 0,
        trainingProgramData: { program_info: {}, sessions: {} },
        userProgress: {},
        nutritionLog: {},
        performanceData: {},
        monthlyStats: {},
        brytonActivities: {},
        savedRoutes: []
    };
}

// Fusionner les données locales et distantes
function mergeData(remoteData) {
    const localData = {
        version: parseInt(localStorage.getItem('dataVersion') || 0),
        lastModified: parseInt(localStorage.getItem('lastModified') || 0),
        trainingProgramData: trainingProgramData,
        userProgress: userProgress,
        nutritionLog: nutritionLog,
        performanceData: performanceData,
        monthlyStats: monthlyStats,
        brytonActivities: brytonActivities,
        savedRoutes: savedRoutes
    };

    // Si les données distantes sont plus récentes, les utiliser
    if (remoteData.lastModified > localData.lastModified) {
        console.log("📥 Utilisation des données distantes (plus récentes)");
        return {
            ...remoteData,
            version: remoteData.version + 1,
            lastModified: Date.now()
        };
    }
    
    // Sinon, utiliser les données locales
    console.log("💾 Utilisation des données locales (plus récentes)");
    return {
        ...localData,
        version: localData.version + 1,
        lastModified: Date.now()
    };
}

// Sauvegarder les données dans Firebase
async function saveToFirebase(data) {
    if (!DATA_PATH || !currentUser) {
        console.warn("⚠️ Pas d'utilisateur authentifié, sauvegarde locale uniquement");
        return;
    }

    const dataRef = ref(db, DATA_PATH);
    await set(dataRef, data);
    
    // Mettre à jour les métadonnées locales
    localStorage.setItem('dataVersion', data.version);
    localStorage.setItem('lastModified', data.lastModified);
}

// Appliquer les données fusionnées
function applyMergedData(data) {
    trainingProgramData = data.trainingProgramData || { program_info: {}, sessions: {} };
    userProgress = data.userProgress || {};
    nutritionLog = data.nutritionLog || {};
    performanceData = data.performanceData || {};
    monthlyStats = data.monthlyStats || {};
    brytonActivities = data.brytonActivities || {};
    savedRoutes = data.savedRoutes || [];
    
    // Sauvegarder dans localStorage
    saveAllDataToLocalStorage();
    
    // Mettre à jour l'interface
    ensureDefaults();
    updateMonthlyPlan();
    updateRoutesList();
    buildStravaActivityList();
}

// Migration des données depuis l'ancien utilisateur
async function migrateFromOldUser() {
    console.log("🔄 Recherche des anciennes données...");

    try {
        const oldDataPath = "users/default-user";
        const oldDataRef = ref(db, oldDataPath);
        const snapshot = await get(oldDataRef);

        if (snapshot.exists()) {
            const oldData = snapshot.val();
            console.log("✅ Anciennes données trouvées, migration en cours...");

            // Créer une sauvegarde avant migration
            const backupData = {
                ...oldData,
                version: (oldData.version || 0) + 1,
                lastModified: Date.now(),
                migratedFrom: "default-user",
                migratedAt: new Date().toISOString()
            };

            // Sauvegarder dans le nouveau chemin utilisateur
            await saveToFirebase(backupData);

            // Mettre à jour les variables locales avec les anciennes données
            if (oldData.userProgress) userProgress = oldData.userProgress;
            if (oldData.trainingProgramData) {
                trainingProgramData = {
                    program_info: {
                        ...(trainingProgramData.program_info || {}),
                        ...(oldData.trainingProgramData.program_info || {})
                    },
                    sessions: {
                        ...(trainingProgramData.sessions || {}),
                        ...(oldData.trainingProgramData.sessions || {})
                    }
                };
            }
            if (oldData.nutritionLog) nutritionLog = oldData.nutritionLog;
            if (oldData.performanceData) performanceData = oldData.performanceData;
            if (oldData.monthlyStats) monthlyStats = oldData.monthlyStats;
            if (oldData.brytonActivities) brytonActivities = oldData.brytonActivities;

            console.log("✅ Migration terminée avec succès !");

            // Synchroniser le localStorage
            localStorage.setItem('cyclingProgress', JSON.stringify(userProgress));
            localStorage.setItem('trainingProgramData', JSON.stringify(trainingProgramData));
            localStorage.setItem('nutritionLog', JSON.stringify(nutritionLog));
            localStorage.setItem('performanceData', JSON.stringify(performanceData));
            localStorage.setItem('monthlyStats', JSON.stringify(monthlyStats));
            localStorage.setItem('brytonActivities', JSON.stringify(brytonActivities));

        } else {
            console.log("ℹ️ Aucunes anciennes données trouvées, utilisation des données locales/par défaut");
        }
    } catch (error) {
        console.warn("⚠️ Erreur lors de la migration:", error.message);
    }
}

// Fonctions Firebase existantes améliorées
function buildSyncPayload() {
    const payload = {
        version: remoteStateVersion++,
        lastModified: Date.now(),
        trainingProgramData,
        userProgress,
        nutritionLog,
        performanceData,
        monthlyStats,
        brytonActivities,
        savedRoutes
    };
    
    console.log("📤 Construction du payload de synchronisation");
    return payload;
}

function scheduleRemoteSave() {
    clearTimeout(remoteSaveTimer);

    // Sauvegarder immédiatement dans localStorage
    saveAllDataToLocalStorage();

    // Planifier la sauvegarde Firebase seulement si disponible
    remoteSaveTimer = setTimeout(() => {
        if (!DATA_PATH || !currentUser) {
            console.log("📫 Firebase non disponible - Données locales sauvegardées");
            return;
        }

        if (navigator.onLine) {
            persistToFirebase();
        } else {
            console.log("📫 Hors ligne - Sauvegarde en attente");
            localStorage.setItem('pendingSync', 'true');
        }
    }, 750);
}

async function persistToFirebase() {
    if (remoteSaveInFlight) {
        console.log("⏳ Sauvegarde Firebase déjà en cours...");
        return;
    }

    // Vérifier si Firebase est disponible
    if (!DATA_PATH || !currentUser) {
        console.log("⚠️ Firebase non disponible - Mode hors-ligne");
        showSyncNotification('warning', 'Mode hors-ligne - Données locales uniquement');
        // Sauvegarder uniquement dans localStorage en local
        saveAllDataToLocalStorage();
        return;
    }

    remoteSaveInFlight = true;

    try {
        const payload = buildSyncPayload();
        await set(ref(db, DATA_PATH), payload);
        
        // Mettre à jour les métadonnées locales
        localStorage.setItem('dataVersion', payload.version);
        localStorage.setItem('lastModified', payload.lastModified);
        
        console.log("✅ Données synchronisées dans Firebase");
        showSyncNotification('success', 'Données synchronisées');
        
    } catch (error) {
        console.error("❌ Échec de la sauvegarde Firebase :", error);
        showSyncNotification('error', 'Erreur de synchronisation');
        localStorage.setItem('pendingSync', 'true');
        
    } finally {
        remoteSaveInFlight = false;
    }
}

function applyDataFromFirebase(payload = {}) {
    console.log("📥 Application des données depuis Firebase...");
    
    // Assurer que trainingProgramData est correctement initialisé
    if (!trainingProgramData) {
        trainingProgramData = {
            program_info: {},
            sessions: {}
        };
    }
    
    // Assurer que sessions est toujours défini
    if (!trainingProgramData.sessions) {
        trainingProgramData.sessions = {};
    }
    
    // Fusionner les données de Firebase en préservant la structure
    if (payload.trainingProgramData) {
        trainingProgramData = {
            program_info: {
                ...(trainingProgramData.program_info || {}),
                ...(payload.trainingProgramData.program_info || {})
            },
            sessions: {
                ...(trainingProgramData.sessions || {}),
                ...(payload.trainingProgramData.sessions || {})
            }
        };
    }
    
    // Assurer que sessions est défini même après la fusion
    if (!trainingProgramData.sessions) {
        trainingProgramData.sessions = {};
    }

    // Fusionner les autres données
    userProgress = { ...userProgress, ...(payload.userProgress || {}) };
    nutritionLog = { ...nutritionLog, ...(payload.nutritionLog || {}) };
    performanceData = { ...performanceData, ...(payload.performanceData || {}) };
    monthlyStats = { ...monthlyStats, ...(payload.monthlyStats || {}) };
    brytonActivities = { ...brytonActivities, ...(payload.brytonActivities || {}) };
    savedRoutes = payload.savedRoutes || [];

    // Sauvegarder immédiatement dans localStorage
    saveAllDataToLocalStorage();
    
    // Sauvegarder la version des données
    if (payload.version) {
        localStorage.setItem('dataVersion', payload.version);
    }
    if (payload.lastModified) {
        localStorage.setItem('lastModified', payload.lastModified);
    }

    console.log("✅ Données appliquées et sauvegardées localement");

    // Mettre à jour l'interface
    ensureDefaults();
    updateMonthlyPlan();
    updateRoutesList();
    buildStravaActivityList();
}

async function initData() {
    console.log("🚀 Initialisation des données...");
    
    // ÉTAPE 1: Charger d'abord les données depuis localStorage
    await loadFromLocalStorage();
    
    // ÉTAPE 2: Debug - Vérifier ce qui est chargé
    console.log("📊 Données chargées depuis localStorage:");
    console.log("- userProgress:", userProgress);
    console.log("- Sessions complétées:", Object.keys(userProgress).filter(date => userProgress[date].completed));
    
    // ÉTAPE 3: Synchronisation avec Firebase
    const dataRef = ref(db, DATA_PATH);

    try {
        // Lecture initiale depuis Firebase
        const snapshot = await get(dataRef);
        if (snapshot.exists()) {
            const firebaseData = snapshot.val();
            const localVersion = parseInt(localStorage.getItem('dataVersion') || 0);
            const remoteVersion = firebaseData.version || 0;
            
            console.log(`📡 Version locale: ${localVersion}, Version distante: ${remoteVersion}`);
            
            if (remoteVersion > localVersion) {
                console.log("📥 Les données Firebase sont plus récentes - Application des données Firebase");
                applyDataFromFirebase(firebaseData);
            } else {
                console.log("💾 Utilisation des données locales (plus récentes)");
                // Forcer la mise à jour de l'interface avec les données locales
                ensureDefaults();
                updateMonthlyPlan();
            }
        } else {
            console.log("📭 Aucune donnée dans Firebase - Initialisation avec les données locales");
            ensureDefaults();
            updateMonthlyPlan();
            // Sauvegarder les données initiales dans Firebase (seulement si authentifié)
            if (DATA_PATH && currentUser) {
                persistToFirebase();
            }
        }
    } catch (err) {
        console.error("❌ Impossible de lire Firebase :", err);
        // En cas d'erreur, utiliser les données locales
        ensureDefaults();
        updateMonthlyPlan();
    }

    // ÉTAPE 4: Mise à jour en temps réel depuis Firebase
    onValue(dataRef, (snapshot) => {
        if (snapshot.exists() && !remoteSaveInFlight) {
            const firebaseData = snapshot.val();
            const localVersion = parseInt(localStorage.getItem('dataVersion') || 0);
            const remoteVersion = firebaseData.version || 0;
            
            if (remoteVersion > localVersion) {
                console.log("🔄 Mise à jour en temps réel détectée");
                applyDataFromFirebase(firebaseData);
            }
        }
    });
    
    // ÉTAPE 5: Vérifier s'il y a une synchronisation en attente
    if (localStorage.getItem('pendingSync') === 'true' && navigator.onLine && DATA_PATH && currentUser) {
        console.log("🔄 Synchronisation des données en attente...");
        persistToFirebase();
        localStorage.removeItem('pendingSync');
    }
    
    // ÉTAPE 6: Forcer la mise à jour de l'interface après chargement
    setTimeout(() => {
        console.log("🔄 Mise à jour forcée de l'interface");
        updateMonthlyPlan();
        updateStats();
        updatePerformanceMetrics();
    }, 500);
    
    // Démarrer la synchronisation automatique
    setInterval(() => {
        if (onlineStatus) {
            syncWithFirebase();
        }
    }, syncInterval);
}

// Fonction pour charger depuis localStorage
async function loadFromLocalStorage() {
    try {
        const savedTrainingProgramData = localStorage.getItem('trainingProgramData');
        const savedUserProgress = localStorage.getItem('cyclingProgress');
        const savedNutritionLog = localStorage.getItem('nutritionLog');
        const savedPerformanceData = localStorage.getItem('performanceData');
        const savedMonthlyStats = localStorage.getItem('monthlyStats');
        const savedBrytonActivities = localStorage.getItem('brytonActivities');
        const savedSavedRoutes = localStorage.getItem('savedRoutes');

        if (savedTrainingProgramData) {
            trainingProgramData = JSON.parse(savedTrainingProgramData);
        }
        if (savedUserProgress) {
            userProgress = JSON.parse(savedUserProgress);
        }
        if (savedNutritionLog) {
            nutritionLog = JSON.parse(savedNutritionLog);
        }
        if (savedPerformanceData) {
            performanceData = JSON.parse(savedPerformanceData);
        }
        if (savedMonthlyStats) {
            monthlyStats = JSON.parse(savedMonthlyStats);
        }
        if (savedBrytonActivities) {
            brytonActivities = JSON.parse(savedBrytonActivities);
        }
        if (savedSavedRoutes) {
            savedRoutes = JSON.parse(savedSavedRoutes);
        }

        console.log("✅ Données chargées depuis localStorage");
    } catch (error) {
        console.error("❌ Erreur lors du chargement des données locales:", error);
    }
}

// Fonction de sauvegarde locale complète
function saveAllDataToLocalStorage() {
    try {
        localStorage.setItem("trainingProgramData", JSON.stringify(trainingProgramData));
        localStorage.setItem("cyclingProgress", JSON.stringify(userProgress));
        localStorage.setItem("nutritionLog", JSON.stringify(nutritionLog));
        localStorage.setItem("performanceData", JSON.stringify(performanceData));
        localStorage.setItem("monthlyStats", JSON.stringify(monthlyStats));
        localStorage.setItem("brytonActivities", JSON.stringify(brytonActivities));
        localStorage.setItem("savedRoutes", JSON.stringify(savedRoutes));
        
        console.log("💾 Données sauvegardées dans localStorage");
    } catch (error) {
        console.error("❌ Erreur lors de la sauvegarde locale:", error);
    }
}

// Système de notifications
function showSyncNotification(type, message) {
    // Créer l'élément de notification
    const notification = document.createElement('div');
    notification.className = `sync-notification ${type}`;
    notification.innerHTML = `
        <span class="notification-icon">${type === 'success' ? '✅' : '❌'}</span>
        <span class="notification-message">${message}</span>
    `;
    
    // Ajouter au corps du document
    document.body.appendChild(notification);
    
    // Afficher avec animation
    setTimeout(() => {
        notification.classList.add('show');
    }, 100);
    
    // Masquer après 3 secondes
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (document.body.contains(notification)) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Indicateur de synchronisation
function updateSyncIndicator(success) {
    const indicator = document.getElementById('syncIndicator');
    if (indicator) {
        if (success) {
            indicator.className = 'sync-indicator success';
            indicator.innerHTML = '✅';
            indicator.title = 'Synchronisé avec Firebase';
        } else {
            indicator.className = 'sync-indicator error';
            indicator.innerHTML = '❌';
            indicator.title = 'Erreur de synchronisation';
        }
        
        // Masquer l'indicateur après 3 secondes
        setTimeout(() => {
            indicator.className = 'sync-indicator hidden';
        }, 3000);
    }
}

/* ========================================
   FONCTIONS UTILITAIRES
   ======================================== */

// Obtenir les jours de la semaine en français
function getFrenchDay(date) {
    const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    return days[date.getDay()];
}

// Obtenir le nombre de jours dans le mois
function getDaysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
}

// Obtenir le nom du mois en français
function getMonthName(monthIndex) {
    const months = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
    return months[monthIndex];
}

// Formater une date YYYY-MM-DD en format lisible
function formatDate(dateStr) {
    if (!dateStr) return "N/A";

    try {
        const [year, month, day] = dateStr.split('-').map(Number);
        if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
            return `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
        }

        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return "Date invalide";

        return `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getFullYear()}`;
    } catch (e) {
        console.error("Erreur format date:", e);
        return "Erreur date";
    }
}

// Formater le temps en heures et minutes
function formatTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);

    if (hours > 0) {
        return `${hours}h${mins > 0 ? ` ${mins}min` : ''}`;
    } else {
        return `${mins}min`;
    }
}

// Formater la durée pour la carte
function formatDurationForMap(minutes) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (h > 0) {
        return `${h}h ${m.toString().padStart(2, '0')}m`;
    }
    return `${m} min`;
}

// Obtenir la couleur de l'intensité
function getIntensityColor(intensity) {
    const colors = {
        'Repos': '#9E9E9E',
        'Légère': '#4CAF50',
        'Modérée': '#FFC107',
        'Élevée': '#FF9800',
        'Très élevée': '#F44336',
        'Maximale': '#D32F2F'
    };
    return colors[intensity] || '#9E9E9E';
}

// Obtenir le facteur d'intensité
function getIntensityFactor(intensity) {
    const factors = {
        'Repos': 0,
        'Légère': 0.25,
        'Modérée': 0.5,
        'Élevée': 0.75,
        'Très élevée': 0.9,
        'Maximale': 1.0
    };
    return factors[intensity] || 0.5;
}

// Estimer une intensité à partir de la FC moyenne (% FCmax)
function estimateIntensityFromHR(avgPct) {
    if (avgPct >= 90) return 'Très élevée';
    if (avgPct >= 80) return 'Élevée';
    if (avgPct >= 70) return 'Modérée';
    if (avgPct >= 60) return 'Légère';
    return 'Légère';
}

// Normaliser la durée en minutes
function normalizeDurationToMinutes(value) {
    if (value === null || value === undefined) return 0;
    const v = Number(value);
    if (!isFinite(v)) return 0;

    if (v > 1e6) {
        return Math.round(v / 1000 / 60);
    } else if (v > 10000) {
        return Math.round(v / 60);
    } else if (v > 500) {
        return Math.round(v / 60);
    } else {
        return Math.round(v);
    }
}

// Normaliser la distance en kilomètres
function normalizeDistanceToKm(value) {
    if (value === null || value === undefined) return 0;
    const v = Number(value);
    if (!isFinite(v)) return 0;

    if (v >= 10000) {
        return Number((v / 1000).toFixed(2));
    } else if (v >= 100) {
        return Number((v / 1000).toFixed(2));
    } else if (v > 0 && v < 0.1) {
        return Number(v.toFixed(2));
    } else {
        return Number(v.toFixed(2));
    }
}

// Normaliser les coordonnées
function normalizeCoord(raw, isLat) {
    if (!Number.isFinite(raw)) return null;
    const limit = isLat ? 90 : 180;

    if (Math.abs(raw) <= limit) return raw;

    const deg = raw * (180 / Math.pow(2, 31));
    if (!Number.isFinite(deg) || Math.abs(deg) > limit) return null;

    return deg;
}

// Convertir minutes en millisecondes
function toMinutes(secOrMs) {
    if (!secOrMs || secOrMs <= 0) return 0;
    return secOrMs > 3600 * 100 ? Math.round(secOrMs / 60000) : Math.round(secOrMs / 60);
}

// Calcul de distance Haversine
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Construire GeoJSON à partir des coordonnées
function buildGeoJSONFromCoordinates(coords) {
    if (!coords || coords.length < 2) return null;
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: coords
                },
                properties: {}
            }
        ]
    };
}

/* ========================================
   FONCTIONS DE GESTION DES DONNÉES
   ======================================== */

// Assurer les valeurs par défaut
function ensureDefaults() {
    if (!trainingProgramData) {
        trainingProgramData = {
            program_info: {},
            sessions: {}
        };
    }
    
    trainingProgramData.program_info = trainingProgramData.program_info || {};
    const pi = trainingProgramData.program_info;
    pi.cyclist_profile = pi.cyclist_profile || {};
    const cp = pi.cyclist_profile;
    if (typeof cp.weight !== 'number' || cp.weight <= 0) cp.weight = 75;
    if (typeof cp.max_heart_rate !== 'number' || cp.max_heart_rate <= 0) cp.max_heart_rate = 170;
    if (typeof cp.rest_heart_rate !== 'number' || cp.rest_heart_rate <= 0) cp.rest_heart_rate = 65;
    
    // Assurer que sessions est toujours défini
    if (!trainingProgramData.sessions) {
        trainingProgramData.sessions = {};
    }
}

// Calculer les calories brûlées
function calculateCalories(session, actualData) {
    let met = 4;
    const intensity = session?.intensity || 'Modérée';
    if (intensity === 'Repos') met = 1;
    else if (intensity === 'Légère') met = 4;
    else if (intensity === 'Modérée') met = 7;
    else if (intensity === 'Élevée') met = 10;
    else if (intensity === 'Très élevée') met = 12;
    else if (intensity === 'Maximale') met = 14;

    const durationHours = ((actualData?.actualDuration ?? session?.duration_minutes) || 0) / 60;
    const weight = trainingProgramData?.program_info?.cyclist_profile?.weight ?? 75;
    return Math.round(durationHours * met * weight);
}

// Calculer le TSS (Training Stress Score)
function calculateTSS(session, actualData) {
    const duration = ((actualData?.actualDuration ?? session?.duration_minutes) || 0) / 60;
    const intensityFactor = getIntensityFactor(session?.intensity || 'Modérée');
    return Math.round(duration * intensityFactor * 100);
}

// Calculer le CTL (Chronic Training Load)
function calculateCTL() {
    let ctl = 0;
    const last42Days = 42;
    const completedDates = Object.keys(userProgress)
        .filter(date => userProgress[date].completed)
        .sort()
        .slice(-last42Days);

    if (completedDates.length === 0) return 0;

    completedDates.forEach(date => {
        const session = trainingProgramData.sessions[date];
        const tss = userProgress[date].tss || calculateTSS(session, userProgress[date]);
        ctl = (ctl * 0.85) + (tss * 0.15);
    });

    return Math.round(ctl);
}

// Calculer le ATL (Acute Training Load)
function calculateATL() {
    let atl = 0;
    const last7Days = 7;
    const completedDates = Object.keys(userProgress)
        .filter(date => userProgress[date].completed)
        .sort()
        .slice(-last7Days);

    if (completedDates.length === 0) return 0;

    completedDates.forEach(date => {
        const session = trainingProgramData.sessions[date];
        const tss = userProgress[date].tss || calculateTSS(session, userProgress[date]);
        atl = (atl * 0.58) + (tss * 0.42);
    });

    return Math.round(atl);
}

// Calculer le TSB (Training Stress Balance)
function calculateTSB() {
    return calculateCTL() - calculateATL();
}

// Interpréter le TSB
function getTSBInterpretation(tsb) {
    if (tsb > 10) return "Prêt pour la course";
    else if (tsb > 0) return "En bonne forme";
    else if (tsb > -10) return "Assez fatigué";
    else return "Très fatigué";
}

// Exporter les données
function exportData() {
    const data = {
        trainingProgram: trainingProgramData,
        userProgress: userProgress,
        nutritionLog: nutritionLog,
        performanceData: performanceData,
        monthlyStats: monthlyStats,
        brytonActivities: brytonActivities,
        exportDate: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cycling_program_backup.json';
    a.click();
    URL.revokeObjectURL(url);
}

// Importer les données
function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const data = JSON.parse(e.target.result);
                if (data.trainingProgram) {
                    if (data.trainingProgram.sessions && Object.keys(data.trainingProgram.sessions).length > 0) {
                        trainingProgramData.sessions = data.trainingProgram.sessions;
                    }
                    if (data.trainingProgram.program_info) {
                        const incoming = data.trainingProgram.program_info;
                        trainingProgramData.program_info = {
                            ...(trainingProgramData.program_info || {}),
                            ...incoming,
                            cyclist_profile: {
                                ...(trainingProgramData.program_info?.cyclist_profile || {}),
                                ...(incoming.cyclist_profile || {})
                            }
                        };
                    }
                }
                userProgress = data.userProgress || {};
                nutritionLog = data.nutritionLog || {};
                performanceData = data.performanceData || {};
                monthlyStats = data.monthlyStats || {};
                brytonActivities = data.brytonActivities || {};

                ensureDefaults();

                saveAllDataToLocalStorage();
                scheduleRemoteSave();

                yearlyProgressChartInstance = null;
                heartRateChartInstance = null;
                zonesChartInstance = null;
                phaseChartInstance = null;
                performanceChartInstance = null;
                monthlyStatsChartInstance = null;
                sessionTypeChartInstance = null;

                updateMonthlyPlan();
                alert("✅ Données importées avec succès!");
            } catch (err) {
                console.error(err);
                alert("❌ Erreur de lecture du fichier!");
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// Réinitialiser la progression
function resetProgress() {
    if (confirm("Êtes-vous sûr de vouloir réinitialiser toutes les données?")) {
        localStorage.removeItem('cyclingProgress');
        localStorage.removeItem('trainingProgramData');
        localStorage.removeItem('nutritionLog');
        localStorage.removeItem('performanceData');
        localStorage.removeItem('monthlyStats');
        localStorage.removeItem('brytonActivities');

        userProgress = {};
        nutritionLog = {};
        performanceData = {};
        monthlyStats = {};
        brytonActivities = {};

        // Réinitialiser trainingProgramData avec la structure par défaut
        trainingProgramData = {
            program_info: {},
            sessions: {}
        };

        saveAllDataToLocalStorage();
        scheduleRemoteSave();
        updateMonthlyPlan();
        alert("🔄 Données réinitialisées!");
    }
}

/* ========================================
   FONCTIONS DE MISE À JOUR DE L'INTERFACE
   ======================================== */

// Mettre à jour le tableau mensuel
// Mettre à jour le tableau mensuel
function updateMonthlyPlan() {
    // Assurer que trainingProgramData et sessions sont définis
    if (!trainingProgramData) {
        trainingProgramData = {
            program_info: {},
            sessions: {}
        };
    }

    if (!trainingProgramData.sessions) {
        trainingProgramData.sessions = {};
    }

    // Si aucune donnée d'entraînement et pas d'import manuel demandé, générer un programme de base
    if (Object.keys(trainingProgramData.sessions).length === 0 && !localStorage.getItem('skipAutoGeneration')) {
        console.log("🔄 Aucune donnée d'entraînement trouvée - Génération du programme de base");
        generateBasicTrainingProgram();
    } else if (Object.keys(trainingProgramData.sessions).length === 0 && localStorage.getItem('skipAutoGeneration')) {
        console.log("📋 Mode import activé - Pas de génération automatique");

        // Afficher un message pour informer l'utilisateur
        const monthSelector = document.getElementById('monthSelector');
        if (monthSelector) {
            const [year, month] = monthSelector.value.split('-').map(Number);
            const daysInMonth = getDaysInMonth(year, month - 1);

            let tableHTML = `
                <div class="calendar-header">
                    <div class="month-info">
                        ${getMonthName(month - 1)} ${year}
                    </div>
                    <div style="color: #666;">
                        ${daysInMonth} jours
                    </div>
                </div>

                <div class="alert alert-info">
                    <h4>📋 Aucun programme chargé</h4>
                    <p>Votre programme est vide. Utilisez le bouton "📋 Importer programme JSON" pour charger votre programme d'entraînement.</p>
                    <p><strong>Formats supportés :</strong> JSON avec sessions par date (format: YYYY-MM-DD)</p>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Jour</th>
                            <th>Type d'entraînement</th>
                            <th>Durée</th>
                            <th>Intensité</th>
                            <th>Fréquence cardiaque</th>
                            <th>Statut</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td colspan="7" class="text-center text-muted">
                                <em>Aucune session prévue - Importez un programme JSON</em>
                            </td>
                        </tr>
                    </tbody>
                </table>
            `;

            const monthlyPlanTable = document.getElementById('monthlyPlanTable');
            if (monthlyPlanTable) {
                monthlyPlanTable.innerHTML = tableHTML;
            }

            return; // Sortir de la fonction pour éviter le traitement normal
        }
    }
    
    const monthSelector = document.getElementById('monthSelector');
    if (!monthSelector) {
        console.error("❌ monthSelector non trouvé");
        return;
    }

    const selectedMonth = monthSelector.value;
    if (!selectedMonth) {
        console.error("❌ Aucun mois sélectionné");
        return;
    }

    const [year, month] = selectedMonth.split('-').map(Number);
    const daysInMonth = getDaysInMonth(year, month - 1);

    let tableHTML = `
        <div class="calendar-header">
            <div class="month-info">
                ${getMonthName(month - 1)} ${year}
            </div>
            <div style="color: #666;">
                ${daysInMonth} jours
            </div>
        </div>

        <div class="week-summary-box">
            <h4>📊 Résumé du mois</h4>
            <div class="week-stats">
                <div class="week-stat">
                    <div class="week-stat-number" id="monthHours">0</div>
                    <div class="week-stat-label">Heures</div>
                </div>
                <div class="week-stat">
                    <div class="week-stat-number" id="monthSessions">0</div>
                    <div class="week-stat-label">Sessions</div>
                </div>
                <div class="week-stat">
                    <div class="week-stat-number" id="monthTSS">0</div>
                    <div class="week-stat-label">TSS</div>
                </div>
                <div class="week-stat">
                    <div class="week-stat-number" id="monthCompletion">0%</div>
                    <div class="week-stat-label">Complétion</div>
                </div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Date</th>
                    <th>Jour</th>
                    <th>Type d'entraînement</th>
                    <th>Durée</th>
                    <th>Intensité</th>
                    <th>Fréquence cardiaque</th>
                    <th>Statut</th>
                </tr>
            </thead>
            <tbody>`;

    let totalHours = 0;
    let totalSessions = 0;
    let totalTSS = 0;
    let completedSessions = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const date = new Date(year, month - 1, day);
        const frenchDay = getFrenchDay(date);

        // Vérifier si c'est aujourd'hui
        const today = new Date();
        const isToday = date.toDateString() === today.toDateString();

        // Debug: afficher si c'est aujourd'hui
        if (isToday) {
            console.log(`🔆 Aujourd'hui détecté: ${dateStr}`);
        }

        const session = trainingProgramData.sessions[dateStr];
        
        // Vérifier si la session est complétée - C'EST LA PARTIE IMPORTANTE
        const isCompleted = userProgress[dateStr]?.completed || false;
        
        // Debug : afficher dans la console pour vérifier
        if (isCompleted) {
            console.log(`✅ Session complétée trouvée pour ${dateStr}`);
        }

        let rowClass = '';
        let sessionIcon = '';
        let sessionType = 'Repos';
        let duration = 'Repos';
        let intensity = 'Repos';
        let heartRate = 'N/A';
        let statusIcon = '⏳'; // Par défaut : en attente

        if (session) {
            if (session.session_type === 'Repos') {
                rowClass = 'rest-row';
                sessionIcon = '🛌';
            } else if (session.session_type === 'Récupération active') {
                rowClass = 'recovery-row';
                sessionIcon = '🚶‍♂️';
            } else if (session.session_type.includes('endurance')) {
                rowClass = 'endurance-row';
                sessionIcon = '🚴‍♂️';
            } else if (session.session_type.includes('force')) {
                rowClass = 'intensity-row';
                sessionIcon = '💪';
            } else if (session.session_type.includes('seuil')) {
                rowClass = 'threshold-row';
                sessionIcon = '⚡';
            } else if (session.session_type.includes('VO2') || session.session_type.includes('pic')) {
                rowClass = 'vo2-row';
                sessionIcon = '🚀';
            } else if (session.session_type.includes('course')) {
                rowClass = 'race-row';
                sessionIcon = '🏁';
            } else {
                rowClass = 'endurance-row';
                sessionIcon = '🚴‍♂️';
            }

            // Ajouter la classe today-row si c'est aujourd'hui
            if (isToday) {
                rowClass += ' today-row';
            }

            sessionType = session.session_type;
            duration = session.duration_minutes > 0 ? `${session.duration_minutes} min` : 'Repos';
            intensity = session.intensity;
            heartRate = session.heart_rate_zone;

            if (session.duration_minutes > 0) {
                totalSessions++;
                totalHours += session.duration_minutes / 60;
            }

            // PARTIE CRUCIALE : Mettre à jour l'icône de statut
            if (isCompleted) {
                statusIcon = '✅'; // Session complétée
                completedSessions++;
                const tss = userProgress[dateStr].tss || calculateTSS(session, userProgress[dateStr]);
                totalTSS += tss;
            } else {
                statusIcon = '⏳'; // Session non complétée
            }
        } else {
            rowClass = 'rest-row';
            sessionIcon = '🛌';
            // Pour les jours sans session, vérifier quand même s'il y a une progression
            if (isCompleted) {
                statusIcon = '✅';
                completedSessions++;
            }

            // Ajouter la classe today-row si c'est aujourd'hui
            if (isToday) {
                rowClass += ' today-row';
            }
        }

        // Debug: afficher la classe CSS pour aujourd'hui
        if (isToday) {
            console.log(`🔆 Classe CSS appliquée: ${rowClass}`);
        }

        tableHTML += `
            <tr class="${rowClass}">
                <td class="date-cell" onclick="openSessionModal('${dateStr}')">
                    ${day}/${month}
                </td>
                <td>${frenchDay}</td>
                <td>
                    <span class="session-icon">${sessionIcon}</span>
                    ${sessionType}
                </td>
                <td>
                   ${session && session.duration_minutes > 0 ? `<span class="duration-badge">${duration}</span>` : duration}
                </td>
                <td>
                    <span class="intensity-badge" style="background: ${getIntensityColor(intensity)}; color: white;">
                        ${intensity}
                    </span>
                </td>
                <td>${heartRate}</td>
                <td class="status-icon" onclick="toggleSessionStatus('${dateStr}')">${statusIcon}</td>
            </tr>`;
    }

    tableHTML += `</tbody></table>`;
    document.getElementById('monthlyPlanTable').innerHTML = tableHTML;

    document.getElementById('monthHours').textContent = Math.round(totalHours);
    document.getElementById('monthSessions').textContent = totalSessions;
    document.getElementById('monthTSS').textContent = totalTSS;
    document.getElementById('monthCompletion').textContent = totalSessions > 0 ? Math.round((completedSessions / totalSessions) * 100) + '%' : '0%';

    updateMonthlyStats();
    updateStats();
    updateCharts();
    updatePerformanceMetrics();
    updateBrytonActivities();
    
    // Sauvegarder et synchroniser automatiquement
    saveAllDataToLocalStorage();
    scheduleRemoteSave();
}

// Mettre à jour les statistiques mensuelles détaillées
function updateMonthlyStats() {
    const selectedMonth = document.getElementById('monthSelector').value;
    if (!selectedMonth) {
        console.error("Aucun mois sélectionné");
        return;
    }

    const [year, month] = selectedMonth.split('-').map(Number);
    const daysInMonth = getDaysInMonth(year, month - 1);

    let totalDistance = 0;
    let totalSpeed = 0;
    let speedCount = 0;
    let totalCalories = 0;
    let activeDays = 0;
    let restDays = 0;
    let enduranceTime = 0;
    let strengthTime = 0;
    let techniqueTime = 0;
    let longSessions = 0;
    let intenseSessions = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const session = trainingProgramData.sessions[dateStr];

        if (session) {
            if (session.session_type === 'Repos') {
                restDays++;
            } else {
                activeDays++;
            }

            if (session.duration_minutes > 0 && session.session_type !== 'Repos') {
                const durationHours = session.duration_minutes / 60;
                let distance = 0;
                let speed = 0;

                if (userProgress[dateStr]?.distance) {
                    distance = parseFloat(userProgress[dateStr].distance);
                    speed = distance / durationHours;
                } else {
                    const intensityFactor = getIntensityFactor(session.intensity);
                    speed = 20 + (intensityFactor * 15);
                    distance = speed * durationHours;

                    if (!userProgress[dateStr]) {
                        userProgress[dateStr] = {};
                    }
                    if (!userProgress[dateStr].distance) {
                        userProgress[dateStr].distance = distance.toFixed(1);
                    }
                }

                totalDistance += distance;
                totalSpeed += speed;
                speedCount++;

                const calories = calculateCalories(session, userProgress[dateStr]);
                totalCalories += calories;

                if (session.session_type.includes('endurance')) {
                    enduranceTime += session.duration_minutes;
                } else if (session.session_type.includes('force')) {
                    strengthTime += session.duration_minutes;
                } else if (session.session_type.includes('technique') || session.session_type.includes('cadence')) {
                    techniqueTime += session.duration_minutes;
                } else if (session.session_type.includes('Récupération active')) {
                    enduranceTime += session.duration_minutes * 0.5;
                } else {
                    if (session.intensity === 'Légère' || session.intensity === 'Modérée') {
                        enduranceTime += session.duration_minutes * 0.8;
                    } else {
                        enduranceTime += session.duration_minutes * 0.5;
                        strengthTime += session.duration_minutes * 0.3;
                    }
                }

                if (session.duration_minutes >= 120) {
                    longSessions++;
                }

                if (session.intensity === 'Élevée' || session.intensity === 'Très élevée' || session.intensity === 'Maximale') {
                    intenseSessions++;
                }
            }
        } else {
            restDays++;
        }
    }

    const avgSpeed = speedCount > 0 ? totalSpeed / speedCount : 0;

    document.getElementById('monthlyDistance').textContent = `${totalDistance.toFixed(1)} km`;
    document.getElementById('avgSpeed').textContent = `${avgSpeed.toFixed(1)} km/h`;
    document.getElementById('caloriesBurned').textContent = `${Math.round(totalCalories)} kcal`;
    document.getElementById('activeDays').textContent = activeDays;
    document.getElementById('activeDaysCount').textContent = activeDays;
    document.getElementById('restDaysCount').textContent = restDays;

    document.getElementById('enduranceTime').textContent = `${formatTime(enduranceTime)}`;
    document.getElementById('strengthTime').textContent = `${formatTime(strengthTime)}`;
    document.getElementById('techniqueTime').textContent = `${formatTime(techniqueTime)}`;
    document.getElementById('totalExerciseTime').textContent = `${formatTime(enduranceTime + strengthTime + techniqueTime)}`;

    document.getElementById('longIntenseSessions').textContent = longSessions + intenseSessions;

    updateSessionTypeChart(longSessions, intenseSessions);

    if (!monthlyStats[selectedMonth]) {
        monthlyStats[selectedMonth] = {};
    }

    monthlyStats[selectedMonth] = {
        distance: totalDistance,
        avgSpeed: avgSpeed,
        calories: totalCalories,
        activeDays: activeDays,
        restDays: restDays,
        enduranceTime: enduranceTime,
        strengthTime: strengthTime,
        techniqueTime: techniqueTime,
        longSessions: longSessions,
        intenseSessions: intenseSessions,
        lastUpdated: new Date().toISOString()
    };

    saveAllDataToLocalStorage();
}

// Mettre à jour les statistiques
function updateStats() {
    const totalHours = Object.values(trainingProgramData.sessions)
        .reduce((sum, session) => sum + (session.duration_minutes || 0), 0) / 60;

    const completedSessions = Object.keys(userProgress).filter(date =>
        userProgress[date].completed).length;

    let totalHeartRate = 0;
    let heartRateCount = 0;
    let maxZone = 'Z1';

    Object.values(trainingProgramData.sessions).forEach(session => {
        if (session.heart_rate_zone && session.heart_rate_zone !== 'N/A') {
            const match = session.heart_rate_zone.match(/(\d+)-(\d+)%/);
            if (match) {
                const min = parseInt(match[1]);
                const max = parseInt(match[2]);
                const avg = (min + max) / 2;
                totalHeartRate += avg;
                heartRateCount++;

                if (max >= 90) maxZone = 'Z5';
                else if (max >= 80) maxZone = 'Z4';
                else if (max >= 70) maxZone = 'Z3';
                else if (max >= 60) maxZone = 'Z2';
            }
        }
    });

    const avgHeartRate = heartRateCount > 0 ? Math.round(totalHeartRate / heartRateCount) : 0;

    document.getElementById('totalHours').textContent = Math.round(totalHours);
    document.getElementById('sessionsCompleted').textContent = completedSessions;
    document.getElementById('avgHeartRate').textContent = avgHeartRate + '%';
    document.getElementById('maxHeartRateZone').textContent = maxZone;
}

// Mettre à jour les indicateurs de performance
function updatePerformanceMetrics() {
    const ctl = calculateCTL();
    const atl = calculateATL();
    const tsb = calculateTSB();
    const form = getTSBInterpretation(tsb);

    document.getElementById('ctlValue').textContent = ctl;
    document.getElementById('atlValue').textContent = atl;
    document.getElementById('tsbValue').textContent = tsb;
    document.getElementById('currentForm').textContent = form;

    updateWeeklySummary();
}

// Mettre à jour le résumé hebdomadaire
function updateWeeklySummary() {
    const today = new Date();
    const lastWeek = new Date(today);
    lastWeek.setDate(today.getDate() - 7);

    let weeklyHours = 0;
    let weeklySessions = 0;
    let weeklyTSS = 0;

    Object.keys(userProgress).forEach(date => {
        const sessionDate = new Date(date);
        if (sessionDate >= lastWeek && sessionDate <= today && userProgress[date].completed) {
            const session = trainingProgramData.sessions[date];
            const duration = (userProgress[date].actualDuration || session.duration_minutes || 0) / 60;
            weeklyHours += duration;
            weeklySessions++;
            weeklyTSS += userProgress[date].tss || calculateTSS(session, userProgress[date]);
        }
    });

    document.getElementById('weeklyHours').textContent = weeklyHours.toFixed(1);
    document.getElementById('weeklySessions').textContent = weeklySessions;
    document.getElementById('weeklyTSS').textContent = weeklyTSS;
}

// Basculer l'affichage des phases
function togglePhase(phaseId) {
    const phaseDetails = document.getElementById(phaseId + 'Details');
    const icon = document.querySelector(`#${phaseId.replace('phase', 'phaseCard')} .phase-icon`);
    const isVisible = phaseDetails.style.display === 'block';

    document.querySelectorAll('.phase-details').forEach(detail => {
        detail.style.display = 'none';
    });
    document.querySelectorAll('.phase-icon').forEach(ic => {
        ic.textContent = '▼';
    });

    if (!isVisible) {
        phaseDetails.style.display = 'block';
        icon.textContent = '▲';
    }
}

/* ========================================
   FONCTIONS DE GESTION DES GRAPHIQUES
   ======================================== */

// Basculer l'affichage des graphiques
function showChart(chartType, tabElement) {
    document.querySelectorAll('.chart-content').forEach(content => {
        content.classList.remove('active');
    });

    document.querySelectorAll('.chart-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    document.getElementById(chartType + 'Chart').classList.add('active');

    if (tabElement) {
        tabElement.classList.add('active');
    } else {
        const tabs = document.querySelectorAll('.chart-tab');
        tabs.forEach(tab => {
            if (tab.getAttribute('onclick') && tab.getAttribute('onclick').includes(chartType)) {
                tab.classList.add('active');
            }
        });
    }

    setTimeout(() => {
        if (chartType === 'hours' && !yearlyProgressChartInstance) {
            initHoursChart();
        } else if (chartType === 'heartRate' && !heartRateChartInstance) {
            initHeartRateChart();
        } else if (chartType === 'zones' && !zonesChartInstance) {
            initZonesChart();
        } else if (chartType === 'phase' && !phaseChartInstance) {
            initPhaseChart();
        } else if (chartType === 'performance' && !performanceChartInstance) {
            initPerformanceChart();
        } else if (chartType === 'monthlyStats' && !monthlyStatsChartInstance) {
            initMonthlyStatsChart();
        }
    }, 100);
}

// Mettre à jour les graphiques
function updateCharts() {
    // Les graphiques sont initialisés à la demande
}

// Mettre à jour le graphique de type de sessions
function updateSessionTypeChart(longSessions, intenseSessions) {
    const ctx = document.getElementById('sessionTypeChart');
    if (!ctx) return;

    // Vérifier si Chart.js est disponible
    if (typeof Chart === 'undefined') {
        console.warn("⚠️ Chart.js non disponible - Graphique ignoré");
        return;
    }

    if (sessionTypeChartInstance) {
        sessionTypeChartInstance.destroy();
    }

    sessionTypeChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Longues (≥2h)', 'Intenses'],
            datasets: [{
                data: [longSessions, intenseSessions],
                backgroundColor: [
                    '#4CAF50',
                    '#F44336'
                ],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        boxWidth: 12,
                        font: {
                            size: 10
                        }
                    }
                }
            }
        }
    });
}

// Graphique des heures d'entraînement mensuelles
function initHoursChart() {
    const ctx = document.getElementById('yearlyProgressChart');
    if (!ctx) return;

    if (yearlyProgressChartInstance) {
        yearlyProgressChartInstance.destroy();
    }

    const monthlyHours = [];
    const months = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

    months.forEach(month => {
        let totalHours = 0;
        for (const [date, session] of Object.entries(trainingProgramData.sessions)) {
            if (date.substring(0, 7) === month) {
                totalHours += (session.duration_minutes || 0) / 60;
            }
        }
        monthlyHours.push(Math.round(totalHours));
    });

    yearlyProgressChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Sep 25', 'Oct 25', 'Nov 25', 'Déc 25', 'Jan 26', 'Fév 26', 'Mar 26', 'Avr 26', 'Mai 26', 'Jun 26', 'Jul 26', 'Aoû 26'],
            datasets: [{
                label: 'Heures d\'entraînement mensuelles',
                data: monthlyHours,
                borderColor: '#4CAF50',
                backgroundColor: 'rgba(76, 175, 80, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#4CAF50',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Évolution annuelle des heures d\'entraînement',
                    font: { size: 16, weight: 'bold' }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Heures d\'entraînement'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Mois'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                }
            }
        }
    });
}

// Graphique de la fréquence cardiaque moyenne mensuelle
function initHeartRateChart() {
    const ctx = document.getElementById('heartRateChartCanvas');
    if (!ctx) return;

    if (heartRateChartInstance) {
        heartRateChartInstance.destroy();
    }

    const monthlyHeartRate = [];
    const months = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

    months.forEach(month => {
        let totalHeartRate = 0;
        let count = 0;

        for (const [date, session] of Object.entries(trainingProgramData.sessions)) {
            if (date.substring(0, 7) === month && session.heart_rate_zone && session.heart_rate_zone !== 'N/A') {
                const match = session.heart_rate_zone.match(/(\d+)-(\d+)%/);
                if (match) {
                    const min = parseInt(match[1]);
                    const max = parseInt(match[2]);
                    const avg = (min + max) / 2;
                    totalHeartRate += avg;
                    count++;
                }
            }
        }

        const avgHeartRate = count > 0 ? Math.round(totalHeartRate / count) : 0;
        monthlyHeartRate.push(avgHeartRate);
    });

    heartRateChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Sep 25', 'Oct 25', 'Nov 25', 'Déc 25', 'Jan 26', 'Fév 26', 'Mar 26', 'Avr 26', 'Mai 26', 'Jun 26', 'Jul 26', 'Aoû 26'],
            datasets: [{
                label: 'Fréquence cardiaque moyenne (% FC max)',
                data: monthlyHeartRate,
                borderColor: '#F44336',
                backgroundColor: 'rgba(244, 67, 54, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointBackgroundColor: '#F44336',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Évolution mensuelle de la fréquence cardiaque moyenne',
                    font: { size: 16, weight: 'bold' }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    title: {
                        display: true,
                        text: 'Fréquence cardiaque (% FC max)'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Mois'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                }
            }
        }
    });
}

// Graphique de répartition des zones d'entraînement
function initZonesChart() {
    const ctx = document.getElementById('zonesChartCanvas');
    if (!ctx) return;

    if (zonesChartInstance) {
        zonesChartInstance.destroy();
    }

    const zoneHours = {
        'Z1': 0,
        'Z2': 0,
        'Z3': 0,
        'Z4': 0,
        'Z5': 0
    };

    Object.values(trainingProgramData.sessions).forEach(session => {
        if (session.heart_rate_zone && session.heart_rate_zone !== 'N/A') {
            const match = session.heart_rate_zone.match(/(\d+)-(\d+)%/);
            if (match) {
                const min = parseInt(match[1]);
                const max = parseInt(match[2]);
                const avg = (min + max) / 2;
                const hours = (session.duration_minutes || 0) / 60;

                if (avg >= 90) zoneHours.Z5 += hours;
                else if (avg >= 80) zoneHours.Z4 += hours;
                else if (avg >= 70) zoneHours.Z3 += hours;
                else if (avg >= 60) zoneHours.Z2 += hours;
                else zoneHours.Z1 += hours;
            }
        }
    });

    zonesChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: [
                'Z1: Récupération active (50-60%)',
                'Z2: Endurance fondamentale (60-70%)',
                'Z3: Endurance aérobie (70-80%)',
                'Z4: Seuil lactique (80-90%)',
                'Z5: Capacité maximale (90-100%)'
            ],
            datasets: [{
                data: [
                    zoneHours.Z1,
                    zoneHours.Z2,
                    zoneHours.Z3,
                    zoneHours.Z4,
                    zoneHours.Z5
                ],
                backgroundColor: [
                    '#4CAF50',
                    '#8BC34A',
                    '#CDDC39',
                    '#FFC107',
                    '#F44336'
                ],
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Répartition des zones d\'entraînement par fréquence cardiaque',
                    font: { size: 16, weight: 'bold' }
                },
                legend: {
                    position: 'right'
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const label = context.label || '';
                            const value = context.raw || 0;
                            return `${label}: ${value.toFixed(1)} heures`;
                        }
                    }
                }
            }
        }
    });
}

// Graphique d'analyse des phases
function initPhaseChart() {
    const ctx = document.getElementById('phaseChartCanvas');
    if (!ctx) return;

    if (phaseChartInstance) {
        phaseChartInstance.destroy();
    }

    const phaseData = {
        'Fondamentale 1': { hours: 0, avgHeartRate: 0, count: 0 },
        'Fondamentale 2': { hours: 0, avgHeartRate: 0, count: 0 },
        'Construction': { hours: 0, avgHeartRate: 0, count: 0 },
        'Pic': { hours: 0, avgHeartRate: 0, count: 0 },
        'Compétition': { hours: 0, avgHeartRate: 0, count: 0 },
        'Récupération': { hours: 0, avgHeartRate: 0, count: 0 }
    };

    Object.entries(trainingProgramData.sessions).forEach(([date, session]) => {
        const month = date.substring(5, 7);
        const year = date.substring(0, 4);

        let phase = '';
        if (year === '2025' && (month === '09' || month === '10')) phase = 'Fondamentale 1';
        else if (year === '2025' && (month === '11' || month === '12')) phase = 'Fondamentale 2';
        else if (year === '2026' && (month === '01' || month === '02')) phase = 'Construction';
        else if (year === '2026' && (month === '03' || month === '04')) phase = 'Pic';
        else if (year === '2026' && (month === '05' || month === '06')) phase = 'Compétition';
        else if (year === '2026' && (month === '07' || month === '08')) phase = 'Récupération';

        if (phase && phaseData[phase]) {
            phaseData[phase].hours += (session.duration_minutes || 0) / 60;

            if (session.heart_rate_zone && session.heart_rate_zone !== 'N/A') {
                const match = session.heart_rate_zone.match(/(\d+)-(\d+)%/);
                if (match) {
                    const min = parseInt(match[1]);
                    const max = parseInt(match[2]);
                    const avg = (min + max) / 2;
                    phaseData[phase].avgHeartRate += avg;
                    phaseData[phase].count++;
                }
            }
        }
    });

    Object.keys(phaseData).forEach(phase => {
        if (phaseData[phase].count > 0) {
            phaseData[phase].avgHeartRate = Math.round(phaseData[phase].avgHeartRate / phaseData[phase].count);
        } else {
            phaseData[phase].avgHeartRate = 0;
        }
    });

    phaseChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Fondamentale 1', 'Fondamentale 2', 'Construction', 'Pic', 'Compétition', 'Récupération'],
            datasets: [
                {
                    label: 'Heures d\'entraînement',
                    data: [
                        phaseData['Fondamentale 1'].hours,
                        phaseData['Fondamentale 2'].hours,
                        phaseData['Construction'].hours,
                        phaseData['Pic'].hours,
                        phaseData['Compétition'].hours,
                        phaseData['Récupération'].hours
                    ],
                    backgroundColor: 'rgba(76, 175, 80, 0.7)',
                    borderColor: '#4CAF50',
                    borderWidth: 1,
                    yAxisID: 'y'
                },
                {
                    label: 'Fréquence cardiaque moyenne (%)',
                    data: [
                        phaseData['Fondamentale 1'].avgHeartRate,
                        phaseData['Fondamentale 2'].avgHeartRate,
                        phaseData['Construction'].avgHeartRate,
                        phaseData['Pic'].avgHeartRate,
                        phaseData['Compétition'].avgHeartRate,
                        phaseData['Récupération'].avgHeartRate
                    ],
                    type: 'line',
                    borderColor: '#F44336',
                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                    borderWidth: 3,
                    pointBackgroundColor: '#F44336',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointRadius: 6,
                    fill: false,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Analyse des phases d\'entraînement',
                    font: { size: 16, weight: 'bold' }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Heures d\'entraînement'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                },
                y1: {
                    beginAtZero: true,
                    max: 100,
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Fréquence cardiaque moyenne (%)'
                    },
                    grid: {
                        display: false
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Phases d\'entraînement'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                }
            }
        }
    });
}

// Graphique des indicateurs de performance
function initPerformanceChart() {
    const ctx = document.getElementById('performanceChartCanvas');
    if (!ctx) return;

    if (performanceChartInstance) {
        performanceChartInstance.destroy();
    }

    const days = 30;
    const labels = [];
    const ctlData = [];
    const atlData = [];
    const tsbData = [];

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        labels.push(date.getDate() + '/' + (date.getMonth() + 1));

        const dateStr = date.toISOString().split('T')[0];
        const completedDates = Object.keys(userProgress)
            .filter(d => userProgress[d].completed && d <= dateStr)
            .sort();

        let ctl = 0;
        let atl = 0;

        completedDates.slice(-42).forEach(d => {
            const session = trainingProgramData.sessions[d];
            const tss = userProgress[d].tss || calculateTSS(session, userProgress[d]);
            ctl = (ctl * 0.85) + (tss * 0.15);
        });

        completedDates.slice(-7).forEach(d => {
            const session = trainingProgramData.sessions[d];
            const tss = userProgress[d].tss || calculateTSS(session, userProgress[d]);
            atl = (atl * 0.58) + (tss * 0.42);
        });

        ctlData.push(Math.round(ctl));
        atlData.push(Math.round(atl));
        tsbData.push(Math.round(ctl - atl));
    }

    performanceChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'CTL (Charge chronique)',
                    data: ctlData,
                    borderColor: '#4CAF50',
                    backgroundColor: 'rgba(76, 175, 80, 0.1)',
                    borderWidth: 3,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3
                },
                {
                    label: 'ATL (Charge aiguë)',
                    data: atlData,
                    borderColor: '#F44336',
                    backgroundColor: 'rgba(244, 67, 54, 0.1)',
                    borderWidth: 3,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3
                },
                {
                    label: 'TSB (Équilibre d\'entraînement)',
                    data: tsbData,
                    borderColor: '#2196F3',
                    backgroundColor: 'rgba(33, 150, 243, 0.1)',
                    borderWidth: 3,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Indicateurs de performance pour les 30 derniers jours',
                    font: { size: 16, weight: 'bold' }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    title: {
                        display: true,
                        text: 'Valeur de l\'indicateur'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Date'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                }
            }
        }
    });
}

// Graphique des statistiques mensuelles
function initMonthlyStatsChart() {
    const ctx = document.getElementById('monthlyStatsChartCanvas');
    if (!ctx) return;

    if (monthlyStatsChartInstance) {
        monthlyStatsChartInstance.destroy();
    }

    const months = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
    const labels = ['Sep 25', 'Oct 25', 'Nov 25', 'Déc 25', 'Jan 26', 'Fév 26', 'Mar 26', 'Avr 26', 'Mai 26', 'Jun 26', 'Jul 26', 'Aoû 26'];

    const distanceData = [];
    const caloriesData = [];
    const activeDaysData = [];

    months.forEach(month => {
        if (monthlyStats[month]) {
            distanceData.push(monthlyStats[month].distance);
            caloriesData.push(monthlyStats[month].calories);
            activeDaysData.push(monthlyStats[month].activeDays);
        } else {
            distanceData.push(0);
            caloriesData.push(0);
            activeDaysData.push(0);
        }
    });

    monthlyStatsChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Distance parcourue (km)',
                    data: distanceData,
                    backgroundColor: 'rgba(76, 175, 80, 0.7)',
                    borderColor: '#4CAF50',
                    borderWidth: 1,
                    yAxisID: 'y'
                },
                {
                    label: 'Calories brûlées (kcal)',
                    data: caloriesData,
                    backgroundColor: 'rgba(244, 67, 54, 0.7)',
                    borderColor: '#F44336',
                    borderWidth: 1,
                    yAxisID: 'y1'
                },
                {
                    label: 'Jours actifs',
                    data: activeDaysData,
                    type: 'line',
                    borderColor: '#2196F3',
                    backgroundColor: 'rgba(33, 150, 243, 0.1)',
                    borderWidth: 3,
                    pointBackgroundColor: '#2196F3',
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointRadius: 6,
                    fill: false,
                    yAxisID: 'y2'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: 'Évolution des statistiques mensuelles',
                    font: { size: 16, weight: 'bold' }
                },
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: 'Distance (km)'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                },
                y1: {
                    beginAtZero: true,
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Calories (kcal)'
                    },
                    grid: {
                        display: false
                    }
                },
                y2: {
                    beginAtZero: true,
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Jours actifs'
                    },
                    grid: {
                        display: false
                    },
                    offset: true
                },
                x: {
                    title: {
                        display: true,
                        text: 'Mois'
                    },
                    grid: {
                        color: 'rgba(0,0,0,0.1)'
                    }
                }
            }
        }
    });
}

/* ========================================
   FONCTIONS DE GESTION DES FICHIERS (FIT/GPX/TCX)
   ======================================== */

// Initialiser la carte
function initializeMap() {
    if (fitMapReady) return;
    const mapContainer = document.getElementById('fitMap');
    if (!mapContainer) return;

    fitMap = new maplibregl.Map({
        container: 'fitMap',
        style: 'https://api.maptiler.com/maps/streets-v2/style.json?key=DBpqQ6T5hG4BtWFxxUMr',
        center: [2.3488, 48.8534],
        zoom: 11,
        attributionControl: true
    });

    fitMap.addControl(new maplibregl.NavigationControl(), 'top-right');
    fitMap.on('load', () => {
        fitMapReady = true;
    });
}

// Mettre à jour la carte avec une trace
function updateMapWithTrack(geojson, meta = {}) {
    if (!fitMapReady || !fitMap) {
        console.warn("Carte non prête : impossible d'afficher la trace.");
        return;
    }

    if (fitMap.getSource(fitRouteSourceId)) {
        fitMap.getSource(fitRouteSourceId).setData(geojson);
    } else {
        fitMap.addSource(fitRouteSourceId, {
            type: 'geojson',
            data: geojson
        });
    }

    if (!fitMap.getLayer(fitRouteLayerId)) {
        fitMap.addLayer({
            id: fitRouteLayerId,
            type: 'line',
            source: fitRouteSourceId,
            layout: {
                'line-cap': 'round',
                'line-join': 'round'
            },
            paint: {
                'line-color': '#ff6600',
                'line-width': 4,
                'line-opacity': 0.9
            }
        });
    }

    const coords = geojson.features?.[0]?.geometry?.coordinates || [];
    if (coords.length >= 2) {
        const bounds = coords.reduce(
            (b, coord) => b.extend(coord),
            new maplibregl.LngLatBounds(coords[0], coords[0])
        );
        fitMap.fitBounds(bounds, { padding: 40, maxZoom: 15 });
    }

    const statsBox = document.getElementById('mapStats');
    if (statsBox) {
        statsBox.style.display = 'grid';
        document.getElementById('mapDistance').textContent = `${(meta.distanceKm || 0).toFixed(1)} km`;
        document.getElementById('mapDuration').textContent = formatDurationForMap(meta.durationMin || 0);
        document.getElementById('mapSpeed').textContent = meta.speedKmH ? `${meta.speedKmH.toFixed(1)} km/h` : '—';
        document.getElementById('mapHeartRate').textContent = meta.avgHr ? `${Math.round(meta.avgHr)} bpm` : '—';
    }

    currentRouteCoordinates = coords;
    currentRouteMetadata = {
        ...meta,
        source: meta.source || "manual",
        filename: meta.filename || "Manuel"
    };
}

// Gérer un fichier de carte
function handleMapFile(file) {
    const name = file.name.toLowerCase();

    if (name.endsWith('.fit')) {
        parseFIT(file, { updateMap: true, fileName: file.name });
    } else if (name.endsWith('.gpx')) {
        file.text().then(text => parseGPX(text, file.name, true));
    } else if (name.endsWith('.tcx')) {
        file.text().then(text => parseTCX(text, file.name, true));
    } else {
        alert('Format non pris en charge. Utilisez un fichier FIT, GPX ou TCX.');
    }
}

// Parser FIT
async function parseFIT(file, options = {}) {
    if (typeof FitParser === 'undefined') {
        throw new Error('Lib FIT non chargée. Ajoutez le script fit-file-parser.');
    }
    const arrayBuffer = await file.arrayBuffer();
    const fitParser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'm',
        elapsedRecordField: true
    });
    await new Promise((resolve, reject) => {
        fitParser.parse(arrayBuffer, (error, data) => {
            if (error) return reject(error);
            const session = (data?.sessions && data.sessions[0]) || null;
            const records = data?.records || [];
            let start = session?.start_time || records[0]?.timestamp;
            if (!start && data?.activity?.timestamp) start = data.activity.timestamp;
            if (!start) return reject(new Error('Impossible de déterminer la date de début'));
            const startDate = (start instanceof Date) ? start : new Date(start);
            const dateStr = new Date(
                startDate.getFullYear(),
                startDate.getMonth(),
                startDate.getDate()
            ).toISOString().slice(0, 10);

            let durationMin = 0;
            if (session?.total_timer_time !== undefined && session.total_timer_time !== null) {
                durationMin = normalizeDurationToMinutes(session.total_timer_time);
            } else if (records.length > 1) {
                const t0 = new Date(records[0].timestamp).getTime();
                const t1 = new Date(records[records.length - 1].timestamp).getTime();
                durationMin = Math.round(Math.abs(t1 - t0) / 60000);
            }

            let distanceKm = 0;
            if (session?.total_distance) {
                const rawDistance = session.total_distance;
                if (rawDistance > 1000000) {
                    distanceKm = rawDistance / 1000000;
                } else if (rawDistance > 1000) {
                    distanceKm = rawDistance / 1000;
                } else {
                    distanceKm = rawDistance;
                }
                distanceKm = Math.min(Math.max(distanceKm, 0), 500);
            } else if (records.length) {
                const lastDist = records[records.length - 1]?.distance || 0;
                if (lastDist > 1000000) {
                    distanceKm = lastDist / 1000000;
                } else if (lastDist > 1000) {
                    distanceKm = lastDist / 1000;
                } else {
                    distanceKm = lastDist;
                }
                distanceKm = Math.min(Math.max(distanceKm, 0), 500);
            }

            distanceKm = Math.max(0, Number(distanceKm.toFixed(2)));

            let avgHR = 0;
            if (session?.avg_heart_rate) {
                avgHR = Number(session.avg_heart_rate);
            } else if (records.length) {
                const hrs = records.map(r => r.heart_rate).filter(Boolean).map(Number);
                if (hrs.length) avgHR = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
            }

            let coordinates = [];
            if (records.length) {
                coordinates = records
                    .map(r => {
                        const lat = normalizeCoord(r.position_lat, true);
                        const lon = normalizeCoord(r.position_long, false);
                        return (lat !== null && lon !== null) ? [lon, lat] : null;
                    })
                    .filter(Boolean);
            }

            if (coordinates.length > 1 && options.updateMap) {
                const geojson = buildGeoJSONFromCoordinates(coordinates);
                const durationHours = durationMin ? durationMin / 60 : 0;
                const speed = durationHours > 0 ? distanceKm / durationHours : null;

                updateMapWithTrack(geojson, {
                    distanceKm,
                    durationMin,
                    speedKmH: speed,
                    avgHr: avgHR
                });
            }

            if (!userProgress[dateStr]) userProgress[dateStr] = {};
            const up = userProgress[dateStr];
            up.completed = true;
            up.completedAt = new Date().toISOString();
            up.actualDuration = Math.max(up.actualDuration || 0, durationMin);
            up.distance = Math.max(parseFloat(up.distance || 0), distanceKm);
            if (avgHR > 0) up.actualHeartRate = String(avgHR);

            const maxHR = trainingProgramData?.program_info?.cyclist_profile?.max_heart_rate || 170;
            const avgPct = avgHR > 0 ? Math.round((avgHR / maxHR) * 100) : 0;
            const planned = trainingProgramData.sessions[dateStr];
            const sessionForTSS = planned || {
                intensity: estimateIntensityFromHR(avgPct),
                duration_minutes: up.actualDuration
            };
            up.tss = calculateTSS(sessionForTSS, up);

            if (!brytonActivities[dateStr]) {
                brytonActivities[dateStr] = [];
            }

            // Construire la série temps/distance/altitude à partir des records
            const timeSeries = records.map(rec => {
                const lat = normalizeCoord(rec.position_lat, true);
                const lon = normalizeCoord(rec.position_long, false);

                return {
                    time: rec.elapsed_time ?? 0,
                    distance: rec.distance_m ?? 0,
                    altitude: rec.altitude_m ?? null,
                    speed: rec.speed_mps ?? null,
                    heartRate: rec.heart_rate ?? null,
                    lat,
                    lon
                };
            });

            let elevationGain = 0;
            if (session?.total_ascent) {
                elevationGain = session.total_ascent;
            } else {
                for (let i = 1; i < timeSeries.length; i++) {
                    const diff = (timeSeries[i].altitude ?? 0) - (timeSeries[i - 1].altitude ?? 0);
                    if (diff > 0) elevationGain += diff;
                }
            }

            brytonActivities[dateStr].push({
                importTime: new Date().toISOString(),
                filename: file.name,
                duration: durationMin,
                distance: distanceKm,
                heartRate: avgHR,
                cadence: session?.avg_cadence ?? null,
                power: session?.avg_power ?? null,
                elevationGain: Math.round(elevationGain),
                coordinates,
                timeSeries
            });
            
            saveAllDataToLocalStorage();
            scheduleRemoteSave();
            resolve();
        });
    });
}

// Parser GPX
function parseGPX(text, fileName = 'Import GPX', updateMap = false) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const trkpts = Array.from(xml.getElementsByTagName('trkpt'));
    const timeNodes = Array.from(xml.getElementsByTagName('time'));
    if (!timeNodes.length) throw new Error('GPX sans time');
    const t0 = new Date(timeNodes[0].textContent.trim());
    const t1 = new Date(timeNodes[timeNodes.length - 1].textContent.trim());
    const durationMin = toMinutes(t1 - t0);

    let distanceKm = 0;
    const distNodes = Array.from(xml.getElementsByTagName('DistanceMeters'));
    const coords = [];

    if (distNodes.length) {
        distanceKm = parseFloat(distNodes[distNodes.length - 1].textContent) / 1000;
    } else if (trkpts.length > 1) {
        distanceKm = 0;
        for (let i = 1; i < trkpts.length; i++) {
            const lat1 = parseFloat(trkpts[i - 1].getAttribute('lat'));
            const lon1 = parseFloat(trkpts[i - 1].getAttribute('lon'));
            const lat2 = parseFloat(trkpts[i].getAttribute('lat'));
            const lon2 = parseFloat(trkpts[i].getAttribute('lon'));

            if (isFinite(lat1) && isFinite(lon1)) {
                coords.push([lon1, lat1]);
            }
            if (i === trkpts.length - 1 && isFinite(lat2) && isFinite(lon2)) {
                coords.push([lon2, lat2]);
            }

            if (isFinite(lat1) && isFinite(lon1) && isFinite(lat2) && isFinite(lon2)) {
                distanceKm += haversineKm(lat1, lon1, lat2, lon2);
            }
        }
    }

    distanceKm = Number((distanceKm || 0).toFixed(2));

    const hrNodes = Array.from(xml.getElementsByTagNameNS('*', 'hr'));
    let avgHR = 0;
    if (hrNodes.length) {
        const hrs = hrNodes.map(n => parseInt(n.textContent, 10)).filter(Boolean);
        if (hrs.length) avgHR = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
    }

    if (updateMap && coords.length > 1) {
        const geojson = buildGeoJSONFromCoordinates(coords);
        const durationHours = durationMin ? durationMin / 60 : 0;
        const speed = durationHours > 0 ? distanceKm / durationHours : null;

        updateMapWithTrack(geojson, {
            distanceKm,
            durationMin,
            speedKmH: speed,
            avgHr: avgHR
        });
    }

    const dateStr = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate()).toISOString().slice(0, 10);
    if (!userProgress[dateStr]) userProgress[dateStr] = {};
    const up = userProgress[dateStr];
    up.completed = true;
    up.completedAt = new Date().toISOString();
    up.actualDuration = Math.max(up.actualDuration || 0, durationMin);
    up.distance = Math.max(parseFloat(up.distance || 0), distanceKm);
    if (avgHR > 0) up.actualHeartRate = String(avgHR);

    const maxHR = trainingProgramData?.program_info?.cyclist_profile?.max_heart_rate || 170;
    const avgPct = avgHR > 0 ? Math.round((avgHR / maxHR) * 100) : 0;
    const planned = trainingProgramData.sessions[dateStr];
    const sessionForTSS = planned || {
        intensity: estimateIntensityFromHR(avgPct),
        duration_minutes: up.actualDuration
    };
    up.tss = calculateTSS(sessionForTSS, up);

    if (!brytonActivities[dateStr]) {
        brytonActivities[dateStr] = [];
    }

    // Construit la série temps/distance/altitude à partir des trkpt
    const timeSeries = [];
    let cumulativeDistance = 0;

    trkpts.forEach((pt, index) => {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));
        const eleNode = pt.getElementsByTagName('ele')[0]?.textContent;
        const timeNode = pt.getElementsByTagName('time')[0]?.textContent;

        if (index > 0) {
            const prevLat = timeSeries[index - 1]?.lat;
            const prevLon = timeSeries[index - 1]?.lon;
            if (Number.isFinite(prevLat) && Number.isFinite(prevLon) && Number.isFinite(lat) && Number.isFinite(lon)) {
                cumulativeDistance += haversineKm(prevLat, prevLon, lat, lon) * 1000;
            }
        }

        timeSeries.push({
            time: timeNode ? (new Date(timeNode).getTime() - t0.getTime()) / 1000 : index,
            distance: cumulativeDistance,
            altitude: eleNode ? parseFloat(eleNode) : null,
            speed: null,
            heartRate: hrNodes[index] ? parseInt(hrNodes[index].textContent, 10) : null,
            lat,
            lon
        });
    });

    // Calcul du dénivelé
    let elevationGain = 0;
    for (let i = 1; i < timeSeries.length; i++) {
        const diff = (timeSeries[i].altitude ?? 0) - (timeSeries[i - 1].altitude ?? 0);
        if (diff > 0) elevationGain += diff;
    }

    brytonActivities[dateStr].push({
        importTime: new Date().toISOString(),
        filename: fileName,
        duration: durationMin,
        distance: distanceKm,
        heartRate: avgHR,
        elevationGain: Math.round(elevationGain),
        coordinates: coords,
        timeSeries
    });
    
    saveAllDataToLocalStorage();
    scheduleRemoteSave();
}

// Parser TCX
function parseTCX(text, fileName = 'Import TCX', updateMap = false) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const laps = Array.from(xml.getElementsByTagName('Lap'));
    if (!laps.length) throw new Error('TCX sans Lap');

    let start = null;
    let end = null;
    let distanceMeters = 0;
    let hrSum = 0;
    let hrCount = 0;
    const coords = [];

    const trackpoints = Array.from(xml.getElementsByTagName('Trackpoint'));
    if (trackpoints.length) {
        const t0 = trackpoints[0].getElementsByTagName('Time')[0]?.textContent;
        const t1 = trackpoints[trackpoints.length - 1].getElementsByTagName('Time')[0]?.textContent;
        if (t0) start = new Date(t0);
        if (t1) end = new Date(t1);

        trackpoints.forEach(tp => {
            const pos = tp.getElementsByTagName('Position')[0];
            if (pos) {
                const lat = parseFloat(pos.getElementsByTagName('LatitudeDegrees')[0]?.textContent);
                const lon = parseFloat(pos.getElementsByTagName('LongitudeDegrees')[0]?.textContent);
                if (isFinite(lat) && isFinite(lon)) {
                    coords.push([lon, lat]);
                }
            }

            const hr = tp.getElementsByTagName('HeartRateBpm')[0]?.getElementsByTagName('Value')[0]?.textContent;
            if (hr) { hrSum += parseInt(hr, 10); hrCount++; }
        });
    } else {
        const t0 = laps[0].getAttribute('StartTime');
        start = t0 ? new Date(t0) : null;
        const t1 = laps[laps.length - 1].getAttribute('StartTime');
        end = t1 ? new Date(t1) : null;
    }

    laps.forEach(lap => {
        const dist = lap.getElementsByTagName('DistanceMeters')[0]?.textContent;
        if (dist) distanceMeters += parseFloat(dist);
    });

    const durationMin = start && end ? toMinutes(end - start) : toMinutes(
        laps.map(l => parseFloat(l.getElementsByTagName('TotalTimeSeconds')[0]?.textContent || '0'))
            .reduce((a, b) => a + b, 0)
    );

    const distanceKm = Number(((distanceMeters || 0) / 1000).toFixed(2));
    const avgHR = hrCount ? Math.round(hrSum / hrCount) : 0;

    if (updateMap && coords.length > 1) {
        const geojson = buildGeoJSONFromCoordinates(coords);
        const durationHours = durationMin ? durationMin / 60 : 0;
        const speed = durationHours > 0 ? distanceKm / durationHours : null;

        updateMapWithTrack(geojson, {
            distanceKm,
            durationMin,
            speedKmH: speed,
            avgHr: avgHR
        });
    }

    const dateStr = new Date(start.getFullYear(), start.getMonth(), start.getDate()).toISOString().slice(0, 10);
    if (!userProgress[dateStr]) userProgress[dateStr] = {};
    const up = userProgress[dateStr];
    up.completed = true;
    up.completedAt = new Date().toISOString();
    up.actualDuration = Math.max(up.actualDuration || 0, durationMin);
    up.distance = Math.max(parseFloat(up.distance || 0), distanceKm);
    if (avgHR > 0) up.actualHeartRate = String(avgHR);

    const maxHR = trainingProgramData?.program_info?.cyclist_profile?.max_heart_rate || 170;
    const avgPct = avgHR > 0 ? Math.round((avgHR / maxHR) * 100) : 0;
    const planned = trainingProgramData.sessions[dateStr];
    const sessionForTSS = planned || {
        intensity: estimateIntensityFromHR(avgPct),
        duration_minutes: up.actualDuration
    };
    up.tss = calculateTSS(sessionForTSS, up);

    if (!brytonActivities[dateStr]) {
        brytonActivities[dateStr] = [];
    }

    // Construire la série temps/distance/altitude à partir des trackpoints
    const timeSeries = [];
    let cumulativeDistance = 0;

    trackpoints.forEach((tp, index) => {
        const timeNode = tp.getElementsByTagName('Time')[0]?.textContent;
        const distanceNode = tp.getElementsByTagName('DistanceMeters')[0]?.textContent;
        const altitudeNode = tp.getElementsByTagName('AltitudeMeters')[0]?.textContent;
        const hrNode = tp.getElementsByTagName('HeartRateBpm')[0]?.getElementsByTagName('Value')[0]?.textContent;
        const positionNode = tp.getElementsByTagName('Position')[0];
        const latNode = positionNode?.getElementsByTagName('LatitudeDegrees')[0]?.textContent;
        const lonNode = positionNode?.getElementsByTagName('LongitudeDegrees')[0]?.textContent;

        const lat = latNode ? parseFloat(latNode) : null;
        const lon = lonNode ? parseFloat(lonNode) : null;

        if (distanceNode) {
            cumulativeDistance = parseFloat(distanceNode);
        } else if (index > 0 && Number.isFinite(lat) && Number.isFinite(lon)) {
            const prev = timeSeries[index - 1];
            if (Number.isFinite(prev.lat) && Number.isFinite(prev.lon)) {
                cumulativeDistance += haversineKm(prev.lat, prev.lon, lat, lon) * 1000;
            }
        }

        timeSeries.push({
            time: timeNode ? (new Date(timeNode).getTime() - start.getTime()) / 1000 : index,
            distance: cumulativeDistance,
            altitude: altitudeNode ? parseFloat(altitudeNode) : null,
            speed: null,
            heartRate: hrNode ? parseInt(hrNode, 10) : null,
            lat,
            lon
        });
    });

    // Calcul du dénivelé
    let elevationGain = 0;
    for (let i = 1; i < timeSeries.length; i++) {
        const diff = (timeSeries[i].altitude ?? 0) - (timeSeries[i - 1].altitude ?? 0);
        if (diff > 0) elevationGain += diff;
    }

    brytonActivities[dateStr].push({
        importTime: new Date().toISOString(),
        filename: fileName,
        duration: durationMin,
        distance: distanceKm,
        heartRate: avgHR,
        elevationGain: Math.round(elevationGain),
        coordinates: coords,
        timeSeries
    });
    
    saveAllDataToLocalStorage();
    scheduleRemoteSave();
}

// Importer un fichier d'entraînement
function importWorkoutFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.fit,.FIT,.gpx,.GPX,.tcx,.TCX';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const name = file.name.toLowerCase();
            if (name.endsWith('.fit')) {
                await parseFIT(file, { updateMap: true });
            } else if (name.endsWith('.gpx')) {
                const text = await file.text();
                parseGPX(text, file.name, true);
            } else if (name.endsWith('.tcx')) {
                const text = await file.text();
                parseTCX(text, file.name, true);
            } else {
                alert('Format non pris en charge. Utilisez un .fit, .gpx ou .tcx');
                return;
            }

            saveAllDataToLocalStorage();
            scheduleRemoteSave();
            updateMonthlyPlan();
            updateBrytonActivities();

            alert('✅ Activité importée avec succès !');
        } catch (err) {
            console.error(err);
            alert('❌ Erreur lors de l\'import. Voir la console.');
        }
    };
    input.click();
}

// Réinitialiser complètement toutes les données
function resetAllData() {
    const confirmation = confirm(
        "⚠️ ATTENTION : Cette action va supprimer TOUTES vos données !\n\n" +
        "Sera supprimé :\n" +
        "• Programme d'entraînement complet\n" +
        "• Progression et statistiques\n" +
        "• Activités importées\n" +
        "• Parcours sauvegardés\n" +
        "• Données de performance\n\n" +
        "Cette action est IRRÉVERSIBLE !\n\n" +
        "Cliquez sur OK pour continuer, ou sur Annuler pour annuler."
    );

    if (!confirmation) {
        console.log("🛑 Réinitialisation annulée par l'utilisateur");
        return;
    }

    try {
        console.log("🗑️ Réinitialisation complète des données...");

        // Vider toutes les données en mémoire
        trainingProgramData = {
            program_info: {},
            sessions: {}
        };

        userProgress = {};
        nutritionLog = {};
        performanceData = {};
        monthlyStats = {};
        brytonActivities = {};
        savedRoutes = [];

        // Effacer tout le localStorage
        const keysToRemove = [
            'trainingProgramData',
            'cyclingProgress',
            'nutritionLog',
            'performanceData',
            'monthlyStats',
            'brytonActivities',
            'savedRoutes',
            'dataVersion',
            'lastModified'
        ];

        keysToRemove.forEach(key => {
            localStorage.removeItem(key);
        });

        // Forcer le mode sans génération automatique
        localStorage.setItem('skipAutoGeneration', 'true');

        // Réinitialiser les variables Firebase
        currentUser = null;
        DATA_PATH = null;

        console.log("✅ Toutes les données ont été réinitialisées");

        // Forcer un rechargement de la page pour éviter les problèmes de cache
        alert("✅ Réinitialisation complète terminée !\n\nToutes vos données ont été effacées.\n\nLa page va se recharger pour appliquer les changements.");

        // Recharger la page après un court délai pour que l'alerte s'affiche
        setTimeout(() => {
            window.location.reload(true);
        }, 500);

    } catch (error) {
        console.error("❌ Erreur lors de la réinitialisation:", error);
        alert("❌ Une erreur est survenue lors de la réinitialisation.\nVérifiez la console pour plus de détails.");
    }
}

// Importer un programme d'entraînement depuis un fichier JSON
function importTrainingProgramJSON() {
    // Option de vidage du programme actuel
    const hasExistingData = Object.keys(trainingProgramData.sessions).length > 0;

    if (hasExistingData) {
        const clearFirst = confirm("🗑️ Voulez-vous d'abord vider le programme actuel ?\n\nCliquez sur OK pour vider d'abord, ou sur Annuler pour fusionner avec l'existant.");
        if (clearFirst) {
            trainingProgramData.sessions = {};
            console.log("🗑️ Programme actuel vidé");
            localStorage.setItem('skipAutoGeneration', 'true');
        }
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.JSON';
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            // Analyser la structure du JSON
            let sessions = null;
            let programInfo = null;

            // Format 1: { sessions: {...}, program_info: {...} }
            if (data.sessions && typeof data.sessions === 'object') {
                sessions = data.sessions;
                programInfo = data.program_info;
            }
            // Format 2: { trainingProgram: { sessions: {...}, program_info: {...} } }
            else if (data.trainingProgram?.sessions && typeof data.trainingProgram.sessions === 'object') {
                sessions = data.trainingProgram.sessions;
                programInfo = data.trainingProgram.program_info;
            }
            // Format 3: Direct sessions object
            else if (typeof data === 'object' && !data.sessions && !data.trainingProgram) {
                // On considère que l'objet contient directement les sessions
                sessions = data;
            }

            if (!sessions) {
                alert("❌ Le fichier JSON n'a pas un format reconnu.\n\nFormats acceptés :\n1. { sessions: {...}, program_info: {...} }\n2. { trainingProgram: { sessions: {...}, program_info: {...} } }\n3. { \"2025-12-01\": {...}, \"2025-12-02\": {...} }");
                return;
            }

            // Demander confirmation avant d'écraser les données existantes
            const sessionCount = Object.keys(sessions).length;
            const hasExistingData = Object.keys(trainingProgramData.sessions).length > 0;

            let confirmMessage = `📋 Fichier JSON détecté avec ${sessionCount} sessions.\n\n`;

            if (hasExistingData) {
                confirmMessage += `⚠️ ATTENTION : Vous avez déjà ${Object.keys(trainingProgramData.sessions).length} sessions dans votre programme.\n\n`;
                confirmMessage += `Que voulez-vous faire ?\n\n`;
                confirmMessage += `1. Remplacer tout le programme existant\n`;
                confirmMessage += `2. Fusionner (conserver l'existant, ajouter les nouvelles)\n`;
                confirmMessage += `3. Annuler`;

                const choice = confirm(confirmMessage + "\n\nCliquez sur OK pour remplacer, ou sur Annuler pour choisir.");
                if (!choice) {
                    // Fusionner
                    Object.entries(sessions).forEach(([dateStr, session]) => {
                        trainingProgramData.sessions[dateStr] = session;
                    });
                    console.log(`🔄 Fusion : ${sessionCount} sessions ajoutées`);
                } else {
                    // Remplacer
                    trainingProgramData.sessions = sessions;
                    console.log(`🔄 Remplacement : ${sessionCount} sessions importées`);
                }
            } else {
                confirmMessage += `✅ Ce programme sera importé comme programme principal.`;
                if (!confirm(confirmMessage)) {
                    return;
                }
                trainingProgramData.sessions = sessions;
            }

            // Importer les informations du programme si disponibles
            if (programInfo) {
                trainingProgramData.program_info = {
                    ...(trainingProgramData.program_info || {}),
                    ...programInfo,
                    cyclist_profile: {
                        ...(trainingProgramData.program_info?.cyclist_profile || {}),
                        ...(programInfo.cyclist_profile || {})
                    }
                };
                console.log("✅ Informations du programme importées");
            }

            // Sauvegarder et mettre à jour
            saveAllDataToLocalStorage();
            scheduleRemoteSave();
            updateMonthlyPlan();
            updateStats();

            // Supprimer le drapeau d'importation après un import réussi
            localStorage.removeItem('skipAutoGeneration');

            alert(`🎉 Programme importé avec succès !\n\n📅 ${sessionCount} sessions chargées\n💾 Données sauvegardées`);

        } catch (err) {
            console.error("Erreur lors de l'importation JSON:", err);
            alert(`❌ Erreur lors de l'importation JSON : ${err.message}\n\nVérifiez que votre fichier JSON est bien formaté.`);
        }
    };
    input.click();
}

// Mettre à jour les activités Bryton avec intégration bibliothèque
function updateBrytonActivities() {
    const table = document.getElementById('brytonActivitiesTable');
    if (!table) return;

    table.innerHTML = '';

    const dates = Object.keys(brytonActivities).sort().reverse();

    if (dates.length === 0) {
        table.innerHTML = '<tr><td colspan="9" class="text-center">Aucune activité importée</td></tr>';
        return;
    }

    dates.forEach(dateStr => {
        // Utiliser un Set pour éviter les doublons d'affichage
        const displayedActivities = new Set();

        brytonActivities[dateStr].forEach((activity, idx) => {
            const activityKey = `${activity.filename}_${activity.duration}_${activity.distance}`;

            // N'afficher que si pas déjà affiché
            if (!displayedActivities.has(activityKey)) {
                displayedActivities.add(activityKey);

                const row = document.createElement('tr');

                const planned = trainingProgramData.sessions[dateStr];
                const planDuration = planned ? planned.duration_minutes : 0;
                const planIntensity = planned ? planned.intensity : 'N/A';

                let durationDiff = 0;
                let durationPct = 0;

                if (planDuration > 0 && activity.duration > 0) {
                    durationDiff = activity.duration - planDuration;
                    durationPct = Math.round((durationDiff / planDuration) * 100);
                }

                const durationClass = durationDiff >= 0 ? 'text-success' : 'text-danger';
                const durationDiffDisplay = (planDuration > 0) ?
                    `<span class="${durationClass}">${durationDiff > 0 ? '+' : ''}${durationDiff} min (${durationPct > 0 ? '+' : ''}${durationPct}%)</span>` : 'N/A';

                // Vérifier si l'activité est déjà dans la bibliothèque
                const isInLibrary = isBrytonActivityInLibrary(dateStr, idx);

                // Créer les boutons d'action
                let actionButtons = '';
                if (isInLibrary) {
                    actionButtons = `
                        <span class="badge badge-success">
                            <i class="fas fa-check"></i> Dans la bibliothèque
                        </span>
                        <button class="btn btn-sm btn-warning ml-2" onclick="showNotification('Ce parcours est déjà dans votre bibliothèque', 'info')" title="Voir dans la bibliothèque">
                            <i class="fas fa-eye"></i>
                        </button>
                    `;
                } else {
                    actionButtons = `
                        <button class="btn btn-sm btn-success" onclick="convertBrytonActivityToRoute('${dateStr}', ${idx})" title="Ajouter à la bibliothèque">
                            <i class="fas fa-plus"></i> Bibliothèque
                        </button>
                    `;
                }

                actionButtons += `
                    <button class="btn btn-sm btn-info" onclick="showActivityDetails('${dateStr}', ${idx})" title="Voir les détails">
                        <i class="fas fa-chart-line"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteActivity('${dateStr}', ${idx})" title="Supprimer">
                        <i class="fas fa-trash"></i>
                    </button>
                `;

                // Afficher le nom s'il existe, sinon le nom du fichier
                const displayName = activity.name || activity.filename || 'Import manuel';

                row.innerHTML = `
                    <td>${formatDate(dateStr)}</td>
                    <td>
                        <div>
                            <strong>${displayName}</strong>
                            ${isInLibrary ? '<br><small class="text-success">✓ Déjà dans la bibliothèque</small>' : ''}
                        </div>
                    </td>
                    <td>${activity.duration || 0} min</td>
                    <td>${typeof activity.distance === 'number' ? activity.distance.toFixed(1) : '0'} km</td>
                    <td>${activity.heartRate || 'N/A'}</td>
                    <td>${planDuration > 0 ? `${planDuration} min (${planIntensity})` : 'Aucun'}</td>
                    <td>${durationDiffDisplay}</td>
                    <td>
                        <div class="btn-group" role="group">
                            ${actionButtons}
                        </div>
                    </td>
                `;

                // Ajouter une classe spéciale si dans la bibliothèque
                if (isInLibrary) {
                    row.className = 'table-success';
                }

                table.appendChild(row);
            }
        });
    });

    // Ajouter un pied de tableau avec des actions groupées
    const footerRow = document.createElement('tr');
    footerRow.innerHTML = `
        <td colspan="9" class="text-center p-3">
            <div class="btn-group" role="group">
                <button class="btn btn-success" onclick="importAllBrytonActivities()" title="Importer toutes les activités">
                    <i class="fas fa-download"></i> Tout importer
                </button>
                <button class="btn btn-primary" onclick="importRecentBrytonActivities(30)" title="Importer des 30 derniers jours">
                    <i class="fas fa-calendar"></i> 30 derniers jours
                </button>
                <button class="btn btn-info" onclick="importRecentBrytonActivities(7)" title="Importer des 7 derniers jours">
                    <i class="fas fa-calendar-week"></i> 7 derniers jours
                </button>
                <button class="btn btn-secondary" onclick="syncBrytonWithLibrary()" title="Synchroniser avec la bibliothèque">
                    <i class="fas fa-sync"></i> Synchroniser
                </button>
            </div>
        </td>
    `;
    table.appendChild(footerRow);
}

// Renommer toutes les activités sans nom basé sur leur lieu
async function renameAllUnnamedActivities() {
    let renamedCount = 0;
    let errorCount = 0;

    // Afficher un message de chargement
    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'alert alert-info';
    loadingMsg.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Recherche des lieux pour les activités sans nom...';
    document.body.appendChild(loadingMsg);

    try {
        for (const dateStr of Object.keys(brytonActivities)) {
            for (let i = 0; i < brytonActivities[dateStr].length; i++) {
                const activity = brytonActivities[dateStr][i];

                // Vérifier si l'activité n'a pas de nom ou a un nom générique
                if (!activity.name ||
                    activity.name === "Parcours sans nom" ||
                    activity.name.includes("fit") ||
                    activity.name.includes("gpx") ||
                    activity.name.includes("tcx")) {

                    // Générer un nouveau nom basé sur le lieu
                    if (activity.coordinates && activity.coordinates.length > 1) {
                        try {
                            const sportType = activity.sport || 'cycling';
                            const newName = await generateNameFromRoute(activity.coordinates, sportType);

                            // Mettre à jour le nom
                            brytonActivities[dateStr][i].name = newName;

                            // Mettre à jour également dans userProgress si nécessaire
                            if (userProgress[dateStr] && userProgress[dateStr].activityName === activity.name) {
                                userProgress[dateStr].activityName = newName;
                            }

                            renamedCount++;
                        } catch (error) {
                            console.error(`Erreur pour l'activité du ${dateStr}:`, error);
                            errorCount++;
                        }
                    }
                }
            }
        }

        // Sauvegarder les changements
        saveAllDataToLocalStorage();
        scheduleRemoteSave();

        // Rafraîchir l'affichage
        updateBrytonActivities();

        document.body.removeChild(loadingMsg);

        alert(`✅ ${renamedCount} activités renommées avec succès${errorCount > 0 ? ` (${errorCount} erreurs)` : ''}`);
    } catch (error) {
        document.body.removeChild(loadingMsg);
        console.error('Erreur lors du renommage des activités:', error);
        alert("❌ Une erreur est survenue lors du renommage des activités.");
    }
}

// Afficher les détails d'une activité
function showActivityDetails(dateStr, idx) {
    try {
        const activity = brytonActivities[dateStr][idx];
        if (!activity) {
            alert("Détails de l'activité non disponibles.");
            return;
        }

        const duration = activity.duration || 0;
        const distance = typeof activity.distance === 'number' ? activity.distance : 0;
        const speed = duration > 0 ? (distance / (duration / 60)).toFixed(1) : 0;

        let details = `
            <h4>Activité du ${formatDate(dateStr)}</h4>
            <p><strong>Fichier:</strong> ${activity.filename || 'Import manuel'}</p>
            <p><strong>Durée:</strong> ${duration} minutes</p>
            <p><strong>Distance:</strong> ${distance.toFixed(1)} km</p>
            <p><strong>Vitesse moyenne:</strong> ${speed} km/h</p>
        `;

        if (activity.heartRate) {
            details += `<p><strong>FC moyenne:</strong> ${activity.heartRate} bpm</p>`;

            const maxHR = trainingProgramData?.program_info?.cyclist_profile?.max_heart_rate || 170;
            const pct = Math.round((activity.heartRate / maxHR) * 100);
            details += `<p><strong>% FC max:</strong> ${pct}% (${getHeartRateZone(pct)})</p>`;
        }

        if (activity.cadence) {
            details += `<p><strong>Cadence moyenne:</strong> ${activity.cadence} rpm</p>`;
        }

        if (activity.power) {
            details += `<p><strong>Puissance moyenne:</strong> ${activity.power} watts</p>`;
        }

        const planned = trainingProgramData.sessions[dateStr];
        if (planned) {
            const planDuration = planned.duration_minutes || 0;
            const actualDuration = duration || 0;
            const durationDiff = actualDuration - planDuration;
            const durationPct = planDuration > 0 ? Math.round((durationDiff / planDuration) * 100) : 0;

            const heartRate = activity.heartRate || 0;
            const maxHR = trainingProgramData?.program_info?.cyclist_profile?.max_heart_rate || 170;
            const pct = heartRate > 0 ? Math.round((heartRate / maxHR) * 100) : 0;
            const estimatedIntensity = heartRate > 0 ? estimateIntensityFromHR(pct) : 'N/A';

            details += `
                <h5 class="mt-4 mb-3">Comparaison avec le plan</h5>
                <div class="comparison-table">
                    <table class="table table-sm table-bordered">
                        <thead>
                            <tr>
                                <th></th>
                                <th>Prévu</th>
                                <th>Réalisé</th>
                                <th>Écart</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Durée</td>
                                <td>${planDuration} min</td>
                                <td>${actualDuration} min</td>
                                <td>${durationDiff > 0 ? '+' : ''}${durationDiff} min (${durationPct > 0 ? '+' : ''}${durationPct}%)</td>
                            </tr>
                            <tr>
                                <td>Intensité</td>
                                <td>${planned.intensity}</td>
                                <td>${estimatedIntensity}</td>
                                <td></td>
                            </tr>
                            <tr>
                                <td>TSS estimé</td>
                                <td>${calculateTSS(planned, {})}</td>
                                <td>${calculateTSS({
                                    intensity: estimatedIntensity,
                                    duration_minutes: actualDuration
                                }, {})}</td>
                                <td></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            `;
        }

        const modal = document.createElement('div');
        modal.className = 'modal fade';
        modal.innerHTML = `
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">Analyse d'activité</h5>
                        <button type="button" class="close" data-dismiss="modal">&times;</button>
                    </div>
                    <div class="modal-body">
                        ${details}
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-danger" onclick="deleteActivity('${dateStr}', ${idx})">Supprimer</button>
                        <button type="button" class="btn btn-primary" data-dismiss="modal">Fermer</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        $(modal).modal('show');
        $(modal).on('hidden.bs.modal', function () {
            document.body.removeChild(modal);
        });
    } catch (error) {
        console.error("Erreur d'affichage de l'activité:", error);
        alert("Erreur lors de l'affichage des détails de l'activité.");
    }
}

// Obtenir la zone de fréquence cardiaque
function getHeartRateZone(pct) {
    if (pct >= 90) return 'Zone 5';
    if (pct >= 80) return 'Zone 4';
    if (pct >= 70) return 'Zone 3';
    if (pct >= 60) return 'Zone 2';
    return 'Zone 1';
}

// Supprimer une activité
function deleteActivity(dateStr, idx) {
    if (confirm("Êtes-vous sûr de vouloir supprimer cette activité ?")) {
        try {
            brytonActivities[dateStr].splice(idx, 1);

            if (brytonActivities[dateStr].length === 0) {
                delete brytonActivities[dateStr];
            }

            saveAllDataToLocalStorage();
            scheduleRemoteSave();
            updateBrytonActivities();

            $('.modal').modal('hide');

            alert("✅ Activité supprimée avec succès !");
        } catch (error) {
            console.error("Erreur lors de la suppression:", error);
            alert("❌ Erreur lors de la suppression de l'activité.");
        }
    }
}

/* ========================================
   FONCTIONS DE GESTION DES MODALES
   ======================================== */

// Ouvrir la fenêtre modale des détails de session
function openSessionModal(date) {
    currentEditingDate = date;
    
    // Assurer que trainingProgramData et sessions sont définis
    if (!trainingProgramData) {
        trainingProgramData = {
            program_info: {},
            sessions: {}
        };
    }
    
    if (!trainingProgramData.sessions) {
        trainingProgramData.sessions = {};
    }
    
    const session = trainingProgramData.sessions[date];
    const modal = document.getElementById('sessionModal');

    if (!session) {
        const dateObj = new Date(date);
        const frenchDay = getFrenchDay(dateObj);

        trainingProgramData.sessions[date] = {
            day: frenchDay,
            session_type: "Repos",
            duration_minutes: 0,
            heart_rate_zone: "N/A",
            cadence_rpm: "N/A",
            intensity: "Repos",
            exercises: "",
            nutrition_pre: "Repas normal",
            nutrition_post: "Repas normal",
            notes: "Jour de repos",
            detailed_exercises: []
        };
    }

    const currentSession = trainingProgramData.sessions[date];

    if (currentSession) {
        document.getElementById('modalTitle').innerText = `Détails de la session: ${currentSession.day} - ${date}`;
        document.getElementById('modalDate').value = date;
        document.getElementById('modalSessionType').value = currentSession.session_type;
        document.getElementById('modalDuration').value = currentSession.duration_minutes;

        const actualData = userProgress[date];
        if (actualData) {
            document.getElementById('modalActualDuration').value = actualData.actualDuration || '';
            document.getElementById('modalDistance').value = actualData.distance || '';
            document.getElementById('modalActualHeartRate').value = actualData.actualHeartRate || '';
            document.getElementById('modalDifficulty').value = actualData.difficulty || 5;
            document.getElementById('modalFatigue').value = actualData.fatigue || 5;
            document.getElementById('modalWeather').value = actualData.weather || 'Bonne';
        } else {
            document.getElementById('modalActualDuration').value = '';
            document.getElementById('modalDistance').value = '';
            document.getElementById('modalActualHeartRate').value = '';
            document.getElementById('modalDifficulty').value = 5;
            document.getElementById('modalFatigue').value = 5;
            document.getElementById('modalWeather').value = 'Bonne';
        }

        document.getElementById('difficultyValue').textContent = document.getElementById('modalDifficulty').value;
        document.getElementById('fatigueValue').textContent = document.getElementById('modalFatigue').value;

        document.getElementById('modalHeartRate').value = currentSession.heart_rate_zone;
        document.getElementById('modalCadence').value = currentSession.cadence_rpm;
        document.getElementById('modalExercises').value = currentSession.exercises;

        if (nutritionLog[date]) {
            document.getElementById('modalNutritionPre').value = nutritionLog[date].preWorkout || currentSession.nutrition_pre;
            document.getElementById('modalNutritionPost').value = nutritionLog[date].postWorkout || currentSession.nutrition_post;
        } else {
            document.getElementById('modalNutritionPre').value = currentSession.nutrition_pre;
            document.getElementById('modalNutritionPost').value = currentSession.nutrition_post;
        }

        document.getElementById('modalNotes').value = actualData?.notes || currentSession.notes;

        const exerciseSuggestions = document.getElementById('exerciseSuggestions');
        exerciseSuggestions.innerHTML = '';

        if (currentSession.detailed_exercises && currentSession.detailed_exercises.length > 0) {
            currentSession.detailed_exercises.forEach(exercise => {
                const exerciseItem = document.createElement('div');
                exerciseItem.className = 'exercise-item';

                let detailsHtml = `<strong>${exercise.name}</strong>: ${exercise.duration} min`;
                if (exercise.heart_rate && exercise.heart_rate !== 'N/A') {
                    detailsHtml += ` • ❤️ ${exercise.heart_rate}`;
                }
                if (exercise.cadence && exercise.cadence !== 'N/A') {
                    detailsHtml += ` • 🔄 ${exercise.cadence}`;
                }
                if (exercise.details) {
                    detailsHtml += `<br><small>${exercise.details}</small>`;
                }

                exerciseItem.innerHTML = detailsHtml;
                exerciseSuggestions.appendChild(exerciseItem);
            });
        } else {
            exerciseSuggestions.innerHTML = '<p>Aucun exercice détaillé défini pour cette session</p>';
        }
    }

    modal.style.display = "block";
}

// Fermer la fenêtre modale
function closeSessionModal() {
    document.getElementById('sessionModal').style.display = "none";
    currentEditingDate = null;
}

// Sauvegarder les modifications de session
function saveSessionDetails() {
    if (!currentEditingDate) return;

    const updatedSession = {
        day: trainingProgramData.sessions[currentEditingDate].day,
        session_type: document.getElementById('modalSessionType').value,
        duration_minutes: parseInt(document.getElementById('modalDuration').value),
        heart_rate_zone: document.getElementById('modalHeartRate').value,
        cadence_rpm: document.getElementById('modalCadence').value,
        intensity: trainingProgramData.sessions[currentEditingDate].intensity,
        exercises: document.getElementById('modalExercises').value,
        nutrition_pre: document.getElementById('modalNutritionPre').value,
        nutrition_post: document.getElementById('modalNutritionPost').value,
        notes: document.getElementById('modalNotes').value,
        detailed_exercises: trainingProgramData.sessions[currentEditingDate].detailed_exercises || []
    };

    trainingProgramData.sessions[currentEditingDate] = updatedSession;
    localStorage.setItem('trainingProgramData', JSON.stringify(trainingProgramData));

    nutritionLog[currentEditingDate] = {
        preWorkout: document.getElementById('modalNutritionPre').value,
        postWorkout: document.getElementById('modalNutritionPost').value,
        notes: document.getElementById('modalNotes').value,
        timestamp: new Date().toISOString()
    };
    localStorage.setItem('nutritionLog', JSON.stringify(nutritionLog));

    const actualDuration = parseInt(document.getElementById('modalActualDuration').value) || 0;
    const distance = parseFloat(document.getElementById('modalDistance').value) || 0;
    const difficulty = parseInt(document.getElementById('modalDifficulty').value) || 5;
    const fatigue = parseInt(document.getElementById('modalFatigue').value) || 5;
    const weather = document.getElementById('modalWeather').value;
    const actualHeartRate = document.getElementById('modalActualHeartRate').value;

    if (!userProgress[currentEditingDate]) {
        userProgress[currentEditingDate] = {};
    }

    userProgress[currentEditingDate] = {
        ...userProgress[currentEditingDate],
        completed: true,
        completedAt: new Date().toISOString(),
        actualDuration,
        distance,
        actualHeartRate,
        difficulty,
        fatigue,
        weather
    };

    const tss = calculateTSS(updatedSession, userProgress[currentEditingDate]);
    userProgress[currentEditingDate].tss = tss;

    // Sauvegarder et synchroniser
    saveAllDataToLocalStorage();
    scheduleRemoteSave();
    
    updateMonthlyPlan();
    closeSessionModal();
    alert("✅ Modifications sauvegardées et session enregistrée comme complétée!");
}

// Supprimer la session
function deleteSession() {
    if (!currentEditingDate) return;

    if (confirm("Êtes-vous sûr de vouloir supprimer cette session?")) {
        delete trainingProgramData.sessions[currentEditingDate];
        delete userProgress[currentEditingDate];
        delete nutritionLog[currentEditingDate];

        localStorage.setItem('trainingProgramData', JSON.stringify(trainingProgramData));
        localStorage.setItem('cyclingProgress', JSON.stringify(userProgress));
        localStorage.setItem('nutritionLog', JSON.stringify(nutritionLog));
        
        saveAllDataToLocalStorage();
        scheduleRemoteSave();

        updateMonthlyPlan();
        closeSessionModal();
        alert("🗑️ Session supprimée avec succès!");
    }
}

/* ========================================
   FONCTIONS DE GESTION DES PARCOURS
   ======================================== */

/* ========================================
   SYSTÈME DE CATÉGORISATION DE PARCOURS
   ======================================== */

// Analyser et catégoriser automatiquement un parcours
function categorizeRoute(route) {
    const distance = route.distance || 0;
    const duration = route.duration || 0;
    const elevation = route.elevation || 0;
    const avgSpeed = distance > 0 && duration > 0 ? (distance / duration) * 60 : 0; // km/h
    const elevationRatio = distance > 0 ? (elevation / distance) * 100 : 0; // mètres dénivelé / km

    // Catégorisation par type
    let type = 'endurance';
    let intensity = 'faible';

    if (distance < 30) {
        if (avgSpeed > 25) type = 'sprint';
        else if (avgSpeed > 20) type = 'vitesse';
        else type = 'courte_distance';
    } else if (distance < 60) {
        if (elevationRatio > 15) type = 'collines';
        else if (avgSpeed > 22) type = 'tempo';
        else type = 'endurance';
    } else if (distance < 120) {
        type = 'longue_distance';
    } else {
        type = 'randonnee';
    }

    // Classification de l'intensité
    if (elevationRatio > 20 || avgSpeed > 28) {
        intensity = 'eleve';
    } else if (elevationRatio > 10 || avgSpeed > 23) {
        intensity = 'moyen';
    }

    // Niveau de difficulté
    let difficulty = 'facile';
    if (distance > 100 || elevation > 1000 || elevationRatio > 25) {
        difficulty = 'difficile';
    } else if (distance > 60 || elevation > 500 || elevationRatio > 15) {
        difficulty = 'moyen';
    }

    // Tags automatiques
    const tags = [];
    if (distance > 100) tags.push('longue');
    if (elevation > 800) tags.push('montagne');
    if (avgSpeed > 25) tags.push('rapide');
    if (elevationRatio > 20) tags.push('accidenté');
    if (distance < 40) tags.push('court');

    // Saisonnalité suggérée
    const month = new Date(route.date).getMonth();
    let season = 'ete'; // par défaut
    if (month >= 2 && month <= 4) season = 'printemps';
    else if (month >= 5 && month <= 7) season = 'ete';
    else if (month >= 8 && month <= 10) season = 'automne';
    else season = 'hiver';

    return {
        type,
        difficulty,
        intensity,
        tags,
        season,
        elevationRatio: Math.round(elevationRatio),
        avgSpeed: Math.round(avgSpeed * 10) / 10
    };
}

// Sauvegarder le parcours actuellement affiché avec catégorisation
function saveCurrentRoute() {
    if (!currentRouteCoordinates || currentRouteCoordinates.length < 2) {
        alert("Aucun parcours à sauvegarder. Importez d'abord un fichier FIT/GPX/TCX.");
        return;
    }

    const name = prompt("Nom du parcours:", currentRouteMetadata.name || "Mon parcours");
    if (!name) return;

    const description = prompt("Description (optionnelle):", "");

    const newRoute = {
        id: "route_" + Date.now(),
        name: name,
        description: description,
        date: new Date().toISOString().split('T')[0],
        distance: currentRouteMetadata.distanceKm || 0,
        duration: currentRouteMetadata.durationMin || 0,
        elevation: currentRouteMetadata.elevationGain || 0,
        coordinates: currentRouteCoordinates,
        source: currentRouteMetadata.source || "manual",
        filename: currentRouteMetadata.filename || "manuel",
        isFavorite: false,
        createdAt: new Date().toISOString()
    };

    // Ajouter la catégorisation automatique
    const categorization = categorizeRoute(newRoute);
    newRoute = { ...newRoute, ...categorization };

    savedRoutes.push(newRoute);
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();
    updateRoutesList();

    alert("✅ Parcours sauvegardé avec analyse automatique !");
}

/* ========================================
   SYSTÈME DE FILTRES ET RECHERCHE
   ======================================== */

let currentFilters = {
    search: '',
    type: 'all',
    difficulty: 'all',
    season: 'all',
    source: 'all',
    favorites: false,
    minDistance: 0,
    maxDistance: 999
};

let currentViewMode = 'list'; // list, grid, map

// Appliquer les filtres aux parcours
function applyFilters() {
    let filteredRoutes = [...savedRoutes];

    // Filtre de recherche
    if (currentFilters.search) {
        const searchTerm = currentFilters.search.toLowerCase();
        filteredRoutes = filteredRoutes.filter(route =>
            route.name.toLowerCase().includes(searchTerm) ||
            (route.description && route.description.toLowerCase().includes(searchTerm)) ||
            (route.tags && route.tags.some(tag => tag.toLowerCase().includes(searchTerm)))
        );
    }

    // Filtre par type
    if (currentFilters.type !== 'all') {
        filteredRoutes = filteredRoutes.filter(route => route.type === currentFilters.type);
    }

    // Filtre par difficulté
    if (currentFilters.difficulty !== 'all') {
        filteredRoutes = filteredRoutes.filter(route => route.difficulty === currentFilters.difficulty);
    }

    // Filtre par saison
    if (currentFilters.season !== 'all') {
        filteredRoutes = filteredRoutes.filter(route => route.season === currentFilters.season);
    }

    // Filtre par source
    if (currentFilters.source !== 'all') {
        filteredRoutes = filteredRoutes.filter(route => route.source === currentFilters.source);
    }

    // Filtre favoris
    if (currentFilters.favorites) {
        filteredRoutes = filteredRoutes.filter(route => route.isFavorite);
    }

    // Filtre par distance
    filteredRoutes = filteredRoutes.filter(route =>
        route.distance >= currentFilters.minDistance &&
        route.distance <= currentFilters.maxDistance
    );

    return filteredRoutes;
}

// Mettre à jour la liste des parcours avec filtres et vues
function updateRoutesList() {
    const routesContainer = document.getElementById('routesList');
    if (!routesContainer) return;

    const filteredRoutes = applyFilters();
    updateLibraryStats(filteredRoutes);

    if (filteredRoutes.length === 0) {
        routesContainer.innerHTML = `
            <div class="col-12 text-center text-muted py-4">
                <i class="fas fa-route fa-3x mb-3"></i>
                <h5>Aucun parcours trouvé</h5>
                <p>Essayez de modifier vos filtres ou d'importer de nouveaux parcours</p>
            </div>
        `;
        return;
    }

    // Trier par date la plus récente
    filteredRoutes.sort((a, b) => new Date(b.date || b.createdAt) - new Date(a.date || a.createdAt));

    if (currentViewMode === 'grid') {
        routesContainer.className = 'row';
        routesContainer.innerHTML = filteredRoutes.map(route => createRouteCard(route)).join('');
    } else {
        routesContainer.className = 'list-group';
        routesContainer.innerHTML = filteredRoutes.map(route => createRouteListItem(route)).join('');
    }
}

// Créer une carte de parcours pour la vue grille
function createRouteCard(route) {
    const categoryColors = {
        'sprint': 'danger',
        'vitesse': 'warning',
        'endurance': 'success',
        'collines': 'info',
        'longue_distance': 'primary',
        'randonnee': 'secondary'
    };

    const typeLabel = {
        'sprint': 'Sprint',
        'vitesse': 'Vitesse',
        'endurance': 'Endurance',
        'collines': 'Collines',
        'longue_distance': 'Longue distance',
        'randonnee': 'Randonnée',
        'courte_distance': 'Courte distance',
        'tempo': 'Tempo'
    };

    // Indicateur spécial pour les parcours importés
    let specialIndicator = '';
    if (route.source === 'bryton') {
        specialIndicator = `
            <span class="badge badge-info ml-2" title="Importé depuis Bryton">
                <i class="fas fa-bicycle"></i> Bryton
            </span>
        `;
    } else if (route.source === 'import') {
        specialIndicator = `
            <span class="badge badge-success ml-2" title="Importé depuis un fichier GPX/TCX">
                <i class="fas fa-file-import"></i> GPX
            </span>
        `;
    }

    return `
        <div class="col-md-6 col-lg-4 mb-3">
            <div class="card h-100 ${route.id === selectedRouteId ? 'border-primary' : ''} ${route.source === 'bryton' ? 'border-info' : ''} ${route.source === 'import' ? 'border-success' : ''}"
                 onclick="selectRoute('${route.id}')" style="cursor: pointer;">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <div>
                        <span class="badge badge-${categoryColors[route.type] || 'secondary'}">
                            ${typeLabel[route.type] || route.type}
                        </span>
                        ${specialIndicator}
                    </div>
                    <button class="btn btn-sm ${route.isFavorite ? 'text-warning' : 'text-muted'}"
                            onclick="event.stopPropagation(); toggleFavorite('${route.id}')">
                        <i class="fas fa-star"></i>
                    </button>
                </div>
                <div class="card-body">
                    <h6 class="card-title text-truncate">${route.name}</h6>
                    <p class="card-text small text-muted">
                        ${route.description ? route.description.substring(0, 60) + '...' : 'Pas de description'}
                    </p>
                    <div class="row small">
                        <div class="col-6">
                            <i class="fas fa-route"></i> ${formatDistance(route.distance)}
                        </div>
                        <div class="col-6">
                            <i class="fas fa-clock"></i> ${formatDurationSimple(route.duration)}
                        </div>
                        <div class="col-6">
                            <i class="fas fa-mountain"></i> ${route.elevation || 0}m
                        </div>
                        <div class="col-6">
                            <i class="fas fa-tachometer-alt"></i> ${route.avgSpeed || '?'} km/h
                        </div>
                    </div>
                    ${route.tags && route.tags.length > 0 ? `
                        <div class="mt-2">
                            ${route.tags.slice(0, 3).map(tag =>
                                `<span class="badge badge-light badge-pill mr-1">${tag}</span>`
                            ).join('')}
                        </div>
                    ` : ''}
                </div>
                <div class="card-footer text-muted small">
                    ${formatDate(route.date || route.createdAt)}
                    ${route.source === 'bryton' ? '<br><small class="text-info">🚴 Importé Bryton</small>' : ''}
                    ${route.source === 'import' ? '<br><small class="text-success">📁 Importé (GPX/TCX)</small>' : ''}
                </div>
            </div>
        </div>
    `;
}

// Créer un élément de liste pour la vue liste
function createRouteListItem(route) {
    const difficultyColors = {
        'facile': 'success',
        'moyen': 'warning',
        'difficile': 'danger'
    };

    const typeLabel = {
        'sprint': 'Sprint',
        'vitesse': 'Vitesse',
        'endurance': 'Endurance',
        'collines': 'Collines',
        'longue_distance': 'Longue distance',
        'randonnee': 'Randonnée',
        'courte_distance': 'Courte distance',
        'tempo': 'Tempo'
    };

    // Indicateur spécial pour les parcours Bryton
    let specialBadge = '';
    if (route.source === 'bryton') {
        specialBadge = `
            <span class="badge badge-info ml-2" title="Importé depuis Bryton">
                <i class="fas fa-bicycle"></i> Bryton
            </span>
        `;
    } else if (route.source === 'import') {
        specialBadge = `
            <span class="badge badge-success ml-2" title="Importé depuis un fichier GPX/TCX">
                <i class="fas fa-file-import"></i> GPX
            </span>
        `;
    }

    // Bouton de suppression spécial pour Bryton
    const deleteButton = route.source === 'bryton' ?
        `<button class="btn btn-outline-warning" onclick="event.stopPropagation(); removeBrytonRouteFromLibrary('${route.id}')" title="Retirer de la bibliothèque">
            <i class="fas fa-unlink"></i>
        </button>` :
        `<button class="btn btn-outline-danger" onclick="event.stopPropagation(); deleteRoute('${route.id}')" title="Supprimer">
            <i class="fas fa-trash"></i>
        </button>`;

    return `
        <a href="#" class="list-group-item list-group-item-action ${route.id === selectedRouteId ? 'active' : ''} ${route.source === 'bryton' ? 'list-group-item-info' : ''}"
           onclick="selectRoute('${route.id}'); return false;">
            <div class="d-flex w-100 justify-content-between">
                <div class="flex-grow-1">
                    <h5 class="mb-1 d-flex align-items-center">
                        ${route.name}
                        ${route.isFavorite ? '<i class="fas fa-star text-warning ml-2"></i>' : ''}
                        <span class="badge badge-${difficultyColors[route.difficulty] || 'secondary'} ml-2">
                            ${route.difficulty || 'inconnu'}
                        </span>
                        ${specialBadge}
                    </h5>
                    <p class="mb-1 text-muted small">${route.description || 'Pas de description'}</p>
                    <div class="d-flex flex-wrap small text-muted">
                        <span class="mr-3"><i class="fas fa-route"></i> ${formatDistance(route.distance)}</span>
                        <span class="mr-3"><i class="fas fa-clock"></i> ${formatDurationSimple(route.duration)}</span>
                        <span class="mr-3"><i class="fas fa-mountain"></i> ${route.elevation || 0}m</span>
                        <span class="mr-3"><i class="fas fa-tachometer-alt"></i> ${route.avgSpeed || '?'} km/h</span>
                        <span><i class="fas fa-tag"></i> ${typeLabel[route.type] || route.type || 'inconnu'}</span>
                    </div>
                    ${route.tags && route.tags.length > 0 ? `
                        <div class="mt-1">
                            ${route.tags.map(tag =>
                                `<span class="badge badge-light badge-pill mr-1">${tag}</span>`
                            ).join('')}
                        </div>
                    ` : ''}
                </div>
                <div class="text-right">
                    <small class="d-block">${formatDate(route.date || route.createdAt)}</small>
                    ${route.source === 'bryton' ? '<small class="text-info d-block">🚴 Bryton</small>' : ''}
                    ${route.source === 'import' ? '<small class="text-success d-block">📁 Importé (GPX/TCX)</small>' : ''}
                    <div class="btn-group btn-group-sm mt-1">
                        <button class="btn btn-outline-primary" onclick="event.stopPropagation(); selectRoute('${route.id}')" title="Afficher">
                            <i class="fas fa-eye"></i>
                        </button>
                        ${deleteButton}
                    </div>
                </div>
            </div>
        </a>
    `;
}

// Mettre à jour les statistiques de la bibliothèque
function updateLibraryStats(filteredRoutes) {
    const totalRoutes = savedRoutes.length;
    const totalDistance = savedRoutes.reduce((sum, route) => sum + (route.distance || 0), 0);
    const totalElevation = savedRoutes.reduce((sum, route) => sum + (route.elevation || 0), 0);
    const favoriteRoutes = savedRoutes.filter(route => route.isFavorite).length;

    const statsElement = document.getElementById('libraryStats');
    if (statsElement) {
        statsElement.innerHTML = `
            <div class="row text-center">
                <div class="col-3">
                    <div class="d-block h4 mb-0">${totalRoutes}</div>
                    <small class="text-muted">Parcours</small>
                </div>
                <div class="col-3">
                    <div class="d-block h4 mb-0">${Math.round(totalDistance)} km</div>
                    <small class="text-muted">Distance totale</small>
                </div>
                <div class="col-3">
                    <div class="d-block h4 mb-0">${totalElevation} m</div>
                    <small class="text-muted">Dénivelé total</small>
                </div>
                <div class="col-3">
                    <div class="d-block h4 mb-0">${favoriteRoutes}</div>
                    <small class="text-muted">Favoris</small>
                </div>
            </div>
        `;
    }
}

/* ========================================
   FONCTIONNALITÉS AVANCÉES
   ======================================== */

// Basculer le statut favori d'un parcours
function toggleFavorite(routeId) {
    const route = savedRoutes.find(r => r.id === routeId);
    if (!route) return;

    route.isFavorite = !route.isFavorite;
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();
    updateRoutesList();

    // Feedback visuel
    const message = route.isFavorite ? '⭐ Ajouté aux favoris' : 'Retiré des favoris';
    showNotification(message, 'success');
}

// Supprimer un parcours spécifique
function deleteRoute(routeId) {
    if (!confirm("Êtes-vous sûr de vouloir supprimer ce parcours ?")) return;

    savedRoutes = savedRoutes.filter(r => r.id !== routeId);
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();

    if (selectedRouteId === routeId) {
        selectedRouteId = null;
        document.getElementById('routeDetailCard')?.classList.add('d-none');
        document.getElementById('routeEmptyState')?.classList.remove('d-none');
    }

    updateRoutesList();
    showNotification('Parcours supprimé avec succès', 'success');
}

// Changer le mode d'affichage
function changeViewMode(mode) {
    currentViewMode = mode;
    updateRoutesList();

    // Mettre à jour les boutons de vue
    document.querySelectorAll('[data-view-mode]').forEach(btn => {
        btn.classList.remove('active', 'btn-primary');
        btn.classList.add('btn-outline-primary');
    });

    const activeBtn = document.querySelector(`[data-view-mode="${mode}"]`);
    if (activeBtn) {
        activeBtn.classList.remove('btn-outline-primary');
        activeBtn.classList.add('active', 'btn-primary');
    }
}

// Exporter les parcours en différents formats
function exportRoutes(format = 'json') {
    const filteredRoutes = applyFilters();
    const exportData = prepareExportData(filteredRoutes, format);

    let filename = `parcours_${new Date().toISOString().split('T')[0]}`;
    let mimeType = 'application/json';
    let fileExtension = 'json';

    switch (format) {
        case 'gpx':
            filename += '.gpx';
            mimeType = 'application/gpx+xml';
            fileExtension = 'gpx';
            break;
        case 'csv':
            filename += '.csv';
            mimeType = 'text/csv';
            fileExtension = 'csv';
            break;
        default:
            filename += '.json';
            break;
    }

    downloadFile(exportData, filename, mimeType);
    showNotification(`${filteredRoutes.length} parcours exportés en ${format.toUpperCase()}`, 'success');
}

// Préparer les données pour l'export
function prepareExportData(routes, format) {
    switch (format) {
        case 'gpx':
            return convertToGPX(routes);
        case 'csv':
            return convertToCSV(routes);
        default:
            return JSON.stringify(routes, null, 2);
    }
}

// Convertir les parcours en GPX
function convertToGPX(routes) {
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Cycling Tracker" xmlns="http://www.topografix.com/GPX/1/1">
`;

    routes.forEach(route => {
        if (route.coordinates && route.coordinates.length > 0) {
            gpx += `  <trk>
    <name>${escapeXml(route.name)}</name>
    <desc>${escapeXml(route.description || '')}</desc>
    <trkseg>
`;

            route.coordinates.forEach(coord => {
                gpx += `      <trkpt lat="${coord[1]}" lon="${coord[0]}"></trkpt>
`;
            });

            gpx += `    </trkseg>
  </trk>
`;
        }
    });

    gpx += '</gpx>';
    return gpx;
}

// Convertir en CSV
function convertToCSV(routes) {
    const headers = ['Nom', 'Description', 'Date', 'Distance (km)', 'Durée (min)', 'Dénivelé (m)', 'Type', 'Difficulté'];
    const rows = routes.map(route => [
        route.name || '',
        route.description || '',
        route.date || '',
        route.distance || 0,
        route.duration || 0,
        route.elevation || 0,
        route.type || '',
        route.difficulty || ''
    ]);

    return [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');
}

// Échapper les caractères XML
function escapeXml(unsafe) {
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

// Télécharger un fichier
function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Afficher une notification
function showNotification(message, type = 'info') {
    const colors = {
        success: 'alert-success',
        error: 'alert-danger',
        warning: 'alert-warning',
        info: 'alert-info'
    };

    const notification = document.createElement('div');
    notification.className = `alert ${colors[type]} alert-dismissible fade show position-fixed`;
    notification.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
    notification.innerHTML = `
        ${message}
        <button type="button" class="close" data-dismiss="alert">
            <span>&times;</span>
        </button>
    `;

    document.body.appendChild(notification);

    // Auto-suppression après 3 secondes
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

/* ========================================
   INITIALISATION BIBLIOTHÈQUE OPTIMISÉE
   ======================================== */

// Initialiser la bibliothèque optimisée
function initializeOptimizedLibrary() {
    console.log("📚 Initialisation de la bibliothèque optimisée...");

    try {
        // Vérifier que les variables globales existent
        if (typeof savedRoutes === 'undefined') {
            console.warn('savedRoutes non défini, initialisation...');
            savedRoutes = [];
        }

        // Migrer les parcours existants vers la nouvelle structure
        if (typeof migrateExistingRoutes === 'function') {
            migrateExistingRoutes();
        }

        // Initialiser les filtres avec les valeurs par défaut
        if (typeof resetFilters === 'function') {
            resetFilters();
        } else {
            console.warn('resetFilters non défini');
        }

        // Initialiser la vue par défaut (liste)
        currentViewMode = 'list';

        // Mettre à jour le compteur de parcours
        const routeCount = document.getElementById('routeCount');
        if (routeCount) {
            routeCount.textContent = `${savedRoutes.length} parcours`;
        }

        console.log(`📊 Bibliothèque initialisée: ${savedRoutes.length} parcours trouvés`);
    } catch (error) {
        console.error('Erreur lors de l\'initialisation de la bibliothèque optimisée:', error);
    }
}

/* ========================================
   FONCTIONS DE LIAISON INTERFACE-FILTRES
   ======================================== */

// Appliquer les filtres depuis l'interface
function filterRoutes() {
    // Mettre à jour l'objet de filtres
    currentFilters.search = document.getElementById('routeSearchInput')?.value || '';
    currentFilters.type = document.getElementById('filterType')?.value || 'all';
    currentFilters.difficulty = document.getElementById('filterDifficulty')?.value || 'all';
    currentFilters.season = document.getElementById('filterSeason')?.value || 'all';
    currentFilters.source = document.getElementById('filterSource')?.value || 'all';
    currentFilters.favorites = document.getElementById('filterFavorites')?.checked || false;
    currentFilters.minDistance = parseInt(document.getElementById('filterMinDistance')?.value) || 0;
    currentFilters.maxDistance = parseInt(document.getElementById('filterMaxDistance')?.value) || 999;

    updateRoutesList();
}

// Réinitialiser tous les filtres
function resetFilters() {
    // Réinitialiser l'objet de filtres
    currentFilters = {
        search: '',
        type: 'all',
        difficulty: 'all',
        season: 'all',
        source: 'all',
        favorites: false,
        minDistance: 0,
        maxDistance: 999
    };

    // Réinitialiser les champs du formulaire (avec vérification d'existence)
    const searchInput = document.getElementById('routeSearchInput');
    const typeFilter = document.getElementById('filterType');
    const difficultyFilter = document.getElementById('filterDifficulty');
    const seasonFilter = document.getElementById('filterSeason');
    const sourceFilter = document.getElementById('filterSource');
    const favoritesFilter = document.getElementById('filterFavorites');
    const minDistanceFilter = document.getElementById('filterMinDistance');
    const maxDistanceFilter = document.getElementById('filterMaxDistance');

    if (searchInput) searchInput.value = '';
    if (typeFilter) typeFilter.value = 'all';
    if (difficultyFilter) difficultyFilter.value = 'all';
    if (seasonFilter) seasonFilter.value = 'all';
    if (sourceFilter) sourceFilter.value = 'all';
    if (favoritesFilter) favoritesFilter.checked = false;
    if (minDistanceFilter) minDistanceFilter.value = '';
    if (maxDistanceFilter) maxDistanceFilter.value = '';

    if (typeof updateRoutesList === 'function') {
        updateRoutesList();
    }
    if (typeof showNotification === 'function') {
        showNotification('Filtres réinitialisés', 'info');
    }
}

// Sélectionner un parcours avec mise à jour des détails
function selectRoute(routeId) {
    selectedRouteId = routeId;
    const route = savedRoutes.find(r => r.id === routeId);

    if (!route) {
        console.error("Parcours non trouvé:", routeId);
        return;
    }

    // Afficher les détails du parcours
    document.getElementById('routeDetailCard').classList.remove('d-none');
    document.getElementById('routeEmptyState').classList.add('d-none');

    // Mettre à jour les informations de base
    document.getElementById('routeDetailName').textContent = route.name;
    document.getElementById('routeDetailDate').textContent = formatDate(route.date || route.createdAt);
    document.getElementById('routeDetailDistance').textContent = (route.distance || 0).toFixed(1);
    document.getElementById('routeDetailDuration').textContent = formatDurationForMap(route.duration);
    document.getElementById('routeDetailElevation').textContent = route.elevation || "N/A";
    document.getElementById('routeDetailSource').textContent = getSourceLabel(route.source);
    document.getElementById('routeDetailFilename').textContent = route.filename || "N/A";
    document.getElementById('routeDetailDescription').textContent = route.description || "Pas de description";

    // Afficher les informations Bryton si applicable
    const brytonLinkInfo = document.getElementById('brytonLinkInfo');
    const brytonLinkDate = document.getElementById('brytonLinkDate');

    if (route.source === 'bryton' && route.brytonDate) {
        brytonLinkInfo.style.display = 'block';
        brytonLinkDate.textContent = formatDate(route.brytonDate);
    } else {
        brytonLinkInfo.style.display = 'none';
    }

    // Mettre à jour les champs de catégorisation
    const typeLabel = {
        'sprint': 'Sprint',
        'vitesse': 'Vitesse',
        'endurance': 'Endurance',
        'collines': 'Collines',
        'longue_distance': 'Longue distance',
        'randonnee': 'Randonnée',
        'courte_distance': 'Courte distance',
        'tempo': 'Tempo'
    };

    document.getElementById('routeDetailType').textContent = typeLabel[route.type] || route.type || 'Inconnu';
    document.getElementById('routeDetailType').className = `badge badge-${getTypeBadgeColor(route.type)}`;

    document.getElementById('routeDetailDifficulty').textContent = route.difficulty || 'Inconnue';
    document.getElementById('routeDetailDifficulty').className = `badge badge-${getDifficultyBadgeColor(route.difficulty)}`;

    document.getElementById('routeDetailIntensity').textContent = route.intensity || 'Inconnue';
    document.getElementById('routeDetailIntensity').className = `badge badge-${getIntensityBadgeColor(route.intensity)}`;

    document.getElementById('routeDetailAvgSpeed').textContent = route.avgSpeed || '?';

    // Mettre à jour le bouton favori
    const favoriteBtn = document.getElementById('favoriteToggle');
    if (favoriteBtn) {
        favoriteBtn.className = route.isFavorite ? 'fas fa-star text-warning' : 'far fa-star';
    }

    // Afficher les tags
    const tagsContainer = document.getElementById('routeTags');
    if (tagsContainer && route.tags && route.tags.length > 0) {
        tagsContainer.innerHTML = route.tags.map(tag =>
            `<span class="badge badge-light badge-pill mr-1">${tag}</span>`
        ).join('');
    } else if (tagsContainer) {
        tagsContainer.innerHTML = '';
    }

    // Mettre à jour le compteur avec distinction Bryton
    const filteredRoutes = applyFilters();
    const brytonCount = filteredRoutes.filter(route => route.source === 'bryton').length;
    const totalCount = filteredRoutes.length;

    let countText = `${totalCount} parcours`;
    if (brytonCount > 0) {
        countText += ` (${brytonCount} Bryton)`;
    }
    document.getElementById('routeCount').textContent = countText;

    updateRoutesList();
}

// Obtenir la couleur du badge de type
function getTypeBadgeColor(type) {
    const colors = {
        'sprint': 'danger',
        'vitesse': 'warning',
        'endurance': 'success',
        'collines': 'info',
        'longue_distance': 'primary',
        'randonnee': 'secondary'
    };
    return colors[type] || 'light';
}

// Obtenir la couleur du badge de difficulté
function getDifficultyBadgeColor(difficulty) {
    const colors = {
        'facile': 'success',
        'moyen': 'warning',
        'difficile': 'danger'
    };
    return colors[difficulty] || 'secondary';
}

// Obtenir la couleur du badge d'intensité
function getIntensityBadgeColor(intensity) {
    const colors = {
        'faible': 'success',
        'moyen': 'warning',
        'eleve': 'danger'
    };
    return colors[intensity] || 'secondary';
}

// Mettre à jour les parcours existants avec la nouvelle structure
function migrateExistingRoutes() {
    let migratedCount = 0;

    savedRoutes.forEach(route => {
        // Si le parcours n'a pas de catégorisation, l'ajouter
        if (!route.type || !route.difficulty) {
            const categorization = categorizeRoute(route);
            Object.assign(route, categorization);
            route.isFavorite = route.isFavorite || false;
            route.createdAt = route.createdAt || route.date;
            migratedCount++;
        }
    });

    if (migratedCount > 0) {
        localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
        scheduleRemoteSave();
        console.log(`${migratedCount} parcours migrés vers la nouvelle structure`);
    }
}

/* ========================================
   INTÉGRATION BRYTON - BIBLIOTHÈQUE
   ======================================== */

// Convertir une activité Bryton en parcours
window.convertBrytonActivityToRoute = function(dateStr, activityIdx) {
    console.log('convertBrytonActivityToRoute appelé avec:', dateStr, activityIdx);

    // Vérifier que les variables nécessaires existent
    if (typeof brytonActivities === 'undefined') {
        console.error('brytonActivities non défini');
        if (typeof showNotification === 'function') {
            showNotification('Erreur: données Bryton non disponibles', 'error');
        } else {
            alert('Erreur: données Bryton non disponibles');
        }
        return;
    }

    const activity = brytonActivities[dateStr]?.[activityIdx];
    if (!activity) {
        showNotification('Activité non trouvée', 'error');
        return;
    }

    // Vérifier si le parcours existe déjà
    const existingRoute = savedRoutes.find(route =>
        route.source === 'bryton' &&
        route.brytonDate === dateStr &&
        route.brytonIdx === activityIdx
    );

    if (existingRoute) {
        showNotification('Ce parcours existe déjà dans votre bibliothèque', 'warning');
        return;
    }

    // Créer le nouveau parcours
    const newRoute = {
        id: "route_" + Date.now(),
        name: activity.name || `Activité du ${formatDate(dateStr)}`,
        description: `Importé depuis ${activity.filename || 'fichier Bryton'} le ${formatDate(dateStr)}`,
        date: dateStr,
        distance: activity.distance || 0,
        duration: activity.duration || 0,
        elevation: activity.elevationGain || 0,
        coordinates: activity.coordinates || [],
        source: 'bryton',
        filename: activity.filename || 'bryton_activity',
        isFavorite: false,
        createdAt: new Date().toISOString(),
        // Métadonnées Bryton pour la liaison
        brytonDate: dateStr,
        brytonIdx: activityIdx,
        heartRate: activity.heartRate,
        sport: activity.sport || 'cycling',
        cadence: activity.avgCadence,
        power: activity.avgPower
    };

    // Ajouter la catégorisation automatique
    const categorization = categorizeRoute(newRoute);
    Object.assign(newRoute, categorization);

    // Ajouter à la bibliothèque
    savedRoutes.push(newRoute);
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();

    // Mettre à jour l'interface
    updateRoutesList();
    updateBrytonActivities();

    showNotification(`✅ "${newRoute.name}" ajouté à votre bibliothèque !`, 'success');
}

// Importer toutes les activités Bryton comme parcours
window.importAllBrytonActivities = function() {
    let importedCount = 0;
    let skippedCount = 0;

    Object.keys(brytonActivities).forEach(dateStr => {
        brytonActivities[dateStr].forEach((activity, idx) => {
            // Vérifier si déjà importé
            const existingRoute = savedRoutes.find(route =>
                route.source === 'bryton' &&
                route.brytonDate === dateStr &&
                route.brytonIdx === idx
            );

            if (existingRoute) {
                skippedCount++;
                return;
            }

            // Créer le parcours
            const newRoute = {
                id: "route_" + Date.now() + "_" + importedCount,
                name: activity.name || `Activité du ${formatDate(dateStr)}`,
                description: `Importé depuis ${activity.filename || 'fichier Bryton'} le ${formatDate(dateStr)}`,
                date: dateStr,
                distance: activity.distance || 0,
                duration: activity.duration || 0,
                elevation: activity.elevationGain || 0,
                coordinates: activity.coordinates || [],
                source: 'bryton',
                filename: activity.filename || 'bryton_activity',
                isFavorite: false,
                createdAt: new Date().toISOString(),
                brytonDate: dateStr,
                brytonIdx: activityIdx,
                heartRate: activity.heartRate,
                sport: activity.sport || 'cycling',
                cadence: activity.avgCadence,
                power: activity.avgPower
            };

            // Ajouter la catégorisation
            const categorization = categorizeRoute(newRoute);
            Object.assign(newRoute, categorization);

            savedRoutes.push(newRoute);
            importedCount++;
        });
    });

    // Sauvegarder
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();

    // Mettre à jour l'interface
    updateRoutesList();
    updateBrytonActivities();

    showNotification(
        `🎉 Importation terminée : ${importedCount} parcours ajoutés, ${skippedCount} déjà présents`,
        importedCount > 0 ? 'success' : 'info'
    );
}

// Importer uniquement les activités Bryton des derniers X jours
window.importRecentBrytonActivities = function(days = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    let importedCount = 0;
    let skippedCount = 0;

    Object.keys(brytonActivities).forEach(dateStr => {
        const activityDate = new Date(dateStr);
        if (activityDate < cutoffDate) return; // Ignorer les anciennes activités

        brytonActivities[dateStr].forEach((activity, idx) => {
            // Vérifier si déjà importé
            const existingRoute = savedRoutes.find(route =>
                route.source === 'bryton' &&
                route.brytonDate === dateStr &&
                route.brytonIdx === idx
            );

            if (existingRoute) {
                skippedCount++;
                return;
            }

            // Créer le parcours
            const newRoute = {
                id: "route_" + Date.now() + "_" + importedCount,
                name: activity.name || `Activité du ${formatDate(dateStr)}`,
                description: `Importé depuis ${activity.filename || 'fichier Bryton'} le ${formatDate(dateStr)}`,
                date: dateStr,
                distance: activity.distance || 0,
                duration: activity.duration || 0,
                elevation: activity.elevationGain || 0,
                coordinates: activity.coordinates || [],
                source: 'bryton',
                filename: activity.filename || 'bryton_activity',
                isFavorite: false,
                createdAt: new Date().toISOString(),
                brytonDate: dateStr,
                brytonIdx: activityIdx,
                heartRate: activity.heartRate,
                sport: activity.sport || 'cycling',
                cadence: activity.avgCadence,
                power: activity.avgPower
            };

            // Ajouter la catégorisation
            const categorization = categorizeRoute(newRoute);
            Object.assign(newRoute, categorization);

            savedRoutes.push(newRoute);
            importedCount++;
        });
    });

    // Sauvegarder
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();

    // Mettre à jour l'interface
    updateRoutesList();
    updateBrytonActivities();

    showNotification(
        `🎉 Importation terminée : ${importedCount} parcours récents ajoutés, ${skippedCount} déjà présents`,
        importedCount > 0 ? 'success' : 'info'
    );
}

// Vérifier si une activité Bryton est déjà dans la bibliothèque
function isBrytonActivityInLibrary(dateStr, activityIdx) {
    return savedRoutes.some(route =>
        route.source === 'bryton' &&
        route.brytonDate === dateStr &&
        route.brytonIdx === activityIdx
    );
}

// Synchroniser les activités Bryton avec la bibliothèque
window.syncBrytonWithLibrary = function() {
    let syncCount = 0;

    // Parcourir toutes les activités Bryton
    Object.keys(brytonActivities).forEach(dateStr => {
        brytonActivities[dateStr].forEach((activity, idx) => {
            // Vérifier si cette activité est dans la bibliothèque
            const routeIndex = savedRoutes.findIndex(route =>
                route.source === 'bryton' &&
                route.brytonDate === dateStr &&
                route.brytonIdx === idx
            );

            if (routeIndex !== -1) {
                // Mettre à jour les données si nécessaire
                const route = savedRoutes[routeIndex];
                let needsUpdate = false;

                if (route.name !== activity.name && activity.name) {
                    route.name = activity.name;
                    needsUpdate = true;
                }

                if (route.distance !== activity.distance) {
                    route.distance = activity.distance || 0;
                    needsUpdate = true;
                }

                if (route.duration !== activity.duration) {
                    route.duration = activity.duration || 0;
                    needsUpdate = true;
                }

                if (route.elevation !== activity.elevationGain) {
                    route.elevation = activity.elevationGain || 0;
                    needsUpdate = true;
                }

                if (needsUpdate) {
                    // Recatégoriser avec les nouvelles données
                    const categorization = categorizeRoute(route);
                    Object.assign(route, categorization);
                    syncCount++;
                }
            }
        });
    });

    if (syncCount > 0) {
        localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
        scheduleRemoteSave();
        updateRoutesList();
        showNotification(`🔄 ${syncCount} parcours synchronisés avec les activités Bryton`, 'info');
    }
}

// Supprimer un parcours importé de Bryton
window.removeBrytonRouteFromLibrary = function(routeId) {
    if (!confirm("Êtes-vous sûr de vouloir supprimer ce parcours de votre bibliothèque ?")) return;

    const routeIndex = savedRoutes.findIndex(route => route.id === routeId);
    if (routeIndex === -1) return;

    const route = savedRoutes[routeIndex];

    // Supprimer de la bibliothèque
    savedRoutes.splice(routeIndex, 1);
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();

    // Mettre à jour l'interface
    updateRoutesList();
    updateBrytonActivities();

    if (selectedRouteId === routeId) {
        selectedRouteId = null;
        document.getElementById('routeDetailCard')?.classList.add('d-none');
        document.getElementById('routeEmptyState')?.classList.remove('d-none');
    }

    showNotification(`🗑️ "${route.name}" supprimé de votre bibliothèque`, 'success');
}

/* ========================================
   IMPORTATION STRAVA ET GPX
   ======================================== */

// Importer un parcours depuis Strava (avec instructions)
window.importStravaRoute = function() {
    console.log('🚴 importStravaRoute appelé');

    const instructions = `
🚴 COMMENT IMPORTER UN PARCOURS STRAVA :

ÉTAPE 1 - Exporter depuis Strava :
1. Connectez-vous à Strava.com sur votre ordinateur
2. Allez dans "Mes activités" ou "Mes parcours"
3. Cliquez sur l'activité/parcours à exporter
4. Cliquez sur le bouton "Export GPX" (icône de téléchargement)
5. Téléchargez le fichier .gpx

ÉTAPE 2 - Importer ici :
1. Cliquez sur "OK" ci-dessous
2. Sélectionnez votre fichier .gpx téléchargé
3. Le parcours sera automatiquement analysé et ajouté à votre bibliothèque !

✅ Le parcours sera catégorisé automatiquement selon ses caractéristiques.
    `;

    try {
        if (confirm(instructions)) {
            console.log('✅ Utilisateur a confirmé, ouverture du sélecteur de fichiers');
            // Ouvrir directement le sélecteur de fichiers
            const input = document.getElementById('gpxFileInput');
            if (input) {
                input.click();
                console.log('✅ Sélecteur de fichiers trouvé et cliqué');
            } else {
                console.error('❌ Sélecteur de fichiers gpxFileInput non trouvé');
                alert('Erreur: sélecteur de fichiers non disponible');
            }
        } else {
            console.log('❌ Utilisateur a annulé l\'importation');
        }
    } catch (error) {
        console.error('❌ Erreur dans importStravaRoute:', error);
        alert('Erreur lors de l\'importation: ' + error.message);
    }
};

// Importer un fichier GPX/TCX directement
window.importGPXFile = function() {
    console.log('📁 importGPXFile appelé');

    try {
        const input = document.getElementById('gpxFileInput');
        if (input) {
            console.log('✅ Sélecteur de fichiers trouvé, ouverture...');
            input.click();
        } else {
            console.error('❌ Sélecteur de fichiers gpxFileInput non trouvé');
            alert('Erreur: sélecteur de fichiers non disponible');
        }
    } catch (error) {
        console.error('❌ Erreur dans importGPXFile:', error);
        alert('Erreur lors de l\'importation: ' + error.message);
    }
};

// Traiter l'importation de fichier GPX/TCX
function processGPXFile(file) {
    const reader = new FileReader();

    reader.onload = function(e) {
        try {
            const content = e.target.result;
            let routeData = null;

            // Détecter le type de fichier et parser
            if (file.name.toLowerCase().endsWith('.gpx')) {
                routeData = parseGPXContent(content);
            } else if (file.name.toLowerCase().endsWith('.tcx')) {
                routeData = parseTCXContent(content);
            } else if (file.name.toLowerCase().endsWith('.fit')) {
                // Pour les fichiers FIT, utiliser le parser existant
                showNotification('Traitement du fichier FIT en cours...', 'info');
                // Utiliser la fonction existante pour les fichiers FIT
                handleFITFileImport(file);
                return;
            }

            if (routeData) {
                addImportedRouteToLibrary(routeData, file.name);
            } else {
                showNotification('Erreur: Impossible de parser le fichier', 'error');
            }
        } catch (error) {
            console.error('Erreur lors de la lecture du fichier:', error);
            showNotification('Erreur lors de la lecture du fichier: ' + error.message, 'error');
        }
    };

    reader.readAsText(file);
}

// Parser le contenu GPX
function parseGPXContent(content) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(content, 'text/xml');

    // Chercher les track points
    const trackPoints = xmlDoc.querySelectorAll('trkpt');
    if (trackPoints.length === 0) {
        // Chercher les route points
        const routePoints = xmlDoc.querySelectorAll('rtept');
        if (routePoints.length === 0) {
            return null;
        }

        // Parser route points
        const coordinates = [];
        let elevations = [];

        routePoints.forEach(point => {
            const lat = parseFloat(point.getAttribute('lat'));
            const lon = parseFloat(point.getAttribute('lon'));
            const ele = point.querySelector('ele');

            if (!isNaN(lat) && !isNaN(lon)) {
                coordinates.push([lon, lat]);
                if (ele) {
                    elevations.push(parseFloat(ele.textContent));
                }
            }
        });

        return {
            coordinates,
            elevations,
            name: xmlDoc.querySelector('name')?.textContent || file.name,
            distance: calculateDistance(coordinates),
            elevationGain: calculateElevationGain(elevations)
        };
    }

    // Parser track points
    const coordinates = [];
    let elevations = [];

    trackPoints.forEach(point => {
        const lat = parseFloat(point.getAttribute('lat'));
        const lon = parseFloat(point.getAttribute('lon'));
        const ele = point.querySelector('ele');

        if (!isNaN(lat) && !isNaN(lon)) {
            coordinates.push([lon, lat]);
            if (ele) {
                elevations.push(parseFloat(ele.textContent));
            }
        }
    });

    return {
        coordinates,
        elevations,
        name: xmlDoc.querySelector('name')?.textContent || file.name,
        distance: calculateDistance(coordinates),
        elevationGain: calculateElevationGain(elevations)
    };
}

// Parser le contenu TCX (version simplifiée)
function parseTCXContent(content) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(content, 'text/xml');

    const trackPoints = xmlDoc.querySelectorAll('Trackpoint');
    const coordinates = [];
    let elevations = [];

    trackPoints.forEach(point => {
        const latEl = point.querySelector('LatitudeDegrees');
        const lonEl = point.querySelector('LongitudeDegrees');
        const eleEl = point.querySelector('AltitudeMeters');

        if (latEl && lonEl) {
            const lat = parseFloat(latEl.textContent);
            const lon = parseFloat(lonEl.textContent);

            if (!isNaN(lat) && !isNaN(lon)) {
                coordinates.push([lon, lat]);
                if (eleEl) {
                    elevations.push(parseFloat(eleEl.textContent));
                }
            }
        }
    });

    return {
        coordinates,
        elevations,
        name: xmlDoc.querySelector('Activity')?.querySelector('Name')?.textContent || file.name,
        distance: calculateDistance(coordinates),
        elevationGain: calculateElevationGain(elevations)
    };
}

// Calculer la distance à partir des coordonnées
function calculateDistance(coordinates) {
    if (coordinates.length < 2) return 0;

    let totalDistance = 0;
    for (let i = 1; i < coordinates.length; i++) {
        const [lon1, lat1] = coordinates[i - 1];
        const [lon2, lat2] = coordinates[i];

        // Calcul de distance Haversine simplifié
        const R = 6371000; // Rayon de la Terre en mètres
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;

        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);

        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        totalDistance += R * c;
    }

    return totalDistance / 1000; // Convertir en km
}

// Calculer le dénivelé positif
function calculateElevationGain(elevations) {
    if (elevations.length < 2) return 0;

    let totalGain = 0;
    for (let i = 1; i < elevations.length; i++) {
        if (elevations[i] > elevations[i-1]) {
            totalGain += elevations[i] - elevations[i-1];
        }
    }

    return Math.round(totalGain);
}

// Ajouter un parcours importé à la bibliothèque
function addImportedRouteToLibrary(routeData, filename) {
    const newRoute = {
        id: "route_" + Date.now(),
        name: routeData.name || `Parcours importé le ${new Date().toLocaleDateString()}`,
        description: `Importé depuis ${filename}`,
        date: new Date().toISOString().split('T')[0],
        distance: routeData.distance || 0,
        duration: Math.round((routeData.distance || 0) * 3), // Estimation: 3 min/km
        elevation: routeData.elevationGain || 0,
        coordinates: routeData.coordinates || [],
        source: 'import',
        filename: filename,
        isFavorite: false,
        createdAt: new Date().toISOString()
    };

    // Ajouter la catégorisation automatique
    const categorization = categorizeRoute(newRoute);
    Object.assign(newRoute, categorization);

    // Ajouter à la bibliothèque
    savedRoutes.push(newRoute);
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();

    // Mettre à jour l'interface
    updateRoutesList();

    showNotification(`✅ "${newRoute.name}" (${newRoute.distance.toFixed(1)}km) ajouté à votre bibliothèque !`, 'success');
}

// Gérer l'importation de fichiers FIT (utiliser la fonction existante)
function handleFITFileImport(file) {
    // Utiliser l'input de fichier existant
    const fitInput = document.getElementById('mapFileInput');
    if (fitInput) {
        // Créer un DataTransfer pour simuler la sélection
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fitInput.files = dataTransfer.files;

        // Déclencher l'événement change
        const event = new Event('change', { bubbles: true });
        fitInput.dispatchEvent(event);
    }
}

// Initialiser l'écouteur d'événement pour l'input de fichier
document.addEventListener('DOMContentLoaded', function() {
    const gpxInput = document.getElementById('gpxFileInput');
    if (gpxInput) {
        gpxInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                showNotification('Traitement du fichier en cours...', 'info');
                processGPXFile(file);
            }
        });
    }
});

// Afficher un parcours sur la carte
function showSelectedRoute() {
    const route = savedRoutes.find(r => r.id === selectedRouteId);
    if (!route) return;

    const geojson = buildGeoJSONFromCoordinates(route.coordinates);

    updateMapWithTrack(geojson, {
        distanceKm: route.distance,
        durationMin: route.duration,
        speedKmH: route.duration > 0 ? route.distance / (route.duration/60) : 0,
        elevationGain: route.elevation
    });

    currentRouteCoordinates = route.coordinates;
    currentRouteMetadata = {
        distanceKm: route.distance,
        durationMin: route.duration,
        elevationGain: route.elevation,
        source: route.source,
        filename: route.filename,
        name: route.name
    };
}

// Supprimer un parcours
function deleteSelectedRoute() {
    if (!selectedRouteId) return;

    if (!confirm("Êtes-vous sûr de vouloir supprimer ce parcours ?")) return;

    savedRoutes = savedRoutes.filter(r => r.id !== selectedRouteId);
    localStorage.setItem('savedRoutes', JSON.stringify(savedRoutes));
    scheduleRemoteSave();

    selectedRouteId = null;
    document.getElementById('routeDetailCard').classList.add('d-none');
    document.getElementById('routeEmptyState').classList.remove('d-none');

    updateRoutesList();
    alert("✅ Parcours supprimé !");
}

// Fonctions utilitaires pour les parcours
function formatDistance(distance) {
    return distance ? `${distance.toFixed(1)} km` : "N/A";
}

function formatDurationSimple(minutes) {
    if (!minutes) return "N/A";
    const h = Math.floor(minutes/60);
    const m = Math.round(minutes % 60);
    return h > 0 ? `${h}h${m > 0 ? m : ''}` : `${m} min`;
}

function getSourceLabel(source) {
    const labels = {
        "fit": "Fichier FIT",
        "gpx": "Fichier GPX",
        "tcx": "Fichier TCX",
        "manual": "Manuel"
    };
    return labels[source] || source;
}

/* ========================================
   FONCTIONS D'IMPORT/EXPORT JSON
   ======================================== */

// Importer des exercices depuis JSON
async function importExercisesFromJson(file) {
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        let sessions = null;
        if (data.sessions && typeof data.sessions === 'object') {
            sessions = data.sessions;
        } else if (data.trainingProgram?.sessions && typeof data.trainingProgram.sessions === 'object') {
            sessions = data.trainingProgram.sessions;
        }

        if (!sessions) {
            alert("❌ Le fichier JSON doit contenir un objet 'sessions' (soit à la racine, soit dans 'trainingProgram').");
            return;
        }

        let sessionsAdded = 0;
        let sessionsUpdated = 0;

        Object.entries(sessions).forEach(([dateStr, session]) => {
            if (trainingProgramData.sessions[dateStr]) {
                trainingProgramData.sessions[dateStr] = {
                    ...trainingProgramData.sessions[dateStr],
                    ...session
                };
                sessionsUpdated++;
            } else {
                trainingProgramData.sessions[dateStr] = session;
                sessionsAdded++;
            }
        });

        if (data.trainingProgram?.program_info) {
            const incoming = data.trainingProgram.program_info;
            trainingProgramData.program_info = {
                ...(trainingProgramData.program_info || {}),
                ...incoming,
                cyclist_profile: {
                    ...(trainingProgramData.program_info?.cyclist_profile || {}),
                    ...(incoming.cyclist_profile || {})
                }
            };
        }

        saveAllDataToLocalStorage();
        scheduleRemoteSave();
        updateMonthlyPlan();

        const messageParts = [];
        if (sessionsAdded) messageParts.push(`${sessionsAdded} nouvelle(s) session(s) ajoutée(s)`);
        if (sessionsUpdated) messageParts.push(`${sessionsUpdated} session(s) mise(s) à jour`);
        alert(`✅ Import terminé : ${messageParts.join(' | ') || 'aucune session traitée.'}`);
    } catch (error) {
        console.error("Import JSON échoué :", error);
        alert("❌ Impossible de lire ce fichier. Vérifie qu'il s'agit bien d'un JSON valide.");
    } finally {
        const input = document.getElementById('exerciseJsonInput');
        if (input) input.value = '';
    }
}

/* ========================================
   FONCTIONS DE NAVIGATION
   ======================================== */

// Navigation rapide via la sidebar
function initQuickNavigation() {
    const quickNavButtons = document.querySelectorAll('.quick-nav-btn');

    quickNavButtons.forEach(btn => {
        btn.addEventListener('click', function() {
            const targetTabId = this.getAttribute('data-target');
            const targetTab = document.getElementById(targetTabId);

            if (targetTab) {
                $(targetTab).tab('show');

                setTimeout(() => {
                    window.scrollTo({
                        top: 0,
                        behavior: 'smooth'
                    });
                }, 100);
            }
        });
    });
}

// Générer le mini calendrier de navigation
function generateMiniCalendar() {
    const selectedMonth = document.getElementById('monthSelector').value;
    if (!selectedMonth) return;

    const [year, month] = selectedMonth.split('-').map(Number);
    const daysInMonth = getDaysInMonth(year, month - 1);
    const firstDay = new Date(year, month - 1, 1);

    const firstDayOfMonth = firstDay.getDay() || 7;

    const miniCalContainer = document.getElementById('miniCalendarWeeks');
    miniCalContainer.innerHTML = '';

    let currentWeek = 1;
    let dayCounter = 1;

    let startOffset = firstDayOfMonth - 1;

    while (dayCounter <= daysInMonth) {
        const weekStart = dayCounter;
        let weekEnd = Math.min(weekStart + 6 - startOffset, daysInMonth);

        const weekBtn = document.createElement('button');
        weekBtn.className = 'mini-week-btn';
        weekBtn.setAttribute('data-week', currentWeek);

        const today = new Date();
        const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month - 1;
        const todayDate = today.getDate();
        const isCurrentWeek = isCurrentMonth && todayDate >= weekStart && todayDate <= weekEnd;

        if (isCurrentWeek) {
            weekBtn.classList.add('current');
        }

        const weekStartFormatted = `${weekStart.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}`;
        const weekEndFormatted = `${weekEnd.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}`;

        weekBtn.innerHTML = `
            <span>Semaine ${currentWeek}</span>
            <span class="week-dates">${weekStartFormatted} - ${weekEndFormatted}</span>
        `;

        weekBtn.addEventListener('click', function() {
            scrollToWeek(currentWeek);
        });

        miniCalContainer.appendChild(weekBtn);

        dayCounter = weekEnd + 1;
        currentWeek++;
        startOffset = 0;
    }
}

// Scroller vers une semaine spécifique
function scrollToWeek(weekNumber) {
    $('#tab-dashboard-link').tab('show');

    setTimeout(() => {
        const weekRows = document.querySelectorAll('#monthlyPlanTable table tbody tr');
        if (weekRows.length === 0) return;

        const rowsPerWeek = 7;
        const targetIndex = (weekNumber - 1) * rowsPerWeek;

        if (targetIndex < weekRows.length) {
            const targetRow = weekRows[targetIndex];

            targetRow.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });

            targetRow.classList.add('highlight-row');
            setTimeout(() => {
                targetRow.classList.remove('highlight-row');
            }, 2000);
        }
    }, 300);
}

/* ========================================
   FONCTIONS D'ANALYSE
   ======================================== */

// Mettre à jour les graphiques d'analyse - VERSION SIMPLE ET EFFICACE
function updateAnalysisCharts() {
    const monthSelector = document.getElementById('monthSelector');
    const selectedMonth = monthSelector ? monthSelector.value : new Date().toISOString().substring(0, 7);
    const [year, month] = selectedMonth.split('-').map(Number);

    // Générer tous les jours du mois sélectionné
    const dates = [];
    const lastDay = new Date(year, month, 0).getDate();
    for (let day = 1; day <= lastDay; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        dates.push(dateStr);
    }

    const planned = [];
    const actual = [];
    const planIntensities = { 'Légère': 0, 'Modérée': 0, 'Élevée': 0, 'Très élevée': 0 };
    const actualIntensities = { 'Légère': 0, 'Modérée': 0, 'Élevée': 0, 'Très élevée': 0 };

    let totalPlannedMinutes = 0;
    let totalActualMinutes = 0;
    let totalPlannedDistance = 0;
    let totalActualDistance = 0;

    // Pour chaque jour du mois
    dates.forEach(dateStr => {
        const session = trainingProgramData.sessions[dateStr];
        const planMin = session ? session.duration_minutes : 0;
        planned.push(planMin);
        totalPlannedMinutes += planMin;

        if (session && session.intensity) {
            planIntensities[session.intensity] = (planIntensities[session.intensity] || 0) + planMin;
        }

        // Récupérer TOUTES les séances réalisées pour cette date
        let actualMin = 0;
        let actualDist = 0;

        // 1. Séances cochées manuellement (PRIORITÉ)
        const progress = userProgress[dateStr];
        if (progress && progress.completed) {
            const duration = progress.actualDuration || 60; // 60 min par défaut si non spécifié
            const distance = parseFloat(progress.distance || 0);

            actualMin += duration;
            actualDist += distance;

            // Ajouter aux intensités
            const intensity = session ? session.intensity : 'Modérée';
            actualIntensities[intensity] = (actualIntensities[intensity] || 0) + duration;
        }

        // 2. Activités Bryton (en plus des séances cochées)
        const bryton = brytonActivities[dateStr];
        if (bryton && bryton.length > 0) {
            bryton.forEach(act => {
                actualMin += act.duration || 0;
                actualDist += act.distance || 0;

                const hr = act.heartRate;
                if (hr) {
                    const maxHR = trainingProgramData?.program_info?.cyclist_profile?.max_heart_rate || 170;
                    const pct = Math.round((hr / maxHR) * 100);
                    const intensity = estimateIntensityFromHR(pct);
                    actualIntensities[intensity] = (actualIntensities[intensity] || 0) + (act.duration || 0);
                } else {
                    const intensity = session ? session.intensity : 'Modérée';
                    actualIntensities[intensity] = (actualIntensities[intensity] || 0) + (act.duration || 0);
                }
            });
        }

        actual.push(actualMin);
        totalActualMinutes += actualMin;
        totalActualDistance += actualDist;
    });

    createDurationComparisonChart(dates, planned, actual);
    createIntensityComparisonChart(planIntensities, actualIntensities);

    updateAnalysisRecap(
        totalPlannedMinutes,
        totalActualMinutes,
        totalPlannedDistance,
        totalActualDistance
    );
}

// Créer le graphique de comparaison de durée
function createDurationComparisonChart(dates, planned, actual) {
    const ctx = document.getElementById('durationComparisonChart').getContext('2d');

    if (window.durationChart) {
        window.durationChart.destroy();
    }

    window.durationChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dates.map(d => formatShortDate(d)),
            datasets: [
                {
                    label: 'Plan (min)',
                    backgroundColor: 'rgba(54, 162, 235, 0.5)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1,
                    data: planned
                },
                {
                    label: 'Réalisé (min)',
                    backgroundColor: 'rgba(255, 99, 132, 0.5)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    borderWidth: 1,
                    data: actual
                }
            ]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    stacked: false,
                    title: {
                        display: true,
                        text: 'Date'
                    }
                },
                y: {
                    stacked: false,
                    title: {
                        display: true,
                        text: 'Minutes'
                    }
                }
            },
            plugins: {
                title: {
                    display: true,
                    text: 'Plan vs. Réalisé (Durée)'
                }
            }
        }
    });
}

// Créer le graphique de comparaison d'intensité
function createIntensityComparisonChart(planned, actual) {
    const ctx = document.getElementById('intensityComparisonChart').getContext('2d');

    if (window.intensityChart) {
        window.intensityChart.destroy();
    }

    const intensities = Object.keys(planned);

    window.intensityChart = new Chart(ctx, {
        type: 'radar',
        data: {
            labels: intensities,
            datasets: [
                {
                    label: 'Plan (min)',
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    pointBackgroundColor: 'rgba(54, 162, 235, 1)',
                    data: intensities.map(i => planned[i] || 0)
                },
                {
                    label: 'Réalisé (min)',
                    backgroundColor: 'rgba(255, 99, 132, 0.2)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    pointBackgroundColor: 'rgba(255, 99, 132, 1)',
                    data: intensities.map(i => actual[i] || 0)
                }
            ]
        },
        options: {
            responsive: true,
            plugins: {
                title: {
                    display: true,
                    text: 'Distribution d\'intensité'
                }
            }
        }
    });
}

// Mettre à jour le récapitulatif d'analyse
function updateAnalysisRecap(plannedMin, actualMin, plannedDist, actualDist) {
    const recap = document.getElementById('analysisRecap');
    if (!recap) return;

    const minDiff = actualMin - plannedMin;
    const minPct = plannedMin > 0 ? Math.round((minDiff / plannedMin) * 100) : 0;
    const minClass = minDiff >= 0 ? 'text-success' : 'text-danger';

    const distDiff = actualDist - plannedDist;
    const distPct = plannedDist > 0 ? Math.round((distDiff / plannedDist) * 100) : 0;
    const distClass = distDiff >= 0 ? 'text-success' : 'text-danger';

    const tssPlanned = calculateTotalTSS(true);
    const tssActual = calculateTotalTSS(false);
    const tssDiff = tssActual - tssPlanned;
    const tssPct = tssPlanned > 0 ? Math.round((tssDiff / tssPlanned) * 100) : 0;
    const tssClass = tssDiff >= 0 ? 'text-success' : 'text-danger';

    recap.innerHTML = `
        <tr>
            <td>Durée totale</td>
            <td>${Math.round(plannedMin)} min (${Math.round(plannedMin / 60)} h)</td>
            <td>${Math.round(actualMin)} min (${Math.round(actualMin / 60)} h)</td>
            <td class="${minClass}">${minDiff > 0 ? '+' : ''}${Math.round(minDiff)} min (${minPct > 0 ? '+' : ''}${minPct}%)</td>
        </tr>
        <tr>
            <td>Distance totale</td>
            <td>${Math.round(plannedDist)} km</td>
            <td>${Math.round(actualDist)} km</td>
            <td class="${distClass}">${distDiff > 0 ? '+' : ''}${Math.round(distDiff)} km (${distPct > 0 ? '+' : ''}${distPct}%)</td>
        </tr>
        <tr>
            <td>TSS total</td>
            <td>${tssPlanned}</td>
            <td>${tssActual}</td>
            <td class="${tssClass}">${tssDiff > 0 ? '+' : ''}${tssDiff} (${tssPct > 0 ? '+' : ''}${tssPct}%)</td>
        </tr>
    `;
}

// Calculer le TSS total
function calculateTotalTSS(planned) {
    let total = 0;

    if (planned) {
        Object.keys(trainingProgramData.sessions || {}).forEach(dateStr => {
            const session = trainingProgramData.sessions[dateStr];
            if (session) {
                total += calculateTSS(session, {});
            }
        });
    } else {
        Object.keys(brytonActivities).forEach(dateStr => {
            brytonActivities[dateStr].forEach(act => {
                const session = trainingProgramData.sessions[dateStr] || {
                    intensity: estimateIntensityFromHR(act.heartRate),
                    duration_minutes: act.duration
                };
                total += calculateTSS(session, {
                    actualDuration: act.duration,
                    actualHeartRate: act.heartRate
                });
            });
        });

        Object.keys(userProgress).forEach(dateStr => {
            if (!brytonActivities[dateStr] && userProgress[dateStr].completed) {
                const session = trainingProgramData.sessions[dateStr];
                if (session) {
                    total += calculateTSS(session, userProgress[dateStr]);
                }
            }
        });
    }

    return Math.round(total);
}

// Helper pour dates courtes
function formatShortDate(dateStr) {
    const date = new Date(dateStr);
    return `${date.getDate()}/${date.getMonth() + 1}`;
}

/* ========================================
   STRAVA-LIKE ACTIVITY VIEWER
   ======================================== */

let stravaMapInstance = null;
let stravaRouteSource = 'strava-route';
let stravaRouteLayer = 'strava-route-line';
let stravaCharts = {
    combinedChart: null,
    elevation: null
};
let stravaCursorMarker = null;

function ensureStravaCursorMarker() {
    if (!stravaCursorMarker && stravaMapInstance) {
        const el = document.createElement('div');
        el.className = 'strava-map-cursor';
        stravaCursorMarker = new maplibregl.Marker({ element: el });
    }
}

function updateStravaCursorMarker(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !stravaMapInstance) return;
    ensureStravaCursorMarker();
    stravaCursorMarker.setLngLat([lon, lat]).addTo(stravaMapInstance);
}

function hideStravaCursorMarker() {
    if (stravaCursorMarker) {
        stravaCursorMarker.remove();
    }
}

function getStravaTooltipElement() {
    return document.getElementById('stravaHoverTooltip');
}

function initStravaMap() {
    if (stravaMapInstance) return;

    stravaMapInstance = new maplibregl.Map({
        container: 'stravaMap',
        style: 'https://api.maptiler.com/maps/outdoor/style.json?key=DBpqQ6T5hG4BtWFxxUMr',
        center: [-3.3, 34.0],
        zoom: 9
    });

    stravaMapInstance.addControl(new maplibregl.NavigationControl(), 'top-right');
    stravaMapInstance.on('load', () => {
        stravaMapInstance.addSource(stravaRouteSource, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });

        stravaMapInstance.addLayer({
            id: stravaRouteLayer,
            type: 'line',
            source: stravaRouteSource,
            paint: {
                'line-color': '#ff5c5c',
                'line-width': 4,
                'line-opacity': 0.85
            }
        });
    });
}

function buildStravaActivityList() {
    const listEl = document.getElementById('stravaActivityList');
    if (!listEl) return;

    const dates = Object.keys(brytonActivities || {}).sort().reverse();
    if (dates.length === 0) {
        listEl.innerHTML = '<li>Aucune activité importée</li>';
        return;
    }

    const items = [];
    dates.forEach(dateStr => {
        brytonActivities[dateStr].forEach((activity, idx) => {
            const distanceKm = (activity.distance || 0).toFixed(1);
            const durationMin = activity.duration || 0;
            const hours = Math.floor(durationMin / 60);
            const mins = String(durationMin % 60).padStart(2, '0');

            items.push(`
                <li data-date="${dateStr}" data-index="${idx}">
                    <div>
                        <strong>${formatDate(dateStr)}</strong><br>
                        <small>${activity.name || activity.filename || 'Sortie vélo'}</small>
                    </div>
                    <div class="text-right">
                        <span>${distanceKm} km</span><br>
                        <small>${hours}h${mins}</small>
                    </div>
                </li>
            `);
        });
    });

    listEl.innerHTML = items.join('');
    listEl.querySelectorAll('li').forEach(li => {
        li.addEventListener('click', () => {
            listEl.querySelectorAll('li').forEach(item => item.classList.remove('active'));
            li.classList.add('active');
            const { date, index } = li.dataset;
            renderStravaActivity(date, Number(index));
        });
    });

    // auto-sélectionner la plus récente
    const first = listEl.querySelector('li');
    if (first) {
        first.classList.add('active');
        renderStravaActivity(first.dataset.date, Number(first.dataset.index));
    }
}

function refreshMapWithCoordinates(coordinates) {
    if (!stravaMapInstance || !stravaMapInstance.getSource(stravaRouteSource)) return;

    if (coordinates.length >= 2) {
        stravaMapInstance.getSource(stravaRouteSource).setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coordinates }
            }]
        });

        const bounds = coordinates.reduce(
            (b, coord) => b.extend(coord),
            new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
        );
        stravaMapInstance.fitBounds(bounds, { padding: 40, maxZoom: 15 });
    }
}

function renderStravaActivity(dateStr, idx) {
    const activity = brytonActivities[dateStr]?.[idx];
    if (!activity) return;

    // 1. Carte
    initStravaMap();
    const coords = activity.coordinates || currentRouteCoordinates || [];
    if (coords.length >= 2 && stravaMapInstance?.getSource(stravaRouteSource)) {
        stravaMapInstance.getSource(stravaRouteSource).setData({
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords }
            }]
        });

        const bounds = coords.reduce(
            (b, coord) => b.extend(coord),
            new maplibregl.LngLatBounds(coords[0], coords[0])
        );
        stravaMapInstance.fitBounds(bounds, { padding: 40, maxZoom: 15 });
    }

    // 2. Métriques principales
    const durationMin = activity.duration || 0;
    const hours = Math.floor(durationMin / 60);
    const mins = String(durationMin % 60).padStart(2, '0');
    const seconds = String(Math.round((durationMin % 1) * 60)).padStart(2, '0');

    document.getElementById('stravaDistance').textContent =
        `${(activity.distance || 0).toFixed(1)} km`;
    document.getElementById('stravaDuration').textContent =
        `${hours}:${mins}:${seconds}`;
    document.getElementById('stravaElevation').textContent =
        `${Math.round(activity.elevationGain || 0)} m`;
    document.getElementById('stravaHrAvg').textContent =
        activity.heartRate ? `${Math.round(activity.heartRate)} bpm` : '—';
    document.getElementById('stravaPowerAvg').textContent =
        activity.power ? `${Math.round(activity.power)} W` : '—';

    // 3. Résumé
    document.getElementById('stravaDate').textContent = formatDate(dateStr);
    document.getElementById('stravaType').textContent = activity.sport || 'Cyclisme';
    document.getElementById('stravaWeather').textContent = activity.weather || 'N/A';
    document.getElementById('stravaFeel').textContent = activity.feel || '—';
    document.getElementById('stravaNotes').textContent =
        activity.notes || (userProgress[dateStr]?.notes) || 'Aucune note.';

    // 4. Graphiques
    const { labels: distanceLabels, altitude: elevationData, speed: speedData, heartRate: heartRateData } =
        buildElevationProfile(activity.timeSeries);

    renderStravaCombinedChart(distanceLabels, speedData, heartRateData, elevationData, activity);
    renderStravaElevationChart(distanceLabels, elevationData);
}

function buildElevationProfile(timeSeries = []) {
    if (!timeSeries.length) return { labels: [], altitude: [], speed: [], heartRate: [] };

    const labels = [];
    const altitude = [];
    const speed = [];
    const heartRate = [];
    let lastValidAlt = null;
    let lastValidSpeed = null;
    let lastValidHR = null;

    timeSeries.forEach(point => {
        // Distance
        if (typeof point.distance === 'number') {
            const distKm = point.distance / 1000;
            labels.push(distKm);
        } else if (labels.length) {
            labels.push(labels[labels.length - 1]);
        } else {
            labels.push(0);
        }

        // Altitude
        if (typeof point.altitude === 'number') {
            altitude.push(point.altitude);
            lastValidAlt = point.altitude;
        } else {
            altitude.push(lastValidAlt ?? 0);
        }

        // Vitesse
        if (typeof point.speed === 'number') {
            const kmh = point.speed * 3.6;
            speed.push(kmh);
            lastValidSpeed = kmh;
        } else {
            speed.push(lastValidSpeed ?? 0);
        }

        // Fréquence cardiaque
        if (typeof point.heartRate === 'number') {
            heartRate.push(point.heartRate);
            lastValidHR = point.heartRate;
        } else {
            heartRate.push(lastValidHR ?? 0);
        }
    });

    return { labels, altitude, speed, heartRate };
}

function renderStravaElevationChart(labels, altitude) {
    if (stravaCharts.elevation) {
        stravaCharts.elevation.destroy();
    }

    const canvas = document.getElementById('stravaElevationChart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    stravaCharts.elevation = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Altitude (m)',
                data: altitude,
                borderColor: '#6C63FF',
                backgroundColor: '#6C63FF20',
                borderWidth: 2,
                fill: true,
                pointRadius: 0,
                tension: 0.35
            }]
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                x: {
                    ticks: {
                        callback: (_, index) => `${labels[index].toFixed(1)} km`
                    },
                    grid: { display: false }
                },
                y: {
                    grid: { color: 'rgba(0,0,0,0.08)' },
                    ticks: {
                        callback: value => `${Math.round(value)} m`
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => `${items[0].label.toFixed(1)} km`,
                        label: item => `${Math.round(item.parsed.y)} m`
                    }
                }
            }
        }
    });
}

// Plugin pour dessiner une ligne verticale sur le graphique
const verticalLinePlugin = {
    id: 'verticalLine',
    afterDraw(chart) {
        const tooltip = chart.tooltip;
        if (!tooltip?.getActiveElements().length) return;

        const ctx = chart.ctx;
        const activePoint = tooltip.getActiveElements()[0];
        const x = activePoint.element.x;
        const topY = chart.chartArea.top;
        const bottomY = chart.chartArea.bottom;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(x, bottomY);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#ff5c5c';
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
    }
};

// Fonction pour dessiner le graphique combiné (FC, Vitesse, Altitude)
function renderStravaCombinedChart(labels, speedData, heartRateData, elevationData, activity) {
    if (stravaCharts.combinedChart) {
        stravaCharts.combinedChart.destroy();
    }

    const tooltipHandler = createStravaTooltipHandler(activity);

    stravaCharts.combinedChart = new Chart(
        document.getElementById('stravaCombinedChart').getContext('2d'),
        {
            type: 'line',
            plugins: [verticalLinePlugin],
            data: {
                labels,
                datasets: [
                    {
                        label: 'Altitude',
                        data: elevationData,
                        borderColor: '#6C63FF',
                        backgroundColor: '#6C63FF20',
                        borderWidth: 2,
                        fill: true,
                        pointRadius: 0,
                        tension: 0.35,
                        yAxisID: 'y-elevation'
                    },
                    {
                        label: 'Vitesse',
                        data: speedData,
                        borderColor: '#FFC107',
                        backgroundColor: '#FFC10720',
                        borderWidth: 2,
                        fill: false,
                        pointRadius: 0,
                        tension: 0.35,
                        yAxisID: 'y-speed'
                    },
                    {
                        label: 'Fréquence Cardiaque',
                        data: heartRateData,
                        borderColor: '#F44336',
                        backgroundColor: '#F4433620',
                        borderWidth: 2,
                        fill: false,
                        pointRadius: 0,
                        tension: 0.35,
                        yAxisID: 'y-heartRate'
                    }
                ]
            },
            options: {
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                onHover: (event, elements) => {
                    event.native.target.style.cursor = elements.length ? 'crosshair' : 'default';
                    if (!elements.length) {
                        getStravaTooltipElement().classList.remove('visible');
                        hideStravaCursorMarker();
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            callback: value => `${labels[value].toFixed(1)} km`
                        },
                        grid: { display: false }
                    },
                    'y-elevation': {
                        type: 'linear',
                        position: 'left',
                        title: { display: true, text: 'Altitude (m)', color: '#6C63FF' },
                        ticks: { color: '#6C63FF' },
                        grid: { color: 'rgba(0,0,0,0.08)' }
                    },
                    'y-speed': {
                        type: 'linear',
                        position: 'right',
                        title: { display: true, text: 'Vitesse (km/h)', color: '#FFC107' },
                        ticks: { color: '#FFC107' },
                        grid: { display: false },
                        min: 0
                    },
                    'y-heartRate': {
                        type: 'linear',
                        position: 'right',
                        offset: true,
                        title: { display: true, text: 'FC (bpm)', color: '#F44336' },
                        ticks: { color: '#F44336' },
                        grid: { display: false },
                        min: 0
                    }
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top'
                    },
                    tooltip: {
                        enabled: false,
                        external: tooltipHandler
                    }
                }
            }
        }
    );

    // Sauvegarde l'activité pour un éventuel usage futur
    stravaCharts.combinedChart.$activity = activity;
}

// Helper pour créer le gestionnaire de tooltip
function createStravaTooltipHandler(activity) {
    const tooltipEl = getStravaTooltipElement();

    return (context) => {
        const tooltip = context.tooltip;

        if (!tooltip || tooltip.opacity === 0) {
            tooltipEl.classList.remove('visible');
            hideStravaCursorMarker();
            return;
        }

        const dataIndex = tooltip.dataPoints?.[0]?.dataIndex ?? 0;
        const point = activity.timeSeries?.[dataIndex];

        if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
            updateStravaCursorMarker(point.lat, point.lon);
        } else {
            hideStravaCursorMarker();
        }

        const distanceKm = (point?.distance ?? 0) / 1000;
        const altitude = point?.altitude ?? tooltip.dataPoints?.[0]?.parsed?.y ?? 0;
        const speed = point?.speed != null ? point.speed * 3.6 : null;
        const heart = point?.heartRate ?? null;

        tooltipEl.innerHTML = `
            <div style="font-weight:600; margin-bottom:6px;">${distanceKm.toFixed(2)} km</div>
            <div style="display:flex;justify-content:space-between;"><span>Altitude</span><span>${Math.round(altitude)} m</span></div>
            <div style="display:flex;justify-content:space-between;"><span>Vitesse</span><span>${speed ? speed.toFixed(1) : '—'} km/h</span></div>
            <div style="display:flex;justify-content:space-between;"><span>Fréquence</span><span>${heart ?? '—'} bpm</span></div>
        `;

        const canvasRect = context.chart.canvas.getBoundingClientRect();
        const left = canvasRect.left + window.scrollX + tooltip.caretX;
        const top = canvasRect.top + window.scrollY + tooltip.caretY;

        tooltipEl.style.left = `${left}px`;
        tooltipEl.style.top = `${top}px`;
        tooltipEl.classList.add('visible');
    };
}

// Bouton export PNG
function initStravaExport() {
    const btn = document.getElementById('stravaExportBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const container = document.querySelector('.strava-main');
        if (!container) return;
        const canvas = await html2canvas(container);
        const link = document.createElement('a');
        link.download = `strava-export-${Date.now()}.png`;
        link.href = canvas.toDataURL();
        link.click();
    });
}

/* ========================================
   NETTOYAGE DES DOUBLONS D'ACTIVITÉS
   ======================================== */

function cleanDuplicateActivities() {
    if (!confirm("Êtes-vous sûr de vouloir nettoyer les activités en double ?\nCette action est irréversible.")) {
        return;
    }

    let removedCount = 0;
    const duplicates = new Set();

    // Parcourir toutes les dates
    Object.keys(brytonActivities).forEach(dateStr => {
        const activities = brytonActivities[dateStr];
        
        // Comparer chaque activité avec les autres
        for (let i = 0; i < activities.length; i++) {
            for (let j = i + 1; j < activities.length; j++) {
                const act1 = activities[i];
                const act2 = activities[j];
                
                // Vérifier si les activités sont similaires
                if (areActivitiesSimilar(act1, act2)) {
                    // Garder la plus récente (la plus grande date d'import)
                    if (new Date(act1.importTime) < new Date(act2.importTime)) {
                        duplicates.add(`${dateStr}_${i}`);
                    } else {
                        duplicates.add(`${dateStr}_${j}`);
                    }
                }
            }
        }
    });

    // Supprimer les doublons
    duplicates.forEach(duplicateKey => {
        const [dateStr, index] = duplicateKey.split('_');
        const idx = parseInt(index);
        
        if (brytonActivities[dateStr] && brytonActivities[dateStr][idx]) {
            brytonActivities[dateStr].splice(idx, 1);
            removedCount++;
            
            // Si plus d'activités pour cette date, supprimer la clé
            if (brytonActivities[dateStr].length === 0) {
                delete brytonActivities[dateStr];
            }
        }
    });

    // Sauvegarder les changements
    saveAllDataToLocalStorage();
    scheduleRemoteSave();
    
    // Rafraîchir l'affichage
    updateBrytonActivities();
    buildStravaActivityList();
    
    alert(`✅ Nettoyage terminé : ${removedCount} doublon(s) supprimé(s).`);
}

function areActivitiesSimilar(act1, act2) {
    // Critères de similarité
    const durationDiff = Math.abs((act1.duration || 0) - (act2.duration || 0));
    const distanceDiff = Math.abs((act1.distance || 0) - (act2.distance || 0));
    
    // Si la durée et la distance sont très similaires (moins de 5% de différence)
    const durationThreshold = Math.max(act1.duration || 0, act2.duration || 0) * 0.05;
    const distanceThreshold = Math.max(act1.distance || 0, act2.distance || 0) * 0.05;
    
    if (durationDiff < durationThreshold && distanceDiff < distanceThreshold) {
        // Vérifier également les coordonnées si disponibles
        if (act1.coordinates && act2.coordinates && act1.coordinates.length > 0 && act2.coordinates.length > 0) {
            const coordDiff = Math.abs(act1.coordinates.length - act2.coordinates.length);
            const coordThreshold = Math.max(act1.coordinates.length, act2.coordinates.length) * 0.1;
            
            if (coordDiff < coordThreshold) {
                return true;
            }
        } else {
            // Si pas de coordonnées, se baser sur durée et distance
            return true;
        }
    }
    
    return false;
}

/* ========================================
   INITIALISATION ET GESTIONNAIRES D'ÉVÉNEMENTS
   ======================================== */

// Initialisation au chargement de la page
document.addEventListener('DOMContentLoaded', function() {
    console.log("🚀 Démarrage rapide de l'application...");

    // Phase 1: Chargement immédiat des données locales (non bloquant)
    loadLocalDataFast();

    // Phase 2: Initialisation UI immédiate
    initializeUIFast();

    // Phase 3: Firebase en arrière-plan (non bloquant)
    setTimeout(() => initializeFirebaseSlow(), 1000);
});

// Phase 1: Chargement ultra-rapide des données locales
function loadLocalDataFast() {
    // Initialiser trainingProgramData avec une structure par défaut
    trainingProgramData = {
        program_info: {},
        sessions: {}
    };

    // Charger les données sauvegardées de manière optimisée
    try {
        const savedData = localStorage.getItem('trainingProgramData');
        if (savedData) {
            const parsedData = JSON.parse(savedData);
            trainingProgramData = {
                program_info: { ...(parsedData.program_info || {}) },
                sessions: { ...(parsedData.sessions || {}) }
            };
        }
    } catch (e) {
        console.error("Erreur chargement données:", e);
    }

    // Charger autres données localement en batch
    const localData = {
        cyclingProgress: 'userProgress',
        nutritionLog: 'nutritionLog',
        performanceData: 'performanceData',
        monthlyStats: 'monthlyStats',
        brytonActivities: 'brytonActivities'
    };

    Object.entries(localData).forEach(([key, varName]) => {
        try {
            window[varName] = JSON.parse(localStorage.getItem(key)) || {};
        } catch (e) {
            console.error(`Erreur chargement ${key}:`, e);
            window[varName] = {};
        }
    });
}

// Phase 2: Initialisation UI immédiate
function initializeUIFast() {
    console.log("⚡ Initialisation UI rapide...");

    // Vérifier les valeurs par défaut SEULEMENT si pas de réinitialisation demandée
    if (!localStorage.getItem('skipAutoGeneration')) {
        ensureDefaults();
    }

    // Mettre à jour l'interface immédiatement
    updateMonthlyPlan();
    updateStats();

    console.log("✅ Application prête !");
}

// Phase 3: Firebase lent et en arrière-plan
async function initializeFirebaseSlow() {
    console.log("🔄 Initialisation Firebase en arrière-plan...");

    try {
        console.log("🔐 Tentative d'authentification...");
        currentUser = await authenticateUser();
        console.log("✅ Authentification réussie, utilisateur:", currentUser?.uid);

        DATA_PATH = `users/${currentUser.uid}`;
        console.log("✅ Chemin Firebase:", DATA_PATH);

        // Migration en arrière-plan
        await migrateFromOldUser();

        // Synchronisation finale
        await initData();
        console.log("✅ Synchronisation Firebase complète");

    } catch (error) {
        console.error("❌ Erreur Firebase - Mode hors-ligne:", error);
        console.error("Détail de l'erreur:", error.code, error.message);
        DATA_PATH = null;
        currentUser = null;
    }

    console.log("📊 État final - currentUser:", currentUser?.uid || "null");
    console.log("📊 État final - DATA_PATH:", DATA_PATH || "null");
}

// Phase 4: Initialisation différée des fonctionnalités lourdes
setTimeout(() => {
    // Définir le mois actuel automatiquement
    const currentDate = new Date();
    const currentMonth = currentDate.toISOString().substring(0, 7);
    const monthSelector = document.getElementById('monthSelector');
    if (monthSelector) {
        monthSelector.value = currentMonth;
    }

    // Écouteurs pour les curseurs
    const difficultySlider = document.getElementById('modalDifficulty');
    const fatigueSlider = document.getElementById('modalFatigue');
    if (difficultySlider) {
        difficultySlider.addEventListener('input', function () {
            const difficultyValue = document.getElementById('difficultyValue');
            if (difficultyValue) difficultyValue.textContent = this.value;
        });
    }
    if (fatigueSlider) {
        fatigueSlider.addEventListener('input', function () {
            const fatigueValue = document.getElementById('fatigueValue');
            if (fatigueValue) fatigueValue.textContent = this.value;
        });
    }
}, 200);

// Phase 5: Initialisation très différée des fonctionnalités optionnelles
setTimeout(() => {
    // Tableau de bord de charge d'entraînement (optionnel)
    if (typeof initializeTrainingLoadDashboard === 'function') {
        try {
            initializeTrainingLoadDashboard();
        } catch (e) {
            console.warn("⚠️ Impossible d'initialiser le tableau de bord:", e);
        }
    }

    // Météo (optionnel)
    if (typeof initializeWeatherSystem === 'function') {
        try {
            initializeWeatherSystem();
        } catch (e) {
            console.warn("⚠️ Impossible d'initialiser la météo:", e);
        }
    }

    // Graphiques (chargement différé)
    if (typeof updateAnalysisCharts === 'function') {
        try {
            updateAnalysisCharts();
        } catch (e) {
            console.warn("⚠️ Impossible d'initialiser les graphiques:", e);
        }
    }

    // Carte (uniquement si nécessaire)
    const mapFileInput = document.getElementById('mapFileInput');
    if (mapFileInput) {
        // Charger MapLibre uniquement pour les fonctionnalités de carte
        if (typeof loadMapLibre === 'function') {
            loadMapLibre();
        }

        // Gestionnaire pour le fichier de carte
        mapFileInput.addEventListener('change', event => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (typeof handleMapFile === 'function') {
                handleMapFile(file);
            }
            event.target.value = '';
        });
    }

    // Initialiser les fonctionnalités optionnelles avec try/catch
    const optionalFunctions = [
        'initQuickNavigation',
        'generateMiniCalendar',
        'initializeOptimizedLibrary',
        'initStravaMap',
        'buildStravaActivityList',
        'initStravaExport'
    ];

    optionalFunctions.forEach(funcName => {
        if (typeof window[funcName] === 'function') {
            try {
                window[funcName]();
                console.log(`✅ ${funcName} initialisé`);
            } catch (e) {
                console.warn(`⚠️ Erreur initialisation ${funcName}:`, e);
            }
        }
    });

    // Ajouter le bouton de nettoyage des doublons
    const importBtn = document.querySelector('button[onclick="importWorkoutFile()"]');
    if (importBtn && importBtn.parentNode) {
        const cleanBtn = document.createElement('button');
        cleanBtn.className = 'btn btn-warning ml-2';
        cleanBtn.innerHTML = '🧹 Nettoyer les doublons';
        cleanBtn.onclick = () => {
            if (typeof cleanDuplicateActivities === 'function') {
                cleanDuplicateActivities();
            }
        };
        importBtn.parentNode.appendChild(cleanBtn);
    }

    // Écouteurs de sauvegarde (non bloquants)
    window.addEventListener('beforeunload', () => {
        if (typeof saveAllDataToLocalStorage === 'function') {
            saveAllDataToLocalStorage();
        }
        if (!navigator.onLine) {
            localStorage.setItem('pendingSync', 'true');
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            if (typeof saveAllDataToLocalStorage === 'function') {
                saveAllDataToLocalStorage();
            }
            if (typeof scheduleRemoteSave === 'function') {
                scheduleRemoteSave();
            }
        }
    });

    console.log("✅ Initialisation terminée");
}, 2000);

// Générer un programme d'entraînement de base
function generateBasicTrainingProgram() {
    const startDate = new Date('2025-09-01');
    const endDate = new Date('2026-08-31');

    // Configuration du programme
    const programPhases = [
        { name: 'Fondamentale 1', startDate: new Date('2025-09-01'), endDate: new Date('2025-10-31'), focus: 'endurance' },
        { name: 'Fondamentale 2', startDate: new Date('2025-11-01'), endDate: new Date('2025-12-31'), focus: 'endurance' },
        { name: 'Construction', startDate: new Date('2026-01-01'), endDate: new Date('2026-02-28'), focus: 'intensity' },
        { name: 'Pic', startDate: new Date('2026-03-01'), endDate: new Date('2026-04-30'), focus: 'performance' },
        { name: 'Compétition', startDate: new Date('2026-05-01'), endDate: new Date('2026-06-30'), focus: 'races' },
        { name: 'Récupération', startDate: new Date('2026-07-01'), endDate: new Date('2026-08-31'), focus: 'recovery' }
    ];

    // Types de sessions
    const sessionTypes = {
        endurance: { name: 'Endurance fondamental', duration: 90, intensity: 'Zone 2 (60-70% FCmax)' },
        intensity: { name: 'Seuil lactique', duration: 60, intensity: 'Zone 4 (80-90% FCmax)' },
        recovery: { name: 'Récupération active', duration: 45, intensity: 'Zone 1 (50-60% FCmax)' },
        vo2max: { name: 'VO2 Max', duration: 45, intensity: 'Zone 5 (90-100% FCmax)' },
        rest: { name: 'Repos', duration: 0, intensity: 'Repos' }
    };

    // Initialiser les informations du programme
    trainingProgramData.program_info = {
        name: "Programme d'entraînement annuel cycliste",
        start_date: "2025-09-01",
        end_date: "2026-08-31",
        cyclist_profile: {
            age: 50,
            level: "Intermédiaire à avancé",
            max_heart_rate: 170,
            rest_heart_rate: 65,
            weight: 75
        }
    };

    // Générer les sessions pour chaque jour
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const dayOfWeek = currentDate.getDay();

        // Déterminer la phase actuelle
        const currentPhase = programPhases.find(phase =>
            currentDate >= phase.startDate && currentDate <= phase.endDate
        );

        // Logique de planification hebdomadaire
        let sessionType;
        if (dayOfWeek === 0 || dayOfWeek === 6) { // Weekend
            sessionType = Math.random() > 0.3 ? sessionTypes.endurance : sessionTypes.rest;
        } else if (dayOfWeek === 1 || dayOfWeek === 3 || dayOfWeek === 5) { // Lundi, Mercredi, Vendredi
            if (currentPhase && (currentPhase.focus === 'intensity' || currentPhase.focus === 'performance')) {
                sessionType = Math.random() > 0.4 ? sessionTypes.intensity : sessionTypes.recovery;
            } else {
                sessionType = sessionTypes.endurance;
            }
        } else { // Mardi, Jeudi
            sessionType = sessionTypes.recovery;
        }

        // Ajouter des sessions VO2 Max pendant la phase de pic
        if (currentPhase?.focus === 'performance' && Math.random() > 0.8) {
            sessionType = sessionTypes.vo2max;
        }

        // Créer la session
        trainingProgramData.sessions[dateStr] = {
            day: getFrenchDay(currentDate),
            session_type: sessionType.name,
            duration_minutes: sessionType.duration,
            heart_rate_zone: sessionType.intensity,
            cadence_rpm: sessionType.duration > 0 ? '85-95 rpm' : 'N/A',
            intensity: sessionType.intensity,
            exercises: sessionType.duration > 0 ? getExercisesForSession(sessionType.name, sessionType.duration) : '',
            nutrition_pre: sessionType.duration > 60 ? 'Bananes + Barre énergétique 1h avant' : 'Collation légère 30min avant',
            nutrition_post: sessionType.duration > 60 ? 'Boisson de récupération + Repas équilibré' : 'Repas normal',
            notes: `Phase: ${currentPhase?.name || 'Général'}`,
            detailed_exercises: []
        };

        currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log("✅ Programme d'entraînement de base généré");
    console.log(`📅 ${Object.keys(trainingProgramData.sessions).length} sessions créées`);

    // Sauvegarder le programme généré
    saveAllDataToLocalStorage();
}

// Obtenir les exercices pour une session
function getExercisesForSession(sessionType, duration) {
    if (sessionType.includes('Endurance')) {
        return `Échauffement 15min\nEndurance ${duration-30}min en zone 2\nRetour au calme 15min`;
    } else if (sessionType.includes('Seuil')) {
        return `Échauffement 20min\n5x8min au seuil (Z4) - 4min récupération\nRetour au calme 15min`;
    } else if (sessionType.includes('VO2')) {
        return `Échauffement 20min\n6x3min VO2 Max (Z5) - 3min récupération\nRetour au calme 15min`;
    } else if (sessionType.includes('Récupération')) {
        return `Roulement léger ${duration}min en zone 1`;
    }
    return '';
}

// Fermer la modale en cliquant à l'extérieur
window.onclick = function (event) {
    const modal = document.getElementById('sessionModal');
    if (event.target === modal) {
        closeSessionModal();
    }
}

// Basculer le statut d'une session (complétée/non complétée)
function toggleSessionStatus(dateStr) {
    if (!userProgress[dateStr]) {
        userProgress[dateStr] = {};
    }
    
    // Inverser le statut
    userProgress[dateStr].completed = !userProgress[dateStr].completed;

    if (userProgress[dateStr].completed) {
        userProgress[dateStr].completedAt = new Date().toISOString();

        // Calculer le TSS si la session existe
        const session = trainingProgramData.sessions[dateStr];
        if (session) {
            userProgress[dateStr].tss = calculateTSS(session, userProgress[dateStr]);
        }

        console.log(`✅ Session ${dateStr} marquée comme complétée`);
        console.log("📊 userProgress après coche:", userProgress[dateStr]);
    } else {
        delete userProgress[dateStr].completedAt;
        delete userProgress[dateStr].tss;
        console.log(`⏳ Session ${dateStr} marquée comme non complétée`);
    }

    // Sauvegarder et synchroniser
    saveAllDataToLocalStorage();
    console.log("💾 Sauvegarde forcée dans localStorage");
    scheduleRemoteSave();
    
    // Mettre à jour l'affichage
    updateMonthlyPlan();
}

// Fonction de diagnostic pour vérifier les données de progression
function diagnoseProgressData() {
    console.log("=== DIAGNOSTIC DES DONNÉES DE PROGRESSION ===");
    console.log("userProgress:", userProgress);
    
    const completedDates = Object.keys(userProgress).filter(date => userProgress[date].completed);
    console.log("Dates avec sessions complétées:", completedDates);
    
    const selectedMonth = document.getElementById('monthSelector').value;
    const [year, month] = selectedMonth.split('-').map(Number);
    
    const monthCompletedDates = completedDates.filter(date => {
        const [dYear, dMonth] = date.split('-').map(Number);
        return dYear === year && dMonth === month;
    });
    
    console.log(`Sessions complétées pour ${selectedMonth}:`, monthCompletedDates);
    
    // Vérifier les données dans le DOM
    const statusIcons = document.querySelectorAll('.status-icon');
    console.log("Nombre d'icônes de statut trouvées:", statusIcons.length);
    
    return monthCompletedDates;
}

// Appelez cette fonction dans la console pour diagnostiquer
// diagnoseProgressData();

// Exposer certaines fonctions au scope global pour les handlers inline
window.importExercisesFromJson = importExercisesFromJson;
window.openSessionModal = openSessionModal;
window.closeSessionModal = closeSessionModal;
window.saveSessionDetails = saveSessionDetails;
window.deleteSession = deleteSession;
window.updateMonthlyPlan = updateMonthlyPlan;
window.exportData = exportData;
window.resetProgress = resetProgress;
window.togglePhase = togglePhase;
window.showChart = showChart;
window.importWorkoutFile = importWorkoutFile;
window.importTrainingProgramJSON = importTrainingProgramJSON;
window.resetAllData = resetAllData;
window.showActivityDetails = showActivityDetails;
window.deleteActivity = deleteActivity;
window.saveCurrentRoute = saveCurrentRoute;
window.selectRoute = selectRoute;
window.showSelectedRoute = showSelectedRoute;
window.deleteSelectedRoute = deleteSelectedRoute;
window.scrollToWeek = scrollToWeek;
window.updateAnalysisCharts = updateAnalysisCharts;
window.renameAllUnnamedActivities = renameAllUnnamedActivities;
window.initData = initData;
window.scheduleRemoteSave = scheduleRemoteSave;
window.persistToFirebase = persistToFirebase;
window.applyDataFromFirebase = applyDataFromFirebase;
window.buildSyncPayload = buildSyncPayload;
window.cleanDuplicateActivities = cleanDuplicateActivities;
// ========================================
//   SYSTÈME MÉTÉO POUR CYCLISTES
// ========================================

// Configuration météo (importée depuis weather-config.js)
// const WEATHER_CONFIG est maintenant importé depuis firebase-config.js

// Données météo en cache
let weatherData = {
    current: {},
    hourlyForecast: [],
    forecast: {},
    lastUpdated: null
};

// Obtenir la position géographique de l'utilisateur - VERSION AMÉLIORÉE AVEC CACHE
async function getUserLocation() {
    return new Promise(async (resolve, reject) => {
        // 1. Vérifier d'abord si une localisation est sauvegardée
        const savedLocation = localStorage.getItem('userWeatherLocation');
        if (savedLocation) {
            try {
                const location = JSON.parse(savedLocation);
                console.log("📍 Utilisation de la localisation sauvegardée:", location);
                resolve(location);
                return;
            } catch (e) {
                console.warn("⚠️ Erreur lors de la lecture de la localisation sauvegardée");
            }
        }

        // 2. Si pas de sauvegarde, demander la localisation
        if (!navigator.geolocation) {
            // Utiliser une localisation par défaut (Paris)
            const defaultLocation = { lat: 48.8566, lon: 2.3522, name: "Paris" };
            console.log("📍 Géolocalisation non supportée, utilisation de la localisation par défaut:", defaultLocation);
            localStorage.setItem('userWeatherLocation', JSON.stringify(defaultLocation));
            resolve(defaultLocation);
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const location = {
                    lat: position.coords.latitude,
                    lon: position.coords.longitude,
                    accuracy: position.coords.accuracy,
                    timestamp: new Date().toISOString()
                };

                console.log("✅ Géolocalisation réussie:", {
                    lat: location.lat,
                    lon: location.lon,
                    accuracy: location.accuracy + "m"
                });

                // 3. Sauvegarder la localisation pour ne plus la redemander
                localStorage.setItem('userWeatherLocation', JSON.stringify(location));
                console.log("💾 Localisation sauvegardée pour les prochaines fois");

                resolve(location);
            },
            (error) => {
                let errorMessage = "";
                let fallbackLocation = { lat: 48.8566, lon: 2.3522, name: "Paris (défaut)" };

                switch(error.code) {
                    case error.PERMISSION_DENIED:
                        errorMessage = "🚫 Géolocalisation refusée - utilisation de la localisation par défaut";
                        console.log("💡 Solution: Activez la localisation ou définissez une localisation manuelle");
                        break;
                    case error.POSITION_UNAVAILABLE:
                        errorMessage = "📡 Position non disponible - utilisation de la localisation par défaut";
                        break;
                    case error.TIMEOUT:
                        errorMessage = "⏱️ Délai d'attente dépassé - utilisation de la localisation par défaut";
                        break;
                    default:
                        errorMessage = "❌ Erreur inconnue: " + error.message;
                }

                console.error(errorMessage);

                // Utiliser la localisation par défaut et la sauvegarder
                localStorage.setItem('userWeatherLocation', JSON.stringify(fallbackLocation));
                resolve(fallbackLocation);
            },
            {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 86400000 // 24 heures de cache navigateur
            }
        );
    });
}

// Définir manuellement une localisation précise
function setManualLocation(lat, lon, name) {
    const location = {
        lat: parseFloat(lat),
        lon: parseFloat(lon),
        name: name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        isManual: true,
        timestamp: new Date().toISOString()
    };

    localStorage.setItem('userWeatherLocation', JSON.stringify(location));
    console.log("🎯 Localisation manuelle définie:", location);

    // Mettre à jour les données météo avec la nouvelle localisation
    updateWeatherData();

    return location;
}

// Réinitialiser la localisation (demander à nouveau)
function resetLocation() {
    localStorage.removeItem('userWeatherLocation');
    console.log("🔄 Localisation réinitialisée - nouvelle demande au prochain chargement");

    // Mettre à jour les données météo
    updateWeatherData();
}

// Fonctions pour gérer le panneau de localisation
function openLocationPanel() {
    document.getElementById('locationPanel').style.display = 'block';
    document.getElementById('locationButton').style.display = 'none';

    // Afficher la localisation actuelle si elle existe
    const savedLocation = localStorage.getItem('userWeatherLocation');
    if (savedLocation) {
        try {
            const location = JSON.parse(savedLocation);
            document.getElementById('latInput').value = location.lat || '';
            document.getElementById('lonInput').value = location.lon || '';
            document.getElementById('nameInput').value = location.name || '';
        } catch (e) {
            console.warn("Erreur lors de la lecture de la localisation sauvegardée");
        }
    }
}

function closeLocationPanel() {
    document.getElementById('locationPanel').style.display = 'none';
    document.getElementById('locationButton').style.display = 'flex';
}

function setLocationFromInputs() {
    const lat = parseFloat(document.getElementById('latInput').value);
    const lon = parseFloat(document.getElementById('lonInput').value);
    const name = document.getElementById('nameInput').value;

    // Validation
    if (isNaN(lat) || isNaN(lon)) {
        alert('⚠️ Veuillez entrer des coordonnées valides');
        return;
    }

    if (lat < -90 || lat > 90) {
        alert('⚠️ La latitude doit être entre -90 et 90');
        return;
    }

    if (lon < -180 || lon > 180) {
        alert('⚠️ La longitude doit être entre -180 et 180');
        return;
    }

    // Définir la localisation
    const location = setManualLocation(lat, lon, name);

    // Confirmation
    alert(`✅ Localisation définie avec succès!\n📍 ${name || lat.toFixed(4) + ', ' + lon.toFixed(4)}\n\nLes données météo vont se mettre à jour...`);

    // Fermer le panneau
    closeLocationPanel();
}

// Récupérer la météo actuelle
async function getCurrentWeather(lat, lon) {
    // Version réelle avec API OpenWeatherMap (prioritaire)
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_CONFIG.apiKey}&units=${WEATHER_CONFIG.units}&lang=${WEATHER_CONFIG.lang}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        return {
            location: data.name,
            temperature: Math.round(data.main.temp),
            humidity: data.main.humidity,
            windSpeed: Math.round(data.wind.speed * 3.6), // m/s → km/h
            windDirection: data.wind.deg || 0,
            windGust: data.wind.gust ? Math.round(data.wind.gust * 3.6) : 0,
            weather: data.weather[0].description,
            pressure: data.main.pressure,
            visibility: data.visibility ? data.visibility / 1000 : 10, // m → km
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error("❌ Erreur API météo:", error);
        console.log("🔄 Utilisation des données simulées en fallback");

        // Fallback vers simulation si API échoue
        return {
            location: "Position simulée (API indisponible)",
            temperature: Math.round(15 + Math.random() * 10),
            humidity: Math.round(50 + Math.random() * 30),
            windSpeed: Math.round(Math.random() * 30),
            windDirection: Math.round(Math.random() * 360),
            windGust: Math.round(Math.random() * 40),
            weather: ["soleil", "nuageux", "pluie légère"][Math.floor(Math.random() * 3)],
            pressure: Math.round(1000 + Math.random() * 30),
            visibility: Math.round(5 + Math.random() * 15),
            timestamp: new Date().toISOString()
        };
    }
}

// Récupérer les prévisions horaires pour demain matin
async function getTomorrowMorningForecast(lat, lon) {
    // Version réelle avec API OpenWeatherMap 5-day forecast (gratuite)
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${WEATHER_CONFIG.apiKey}&units=${WEATHER_CONFIG.units}&lang=${WEATHER_CONFIG.lang}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        // Extraire les prévisions pour demain matin (7h-13h)
        // OpenWeatherMap donne des prévisions toutes les 3h, on prend le plus proche
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        // Filtrer les prévisions disponibles pour la journée de demain
        const tomorrowForecasts = data.list.filter(item => {
            const itemTime = new Date(item.dt * 1000);
            const itemDate = new Date(itemTime.getFullYear(), itemTime.getMonth(), itemTime.getDate());
            return itemDate.getTime() === tomorrow.getTime();
        });

        // Créer des prévisions pour chaque heure 7h-13h en utilisant la plus proche
        const targetHours = [7, 8, 9, 10, 11, 12, 13];
        const tomorrowMorningForecast = targetHours.map(targetHour => {
            // Trouver la prévision la plus proche
            let closestForecast = tomorrowForecasts[0]; // fallback
            let minDiff = Infinity;

            tomorrowForecasts.forEach(forecast => {
                const forecastHour = new Date(forecast.dt * 1000).getHours();
                const diff = Math.abs(forecastHour - targetHour);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestForecast = forecast;
                }
            });

            const item = closestForecast;
            return {
                time: new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), targetHour, 0, 0).toISOString(),
                hour: targetHour,
                temperature: Math.round(item.main.temp),
                humidity: item.main.humidity,
                windSpeed: Math.round(item.wind.speed * 3.6), // m/s → km/h
                windDirection: item.wind.deg || 0,
                weather: item.weather[0].description,
                precipitation: item.pop ? Math.round(item.pop * 100) : 0,
                visibility: item.visibility ? item.visibility / 1000 : 10,
                pressure: item.main.pressure,
                simulated: false,
                interpolated: true // Indicateur que c'est interpolé
            };
        });

        return tomorrowMorningForecast;
    } catch (error) {
        console.error("❌ Erreur API prévisions horaires:", error);
        console.log("🔄 Utilisation des prévisions simulées en fallback");

        // Fallback vers simulation si API échoue
        const tomorrowMorning = new Date();
        tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
        tomorrowMorning.setHours(7, 0, 0, 0);

        const simulatedForecast = [];
        for (let hour = 7; hour <= 13; hour++) {
            const forecastTime = new Date(tomorrowMorning);
            forecastTime.setHours(hour, 0, 0, 0);

            simulatedForecast.push({
                time: forecastTime.toISOString(),
                hour: hour,
                temperature: Math.round(12 + Math.random() * 8 + (hour - 7) * 0.5),
                humidity: Math.round(60 + Math.random() * 20),
                windSpeed: Math.round(5 + Math.random() * 15),
                windDirection: Math.round(Math.random() * 360),
                weather: "[SIMULATION] " + ["soleil", "nuageux", "partiellement nuageux"][Math.floor(Math.random() * 3)],
                precipitation: Math.random() > 0.8 ? Math.round(Math.random() * 5) : 0,
                visibility: Math.round(8 + Math.random() * 12),
                pressure: Math.round(1010 + Math.random() * 15),
                simulated: true,
                interpolated: false
            });
        }

        return simulatedForecast;
    }
}

// Analyser les meilleures heures pour sortir demain matin
function analyzeBestDepartureTimes(hourlyForecast) {
    if (!hourlyForecast || hourlyForecast.length === 0) {
        return [];
    }

    const scoredHours = hourlyForecast.map(hour => {
        let score = 100;
        let recommendations = [];

        // Score de température (optimal: 15-22°C)
        if (hour.temperature < 10) {
            score -= 30;
            recommendations.push("🥶 Très frais, nécessite équipement chaud");
        } else if (hour.temperature < 15) {
            score -= 15;
            recommendations.push("🧊 Frais, manches longues recommandées");
        } else if (hour.temperature > 25) {
            score -= 20;
            recommendations.push("🌞 Chaud, réduction d'intensité recommandée");
        }

        // Score de vent (optimal: <10 km/h)
        if (hour.windSpeed > 25) {
            score -= 35;
            recommendations.push("🌪️ Vent très fort, sortie déconseillée");
        } else if (hour.windSpeed > 15) {
            score -= 20;
            recommendations.push("💨 Vent modéré, attention au retour");
        } else if (hour.windSpeed > 10) {
            score -= 10;
            recommendations.push("🌬️ Vent léger, planifiez boucle");
        }

        // Score de précipitations
        if (hour.precipitation > 70) {
            score -= 40;
            recommendations.push("🌧️ Pluie forte, sortie intérieure recommandée");
        } else if (hour.precipitation > 40) {
            score -= 25;
            recommendations.push("🌦️ Pluie probable, prévoir équipement");
        } else if (hour.precipitation > 20) {
            score -= 15;
            recommendations.push("🌧️ Risque d'averse, emportez imperméable");
        }

        // Score d'humidité
        if (hour.humidity > 85) {
            score -= 10;
            recommendations.push("💦 Humidité très élevée, effort difficile");
        }

        // Bonus pour météo ensoleillée
        if (hour.weather.includes("soleil") || hour.weather.includes("ensoleillé")) {
            score += 10;
            recommendations.push("☀️ Temps idéal pour l'entraînement");
        }

        // Bonus pour bonne visibilité
        if (hour.visibility > 15) {
            score += 5;
        }

        return {
            hour: hour,
            score: Math.max(0, Math.min(100, score)),
            recommendations: recommendations,
            comfortIndex: calculateHourlyComfortIndex(hour)
        };
    });

    // Trier par score décroissant
    return scoredHours.sort((a, b) => b.score - a.score);
}

// Calculer l'indice de confort pour une heure spécifique
function calculateHourlyComfortIndex(hour) {
    let comfortScore = 100;

    // Température
    if (hour.temperature < 8) comfortScore -= 25;
    else if (hour.temperature < 12) comfortScore -= 15;
    else if (hour.temperature < 16) comfortScore -= 8;
    else if (hour.temperature > 26) comfortScore -= 15;
    else if (hour.temperature > 30) comfortScore -= 25;

    // Vent
    if (hour.windSpeed > 20) comfortScore -= 20;
    else if (hour.windSpeed > 15) comfortScore -= 12;
    else if (hour.windSpeed > 10) comfortScore -= 6;

    // Précipitations
    if (hour.precipitation > 50) comfortScore -= 30;
    else if (hour.precipitation > 30) comfortScore -= 20;
    else if (hour.precipitation > 15) comfortScore -= 10;

    return Math.max(0, comfortScore);
}

// Créer un tableau horizontal de prévisions horaires (style MeteoMaroc)
function createHourlyForecastTable(hourlyForecast, bestHour = null) {
    if (!hourlyForecast || hourlyForecast.length === 0) {
        return `
            <div class="hourly-forecast-table">
                <p style="text-align: center; color: #666; padding: 20px;">
                    📊 Aucune donnée de prévision disponible
                </p>
            </div>
        `;
    }

    // Trier par heure
    const sortedHours = [...hourlyForecast].sort((a, b) => a.hour - b.hour);

    // Créer l'en-tête avec les heures
    const timeHeaders = sortedHours.map(hour => {
        const isPrimary = hour.hour === bestHour;
        const isBestHour = hour.hour === bestHour;
        return `
            <div class="time-header ${isPrimary ? 'primary' : ''} ${isBestHour ? 'best-hour' : ''}">
                ${hour.hour}h
                ${isBestHour ? '<br><small>🏆 Meilleur</small>' : ''}
            </div>
        `;
    }).join('');

    // Créer les lignes de données
    const tempRow = sortedHours.map(hour => {
        const isBestHour = hour.hour === bestHour;
        return `
            <div class="hour-cell ${isBestHour ? 'best-hour' : ''}">
                <div class="cell-temperature">${hour.temperature}°</div>
            </div>
        `;
    }).join('');

    const weatherRow = sortedHours.map(hour => {
        const isBestHour = hour.hour === bestHour;
        const weatherIcon = hour.weather.includes("soleil") ? "☀️" :
                           hour.weather.includes("nuageux") ? "☁️" :
                           hour.weather.includes("pluie") ? "🌧️" :
                           hour.weather.includes("vent") ? "💨" : "🌤️";
        return `
            <div class="hour-cell ${isBestHour ? 'best-hour' : ''}">
                <div class="cell-weather">${weatherIcon}<br>${hour.weather}</div>
            </div>
        `;
    }).join('');

    const windRow = sortedHours.map(hour => {
        const isBestHour = hour.hour === bestHour;
        return `
            <div class="hour-cell ${isBestHour ? 'best-hour' : ''}">
                <div class="cell-wind">${hour.windSpeed}km/h</div>
            </div>
        `;
    }).join('');

    const precipitationRow = sortedHours.map(hour => {
        const isBestHour = hour.hour === bestHour;
        const precipValue = hour.precipitation > 0 ? `${hour.precipitation}%` : '-';
        return `
            <div class="hour-cell ${isBestHour ? 'best-hour' : ''}">
                <div class="cell-precipitation">${precipValue}</div>
            </div>
        `;
    }).join('');

    const humidityRow = sortedHours.map(hour => {
        const isBestHour = hour.hour === bestHour;
        return `
            <div class="hour-cell ${isBestHour ? 'best-hour' : ''}">
                <div class="cell-humidity">${hour.humidity}%</div>
            </div>
        `;
    }).join('');

    // Indicateur si données simulées
    const hasSimulated = sortedHours.some(hour => hour.simulated);
    const simulationBadge = hasSimulated ?
        `<div style="text-align: center; margin-bottom: 10px; color: #dc3545; font-size: 0.85em;">
            ⚠️ Contient des données simulées [API indisponible]
        </div>` : '';

    return `
        <div class="hourly-forecast-table">
            ${simulationBadge}

            <div class="time-axis-header">
                <div class="row-label">🕐 Heures</div>
                ${timeHeaders}
            </div>

            <div class="forecast-rows">
                <div class="forecast-row">
                    <div class="row-label">🌡️ Température</div>
                    ${tempRow}
                </div>

                <div class="forecast-row">
                    <div class="row-label">☁️ Météo</div>
                    ${weatherRow}
                </div>

                <div class="forecast-row">
                    <div class="row-label">💨 Vent</div>
                    ${windRow}
                </div>

                <div class="forecast-row">
                    <div class="row-label">🌧️ Pluie</div>
                    ${precipitationRow}
                </div>

                <div class="forecast-row">
                    <div class="row-label">💧 Humidité</div>
                    ${humidityRow}
                </div>
            </div>

            <div class="legend">
                <div class="legend-item">
                    <span class="legend-icon">🏆</span>
                    <span>Meilleur créneau</span>
                </div>
                <div class="legend-item">
                    <span class="legend-icon">🌡️</span>
                    <span>Température (°C)</span>
                </div>
                <div class="legend-item">
                    <span class="legend-icon">💨</span>
                    <span>Vent (km/h)</span>
                </div>
                <div class="legend-item">
                    <span class="legend-icon">🌧️</span>
                    <span>Précipitations (%)</span>
                </div>
            </div>
        </div>
    `;
}

// Générer les recommandations de planning
function generatePlanningRecommendations(bestTimes, currentWeather) {
    const recommendations = [];

    if (bestTimes.length === 0) {
        recommendations.push("⚠️ Données de prévision indisponibles");
        return recommendations;
    }

    // Meilleur créneau
    const bestTime = bestTimes[0];
    if (bestTime.score >= 80) {
        recommendations.push(`🌟 Excellent créneau: ${bestTime.hour.hour}h - ${bestTime.hour.temperature}°C, score ${bestTime.score}/100`);
    } else if (bestTime.score >= 60) {
        recommendations.push(`✅ Bon créneau: ${bestTime.hour.hour}h - ${bestTime.hour.temperature}°C, score ${bestTime.score}/100`);
    } else if (bestTime.score >= 40) {
        recommendations.push(`⚖️ Créneau acceptable: ${bestTime.hour.hour}h - ${bestTime.hour.temperature}°C, score ${bestTime.score}/100`);
    } else {
        recommendations.push(`⚠️ Conditions difficiles: ${bestTime.hour.hour}h - ${bestTime.hour.temperature}°C, score ${bestTime.score}/100`);
    }

    // Recommandations de timing
    const earlyHours = bestTimes.filter(t => t.hour.hour <= 8);
    const lateHours = bestTimes.filter(t => t.hour.hour >= 10);

    if (earlyHours.length > 0 && earlyHours[0].score > (lateHours[0]?.score || 0)) {
        recommendations.push("🌅 Départ tôt recommandé pour éviter la chaleur/vent");
    } else if (lateHours.length > 0 && lateHours[0].score > (earlyHours[0]?.score || 0)) {
        recommendations.push("☀️ Départ tard possible si conditions s'améliorent");
    }

    // Comparaison avec aujourd'hui
    if (currentWeather.temperature) {
        const tempDiff = bestTime.hour.temperature - currentWeather.temperature;
        if (tempDiff > 3) {
            recommendations.push(`🌡️ Plus chaud que aujourd'hui (+${tempDiff}°C)`);
        } else if (tempDiff < -3) {
            recommendations.push(`❄️ Plus froid que demain (${tempDiff}°C)`);
        }
    }

    return recommendations;
}

// Calculer l'impact du vent sur l'effort cycliste
function calculateWindImpact(windSpeed, windDirection, rideDirection = null) {
    if (!rideDirection) {
        // Si pas de direction spécifiée, calculer l'impact moyen
        return {
            headwind: windSpeed * 0.5, // Estimation: 50% du temps contre le vent
            crosswind: windSpeed * 0.3, // 30% de vent latéral
            tailwind: windSpeed * 0.2, // 20% vent favorable
            effortIncrease: windSpeed * 0.025 // +2.5% d'effort par km/h de vent moyen
        };
    }

    // Calculer l'angle entre vent et direction de la route
    const angle = Math.abs(windDirection - rideDirection) % 360;
    const effectiveAngle = angle > 180 ? 360 - angle : angle;

    // Calculer la composante effective du vent
    const windComponent = windSpeed * Math.cos(effectiveAngle * Math.PI / 180);

    return {
        headwind: Math.max(0, windComponent),
        crosswind: windSpeed * Math.sin(effectiveAngle * Math.PI / 180),
        tailwind: Math.max(0, -windComponent),
        effortIncrease: Math.max(0, windComponent * 0.025) // +2.5% d'effort par km/h de vent de face
    };
}

// Calculer l'indice de confort cycliste
function calculateComfortIndex(temperature, humidity, windSpeed, weather) {
    let comfortScore = 100;
    let recommendations = [];

    // Impact de la température
    if (temperature < 10) {
        comfortScore -= 20;
        recommendations.push("🧥 Vêtements chauds recommandés");
    } else if (temperature < 15) {
        comfortScore -= 10;
        recommendations.push("👕 Manches longues ou gilet");
    } else if (temperature > 25) {
        comfortScore -= 15;
        recommendations.push("💧 Hydratation importante");
    } else if (temperature > 30) {
        comfortScore -= 30;
        recommendations.push("🥵 Risque de coup de chaleur, partez tôt");
    }

    // Impact de l'humidité
    if (humidity > 70) {
        comfortScore -= 10;
        recommendations.push("💦 Humidité élevée, effort plus difficile");
    }

    // Impact du vent
    if (windSpeed > 20) {
        comfortScore -= 15;
        recommendations.push("💨 Vent fort, attention à la trajectoire");
    }

    // Impact des conditions météo
    if (weather.includes("pluie")) {
        comfortScore -= 25;
        recommendations.push("🌧️ Prenez vêtements de pluie et gilets fluorescents");
    }

    let comfortLevel;
    if (comfortScore >= 80) comfortLevel = { text: "Excellent", color: "#28a745", emoji: "😊" };
    else if (comfortScore >= 60) comfortLevel = { text: "Bon", color: "#17a2b8", emoji: "🙂" };
    else if (comfortScore >= 40) comfortLevel = { text: "Moyen", color: "#ffc107", emoji: "😐" };
    else comfortLevel = { text: "Difficile", color: "#dc3545", emoji: "😰" };

    return {
        score: Math.max(0, comfortScore),
        level: comfortLevel,
        recommendations: recommendations
    };
}

// Générer les recommandations d'entraînement basées sur la météo
function generateTrainingRecommendations(weather, comfort) {
    const recommendations = [];

    // Recommandations basées sur la température
    if (weather.temperature < 5) {
        recommendations.push("🥶 Température très basse: Sortie intérieure ou avec équipement hivernal complet");
    } else if (weather.temperature < 10) {
        recommendations.push("🧊 Frais: Échauffement prolongé, attention aux articulations");
    } else if (weather.temperature > 28) {
        recommendations.push("🌞 Chaud: Partez tôt le matin ou tard le soir, réduisez l'intensité");
    }

    // Recommandations basées sur le vent
    if (weather.windSpeed > 25) {
        recommendations.push("🌪️ Vent très fort: Sortie sur home trainer ou trajet protégé");
    } else if (weather.windSpeed > 15) {
        recommendations.push("💨 Vent modéré: Sortie en boucle pour revenir avec le vent");
    }

    // Recommandations basées sur l'humidité
    if (weather.humidity > 80) {
        recommendations.push("💧 Humidité élevée: Hydratez-vous toutes les 20 minutes");
    }

    // Recommandations d'équipement
    if (weather.temperature < 15) {
        recommendations.push("👕 Équipement: Manches longues, jambières, gants");
    } else if (weather.temperature > 22) {
        recommendations.push("👕 Équipement: Textiles techniques respirants");
    }

    if (weather.weather.includes("pluie")) {
        recommendations.push("🌧️ Équipement: Vêtements de pluie, surchaussures, gants");
        recommendations.push("⚠️ Sécurité: Feux allumés, gilet fluorescent");
    }

    // Recommandations d'intensité
    let intensityAdjustment = 0;
    if (weather.windSpeed > 20) intensityAdjustment -= 10;
    if (weather.humidity > 75) intensityAdjustment -= 5;
    if (weather.temperature > 28) intensityAdjustment -= 10;
    if (weather.temperature < 8) intensityAdjustment -= 5;

    if (intensityAdjustment < -15) {
        recommendations.push("🎯 Intensité: Réduisez de 15-20% l'intensité prévue");
    } else if (intensityAdjustment < -5) {
        recommendations.push("🎯 Intensité: Réduisez légèrement l'intensité");
    }

    return recommendations;
}

// Vérifier si l'API météo est configurée
function isWeatherAPIConfigured() {
    return WEATHER_CONFIG &&
           WEATHER_CONFIG.apiKey &&
           WEATHER_CONFIG.apiKey !== "YOUR_API_KEY_HERE" &&
           WEATHER_CONFIG.apiKey !== "YOUR_OPENWEATHER_API_KEY";
}

// Mettre à jour les données météo
async function updateWeatherData() {
    console.log("🌤️ Mise à jour des données météo...");

    try {
        // Vérifier si l'API est configurée
        if (!isWeatherAPIConfigured()) {
            console.warn("⚠️ API OpenWeatherMap non configurée - Utilisation des données simulées");
            console.log("📋 Pour configurer l'API réelle:");
            console.log("1. Allez sur https://openweathermap.org/");
            console.log("2. Créez un compte gratuit");
            console.log("3. Obtenez votre clé API");
            console.log("4. Éditez weather-config.js");
            console.log("5. Remplacez 'YOUR_API_KEY_HERE' par votre clé");
        }

        const location = await getUserLocation();

        // Récupérer les deux types de données en parallèle
        const [current, tomorrowForecast] = await Promise.all([
            getCurrentWeather(location.lat, location.lon),
            getTomorrowMorningForecast(location.lat, location.lon)
        ]);

        if (current) {
            weatherData.current = current;
            weatherData.hourlyForecast = tomorrowForecast;
            weatherData.lastUpdated = new Date().toISOString();

            const dataSource = isWeatherAPIConfigured() ? "réelles" : "simulées";
            console.log(`✅ Données météo mises à jour (${dataSource}):`, current);
            console.log("📅 Prévisions demain matin:", tomorrowForecast.length, "heures");

            // Afficher un message dans la console pour confirmer la source
            if (isWeatherAPIConfigured()) {
                console.log(`🎯 Localisation: ${current.location} (${Math.round(location.lat * 100) / 100}°, ${Math.round(location.lon * 100) / 100}°)`);
            }

            return current;
        }
    } catch (error) {
        console.error("❌ Erreur lors de la mise à jour météo:", error);
    }

    return null;
}

// Créer l'affichage météo
function createWeatherDisplay() {
    const weather = weatherData.current;
    const comfort = weather.temperature ? calculateComfortIndex(weather.temperature, weather.humidity, weather.windSpeed, weather.weather) : null;
    const windImpact = weather.windSpeed ? calculateWindImpact(weather.windSpeed, weather.windDirection) : null;

    if (!weather.temperature) {
        return `
            <div class="weather-widget">
                <h4>🌤️ Conditions météo</h4>
                <div class="text-center text-muted">
                    <p>Météo non disponible</p>
                    <button onclick="updateWeatherData()" class="btn btn-sm btn-primary">
                        🔄 Mettre à jour
                    </button>
                </div>
            </div>
        `;
    }

    const recommendations = generateTrainingRecommendations(weather, comfort);

    return `
        <div class="weather-widget">
            <div class="weather-header">
                <h4>🌤️ Conditions actuelles - ${weather.location}</h4>
                <small class="text-muted">Dernière mise à jour: ${new Date(weather.timestamp).toLocaleTimeString()}</small>
                ${isWeatherAPIConfigured() ?
                    `<span class="badge badge-success">Données réelles 🌍</span>` :
                    `<span class="badge badge-warning">Données simulées ⚠️</span>`
                }
            </div>

            <div class="weather-main-info">
                <div class="weather-temp">${weather.temperature}°C</div>
                <div class="weather-desc">${weather.weather}</div>
            </div>

            <div class="weather-details-grid">
                <div class="weather-detail">
                    <span class="weather-icon">💨</span>
                    <div>
                        <strong>Vent:</strong> ${weather.windSpeed} km/h
                        ${windImpact ? `<br><small>${Math.round(windImpact.headwind)} km/h de face</small>` : ''}
                    </div>
                </div>
                <div class="weather-detail">
                    <span class="weather-icon">💧</span>
                    <div>
                        <strong>Humidité:</strong> ${weather.humidity}%
                    </div>
                </div>
                <div class="weather-detail">
                    <span class="weather-icon">🎯</span>
                    <div>
                        <strong>Pression:</strong> ${weather.pressure} hPa
                    </div>
                </div>
                <div class="weather-detail">
                    <span class="weather-icon">👁️</span>
                    <div>
                        <strong>Visibilité:</strong> ${weather.visibility} km
                    </div>
                </div>
            </div>

            ${comfort ? `
            <div class="weather-comfort" style="background: ${comfort.level.color}20; border-left: 4px solid ${comfort.level.color}; padding: 15px; margin: 15px 0; border-radius: 5px;">
                <strong>${comfort.level.emoji} Confort cycliste: ${comfort.level.text}</strong>
                <div class="comfort-score">Score: ${comfort.score}/100</div>
                ${comfort.recommendations.length > 0 ? `
                    <ul class="comfort-recommendations">
                        ${comfort.recommendations.map(rec => `<li>${rec}</li>`).join('')}
                    </ul>
                ` : ''}
            </div>
            ` : ''}

            ${recommendations.length > 0 ? `
            <div class="weather-recommendations">
                <h5>🎯 Recommandations d'entraînement:</h5>
                <ul>
                    ${recommendations.slice(0, 5).map(rec => `<li>${rec}</li>`).join('')}
                </ul>
            </div>
            ` : ''}

            ${createTomorrowMorningForecastDisplay()}

            <div class="weather-actions">
                <button onclick="updateWeatherData()" class="btn btn-sm btn-primary">
                    🔄 Mettre à jour la météo
                </button>
                <button onclick="toggleWeatherDetails()" class="btn btn-sm btn-secondary">
                    📊 Analyse détaillée
                </button>
            </div>
        </div>
    `;
}

// Créer l'affichage des prévisions de demain matin
function createTomorrowMorningForecastDisplay() {
    if (!weatherData.hourlyForecast || weatherData.hourlyForecast.length === 0) {
        return `
            <div class="tomorrow-forecast">
                <h4>📅 Prévisions de demain matin</h4>
                <div class="text-center text-muted">
                    <p>Prévisions non disponibles</p>
                </div>
            </div>
        `;
    }

    const bestTimes = analyzeBestDepartureTimes(weatherData.hourlyForecast);
    const planningRecommendations = generatePlanningRecommendations(bestTimes, weatherData.current);

    // Générer les cartes horaires
    const hourlyCards = weatherData.hourlyForecast.map(hour => {
        const score = bestTimes.find(t => t.hour.hour === hour.hour)?.score || 50;
        const scoreColor = score >= 80 ? '#28a745' : score >= 60 ? '#17a2b8' : score >= 40 ? '#ffc107' : '#dc3545';
        const weatherIcon = hour.weather.includes("soleil") ? "☀️" :
                           hour.weather.includes("nuageux") ? "☁️" :
                           hour.weather.includes("pluie") ? "🌧️" : "🌤️";

        return `
            <div class="hourly-forecast-card" style="border-left: 4px solid ${scoreColor};">
                <div class="hourly-time">${hour.hour}h</div>
                <div class="hourly-temp">${hour.temperature}°</div>
                <div class="hourly-weather">${weatherIcon} ${hour.weather}</div>
                <div class="hourly-details">
                    <span>💨 ${hour.windSpeed}km/h</span>
                    <span>💧 ${hour.humidity}%</span>
                    ${hour.precipitation > 0 ? `<span>🌧️ ${hour.precipitation}%</span>` : ''}
                </div>
                <div class="hourly-score">
                    <span style="color: ${scoreColor}">Score: ${score}/100</span>
                </div>
            </div>
        `;
    }).join('');

    // Créer la vue tableau horizontale (style MeteoMaroc)
    const bestHour = bestTimes.length > 0 ? bestTimes[0].hour.hour : null;
    const tableHourlyForecast = createHourlyForecastTable(weatherData.hourlyForecast, bestHour);

    return `
        <div class="tomorrow-forecast">
            <div class="forecast-header">
                <h4>📅 Prévisions de demain matin (7h-13h)</h4>
                <div class="forecast-summary">
                    <strong>${planningRecommendations[0] || "Analyse en cours..."}</strong>
                </div>
            </div>

            ${tableHourlyForecast}

            <div class="hourly-forecast-grid">
                ${hourlyCards}
            </div>

            ${bestTimes.length > 0 ? `
            <div class="best-times-analysis">
                <h5>🎯 Analyse des créneaux optimaux:</h5>
                <div class="best-times-list">
                    ${bestTimes.slice(0, 3).map((time, index) => {
                        const rank = index === 0 ? "🥇" : index === 1 ? "🥈" : "🥉";
                        return `
                            <div class="best-time-item">
                                <span class="rank">${rank}</span>
                                <span class="hour">${time.hour.hour}h</span>
                                <span class="temp">${time.hour.temperature}°C</span>
                                <span class="score">${time.score}/100</span>
                                ${time.recommendations.length > 0 ? `<div class="recommendations">${time.recommendations[0]}</div>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>

                ${planningRecommendations.length > 1 ? `
                <div class="planning-tips">
                    <h6>💡 Conseils de planning:</h6>
                    <ul>
                        ${planningRecommendations.slice(1).map(rec => `<li>${rec}</li>`).join('')}
                    </ul>
                </div>
                ` : ''}
            </div>
            ` : ''}

            <div class="forecast-actions">
                <button onclick="updateWeatherData()" class="btn btn-sm btn-primary">
                    🔄 Rafraîchir les prévisions
                </button>
                <button onclick="planTrainingSession()" class="btn btn-sm btn-success">
                    🚴‍♂️ Planifier ma sortie
                </button>
            </div>
        </div>
    `;
}

// Basculer les détails météo
function toggleWeatherDetails() {
    console.log("🔍 Affichage des détails météo supplémentaires...");
    alert("🔍 Analyse détaillée:\n\n• Prévisions mises à jour toutes les 30 minutes\n• Score de confort calculé en temps réel\n• Recommandations basées sur votre position géographique\n• Intégration possible avec API OpenWeatherMap pour données réelles");
}

// Planifier une session d'entraînement basée sur la météo
function planTrainingSession() {
    if (!weatherData.hourlyForecast || weatherData.hourlyForecast.length === 0) {
        alert("Prévisions météo non disponibles pour planifier la sortie.");
        return;
    }

    const bestTimes = analyzeBestDepartureTimes(weatherData.hourlyForecast);
    if (bestTimes.length === 0) {
        alert("Impossible de trouver un créneau optimal demain matin.");
        return;
    }

    const bestTime = bestTimes[0];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(bestTime.hour.hour, 0, 0, 0);

    const planningMessage = `
🚴‍♂️ PLANIFICATION DE SORTIE OPTIMALE

📅 Date: ${tomorrow.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
⏰ Heure de départ recommandée: ${bestTime.hour.hour}h00
🌡️ Température: ${bestTime.hour.temperature}°C
💨 Vent: ${bestTime.hour.windSpeed} km/h
💧 Humidité: ${bestTime.hour.humidity}%
☁️ Conditions: ${bestTime.hour.weather}
🎯 Score optimal: ${bestTime.score}/100

${bestTime.recommendations.length > 0 ? '\n📝 Recommandations:\n' + bestTime.recommendations.join('\n') : ''}

Confirmez-vous cette planification?
    `;

    if (confirm(planningMessage)) {
        // Ajouter la session planifiée au calendrier
        const sessionDate = tomorrow.toISOString().split('T')[0];
        const sessionTime = `${bestTime.hour.hour}:00`;

        // Vous pourriez ici intégrer avec votre système de calendrier existant
        console.log("Session planifiée pour:", sessionDate, sessionTime);

        // Message de confirmation
        alert(`✅ Sortie planifiée pour demain à ${bestTime.hour.hour}h!\n\nN'oubliez pas de préparer votre équipement: ${bestTime.hour.temperature}°C`);
    }
}

// Initialiser le système météo
function initializeWeatherSystem() {
    console.log("🌤️ Initialisation du système météo...");

    // Tenter de charger la météo au démarrage
    updateWeatherData().catch(error => {
        console.warn("⚠️ Impossible de charger la météo au démarrage:", error.message);
    });

    // Mettre à jour la météo toutes les 30 minutes
    setInterval(() => {
        updateWeatherData().catch(error => {
            console.warn("⚠️ Erreur lors de la mise à jour automatique de la météo:", error.message);
        });
    }, 30 * 60 * 1000); // 30 minutes
}

// Exposer les fonctions météo globalement
window.updateWeatherData = updateWeatherData;
window.createWeatherDisplay = createWeatherDisplay;
window.getUserLocation = getUserLocation;
window.setManualLocation = setManualLocation;
window.resetLocation = resetLocation;
window.openLocationPanel = openLocationPanel;
window.closeLocationPanel = closeLocationPanel;
window.setLocationFromInputs = setLocationFromInputs;
window.calculateWindImpact = calculateWindImpact;
window.initializeWeatherSystem = initializeWeatherSystem;
window.getTomorrowMorningForecast = getTomorrowMorningForecast;
window.analyzeBestDepartureTimes = analyzeBestDepartureTimes;
window.createTomorrowMorningForecastDisplay = createTomorrowMorningForecastDisplay;
window.planTrainingSession = planTrainingSession;
window.toggleWeatherDetails = toggleWeatherDetails;

// ========================================
//   SYSTÈME DE CHARGE D'ENTRAÎNEMENT (TSS/CTL/ATL/TSB)
// ========================================

// Variables globales pour la gestion de charge
let trainingLoadData = {
    dailyTSS: {},
    CTL: 0,
    ATL: 0,
    TSB: 0,
    FTP: 200, // Default FTP, sera calculé automatiquement
    lastCalculationDate: null
};

// Améliorer la fonction calculateTSS existante pour le système de charge
function calculateAdvancedTSS(session, userProgressEntry = null) {
    if (!session || !session.duration_minutes) return 0;

    // Si déjà calculé et sauvegardé
    if (userProgressEntry && userProgressEntry.tss) {
        return userProgressEntry.tss;
    }

    const duration = session.duration_minutes / 60; // en heures
    let intensityFactor = 0;

    // Calculer l'intensité en fonction du type de séance
    if (session.intensity_zone) {
        // Zones d'intensité standard (plus précises)
        const zones = {
            'endurance': 0.65,
            'tempo': 0.75,
            'seuil': 0.85,
            'VO2max': 0.95,
            'sprint': 1.2,
            'récupération': 0.55,
            'très facile': 0.50,
            'facile': 0.60,
            'modérée': 0.70,
            'soutenue': 0.80,
            'maximale': 1.0
        };
        intensityFactor = zones[session.intensity_zone] || 0.75;
    } else if (session.avg_power && trainingLoadData.FTP) {
        // Calcul basé sur la puissance moyenne
        intensityFactor = session.avg_power / trainingLoadData.FTP;
    } else {
        // Estimation basée sur le type de séance
        const intensityByType = {
            'sortie_longue': 0.65,
            'intervalles': 0.85,
            'seuil': 0.88,
            'récupération': 0.55,
            'endurance': 0.72,
            'endurance_fondamentale': 0.68,
            'fartlek': 0.80,
            'clm': 0.95,
            'spécifique': 0.82
        };
        intensityFactor = intensityByType[session.activity_type] || 0.75;
    }

    // Formule TSS = (duration × IF² × 100)
    const tss = Math.round(duration * Math.pow(intensityFactor, 2) * 100);

    console.log(`TSS avancé calculé: ${tss} (durée: ${duration}h, IF: ${intensityFactor.toFixed(2)})`);
    return tss;
}

// Calculer CTL avancé (Chronic Training Load) - forme sur 42 jours
function calculateAdvancedCTL(dailyTSS, targetDate) {
    const endDate = new Date(targetDate);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 42); // 42 jours en arrière

    let totalTSS = 0;
    let count = 0;

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        if (dailyTSS[dateStr]) {
            totalTSS += dailyTSS[dateStr];
            count++;
        }
    }

    return count > 0 ? Math.round(totalTSS / count * 42) : 0;
}

// Calculer ATL avancé (Acute Training Load) - fatigue sur 7 jours
function calculateAdvancedATL(dailyTSS, targetDate) {
    const endDate = new Date(targetDate);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 7); // 7 jours en arrière

    let totalTSS = 0;
    let count = 0;

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        if (dailyTSS[dateStr]) {
            totalTSS += dailyTSS[dateStr];
            count++;
        }
    }

    return count > 0 ? Math.round(totalTSS / count * 7) : 0;
}

// Calculer TSB avancé (Training Stress Balance) - état de forme
function calculateAdvancedTSB(CTL, ATL) {
    return Math.round(CTL - ATL);
}

// Mettre à jour les données de charge d'entraînement
function updateTrainingLoadData() {
    console.log("🔄 Mise à jour des données de charge d'entraînement...");

    // Récupérer les données sauvegardées si existantes
    if (userProgress.trainingLoadData) {
        trainingLoadData = { ...trainingLoadData, ...userProgress.trainingLoadData };
    }

    // Calculer TSS quotidien à partir des séances complétées
    const dailyTSS = {};

    Object.keys(userProgress).forEach(dateStr => {
        if (userProgress[dateStr].completed && trainingProgramData.sessions[dateStr]) {
            const session = trainingProgramData.sessions[dateStr];
            const tss = calculateAdvancedTSS(session, userProgress[dateStr]);

            // Sauvegarder le TSS calculé
            if (!userProgress[dateStr].tss) {
                userProgress[dateStr].tss = tss;
            }

            dailyTSS[dateStr] = tss;
        }
    });

    trainingLoadData.dailyTSS = dailyTSS;
    trainingLoadData.lastCalculationDate = new Date().toISOString();

    // Calculer CTL/ATL/TSB pour aujourd'hui
    const today = new Date();
    trainingLoadData.ATL = calculateAdvancedATL(dailyTSS, today);
    trainingLoadData.CTL = calculateAdvancedCTL(dailyTSS, today);
    trainingLoadData.TSB = calculateAdvancedTSB(trainingLoadData.CTL, trainingLoadData.ATL);

    console.log("📊 Charge d'entraînement mise à jour:");
    console.log(`  - ATL (fatigue): ${trainingLoadData.ATL}`);
    console.log(`  - CTL (forme): ${trainingLoadData.CTL}`);
    console.log(`  - TSB (état actuel): ${trainingLoadData.TSB}`);

    // Sauvegarder dans userProgress pour persistance
    userProgress.trainingLoadData = trainingLoadData;
    scheduleRemoteSave();
}

// Obtenir l'interprétation avancée du TSB
function getAdvancedTSBInterpretation(tsb) {
    if (tsb > 25) return { status: "🔥 FORME MAX", color: "#28a745", description: "Excellente forme, prêt pour les objectifs !" };
    if (tsb > 10) return { status: "✅ Bonne forme", color: "#17a2b8", description: "État de forme positif" };
    if (tsb > -10) return { status: "⚖️ Équilibre", color: "#ffc107", description: "Équilibre entraînement/récupération" };
    if (tsb > -30) return { status: "😰 Fatigue légère", color: "#fd7e14", description: "Légère fatigue, récupération nécessaire" };
    return { status: "⚠️ FATIGUE ÉLEVÉE", color: "#dc3545", description: "Surcharge d'entraînement, repos requis" };
}

// Créer le tableau de bord de charge d'entraînement
function createTrainingLoadDashboard() {
    const tsbInfo = getAdvancedTSBInterpretation(trainingLoadData.TSB);

    const dashboardHTML = `
        <div class="training-load-dashboard">
            <h3>📊 Gestion de la Charge d'Entraînement</h3>

            ${createWeatherDisplay()}

            <div class="load-metrics-grid">
                <div class="load-metric-card atl-card">
                    <div class="metric-header">
                        <span class="metric-icon">⚡</span>
                        <span class="metric-title">ATL</span>
                    </div>
                    <div class="metric-value">${trainingLoadData.ATL}</div>
                    <div class="metric-subtitle">Fatigue (7 jours)</div>
                </div>

                <div class="load-metric-card ctl-card">
                    <div class="metric-header">
                        <span class="metric-icon">💪</span>
                        <span class="metric-title">CTL</span>
                    </div>
                    <div class="metric-value">${trainingLoadData.CTL}</div>
                    <div class="metric-subtitle">Forme (42 jours)</div>
                </div>

                <div class="load-metric-card tsb-card">
                    <div class="metric-header">
                        <span class="metric-icon">⚖️</span>
                        <span class="metric-title">TSB</span>
                    </div>
                    <div class="metric-value" style="color: ${tsbInfo.color}">${trainingLoadData.TSB}</div>
                    <div class="metric-subtitle">${tsbInfo.status}</div>
                </div>
            </div>

            <div class="tsb-interpretation" style="background: ${tsbInfo.color}20; border-left: 4px solid ${tsbInfo.color}; padding: 15px; margin-top: 20px; border-radius: 5px;">
                <strong>${tsbInfo.status}</strong>
                <p style="margin: 5px 0;">${tsbInfo.description}</p>
            </div>

            <button onclick="updateTrainingLoadData()" class="btn btn-primary btn-sm mt-3">
                🔄 Mettre à jour la charge
            </button>
        </div>
    `;

    return dashboardHTML;
}

// Initialiser le tableau de bord de charge d'entraînement
function initializeTrainingLoadDashboard() {
    console.log("🏋️ Initialisation du tableau de bord de charge d'entraînement...");

    // Récupérer les données sauvegardées si existantes
    if (userProgress.trainingLoadData) {
        trainingLoadData = { ...trainingLoadData, ...userProgress.trainingLoadData };
    }

    // Mettre à jour les données de charge
    updateTrainingLoadData();

    // Charger les données météo si pas encore fait
    if (!weatherData.current || !weatherData.current.temperature) {
        console.log("🌤️ Chargement des données météo pour le dashboard...");
        updateWeatherData().catch(error => {
            console.warn("⚠️ Erreur chargement météo:", error.message);
        });
    }

    // Charger le contenu immédiatement
    loadTrainingLoadContent();

    // Observer les changements d'onglet pour recharger au besoin
    const loadTab = document.getElementById('tab-load-link');
    if (loadTab) {
        loadTab.addEventListener('click', function() {
            console.log("📊 Clic sur l'onglet Charge d'entraînement");
            setTimeout(() => loadTrainingLoadContent(), 100);
        });

        // Essayer aussi avec l'événement Bootstrap
        loadTab.addEventListener('shown.bs.tab', function() {
            console.log("📊 Affichage du tableau de bord de charge d'entraînement (Bootstrap)");
            loadTrainingLoadContent();
        });
    }
}

// Charger le contenu du tableau de bord de charge d'entraînement
function loadTrainingLoadContent() {
    console.log("🔄 Chargement du contenu de charge d'entraînement...");

    const contentDiv = document.getElementById('trainingLoadContent');
    if (!contentDiv) {
        console.error("❌ Élément 'trainingLoadContent' non trouvé");
        return;
    }

    // Tenter de charger les données météo si non disponibles
    if (!weatherData.current || !weatherData.current.temperature) {
        console.log("🌤️ Tentative de chargement des données météo...");
        updateWeatherData().catch(error => {
            console.warn("⚠️ Erreur chargement météo dans loadTrainingLoadContent:", error.message);
        });
    }

    try {
        // Mettre à jour les données de charge d'entraînement
        updateTrainingLoadData();

        // Générer et afficher le tableau de bord
        const dashboardHTML = createTrainingLoadDashboard();
        contentDiv.innerHTML = dashboardHTML;

        console.log("✅ Tableau de bord de charge d'entraînement chargé");
        console.log(`📊 ATL: ${trainingLoadData.ATL}, CTL: ${trainingLoadData.CTL}, TSB: ${trainingLoadData.TSB}`);

        // Animer les cartes de métriques
        setTimeout(() => {
            const cards = contentDiv.querySelectorAll('.load-metric-card');
            if (cards.length > 0) {
                console.log(`🎯 Animation de ${cards.length} cartes de métriques`);
                cards.forEach((card, index) => {
                    setTimeout(() => {
                        card.classList.add('updating');
                        setTimeout(() => {
                            card.classList.remove('updating');
                        }, 1000);
                    }, index * 200);
                });
            }
        }, 100);

    } catch (error) {
        console.error("❌ Erreur lors du chargement du tableau de bord:", error);
        contentDiv.innerHTML = `
            <div class="alert alert-danger">
                <h4>❌ Erreur de chargement</h4>
                <p>Impossible de charger le tableau de bord de charge d'entraînement.</p>
                <button onclick="loadTrainingLoadContent()" class="btn btn-primary btn-sm">
                    🔄 Réessayer
                </button>
            </div>
        `;
    }
}

// Exporter les données de charge
function exportTrainingLoadData() {
    const data = {
        ...trainingLoadData,
        exportDate: new Date().toISOString(),
        userProgress: userProgress
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `training_load_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// Exposer les fonctions globalement
window.toggleSessionStatus = toggleSessionStatus;
window.updateTrainingLoadData = updateTrainingLoadData;
window.createTrainingLoadDashboard = createTrainingLoadDashboard;
window.getAdvancedTSBInterpretation = getAdvancedTSBInterpretation;
window.exportTrainingLoadData = exportTrainingLoadData;
window.initializeTrainingLoadDashboard = initializeTrainingLoadDashboard;
window.loadTrainingLoadContent = loadTrainingLoadContent;
window.calculateAdvancedTSS = calculateAdvancedTSS;
window.calculateAdvancedCTL = calculateAdvancedCTL;
window.calculateAdvancedATL = calculateAdvancedATL;
window.calculateAdvancedTSB = calculateAdvancedTSB;

// Exposer les fonctions restantes (celles qui ne sont pas déjà définies directement)
window.isBrytonActivityInLibrary = isBrytonActivityInLibrary;
window.initializeOptimizedLibrary = initializeOptimizedLibrary;
window.migrateExistingRoutes = migrateExistingRoutes;
window.filterRoutes = filterRoutes;
window.resetFilters = resetFilters;
window.changeViewMode = changeViewMode;
window.exportRoutes = exportRoutes;
window.toggleFavorite = toggleFavorite;

// Exposer les fonctions utilitaires nécessaires
window.formatDate = formatDate;
window.formatDistance = formatDistance;
window.formatDurationSimple = formatDurationSimple;
window.formatDurationForMap = formatDurationForMap;
window.getSourceLabel = getSourceLabel;
window.showNotification = showNotification;
window.deleteRoute = deleteRoute;

// Exposer les fonctions d'importation Strava
window.processGPXFile = processGPXFile;
window.parseGPXContent = parseGPXContent;
window.parseTCXContent = parseTCXContent;
window.calculateDistance = calculateDistance;
window.calculateElevationGain = calculateElevationGain;
window.addImportedRouteToLibrary = addImportedRouteToLibrary;
window.handleFITFileImport = handleFITFileImport;

// Fonction de test pour vérifier l'accessibilité
window.testBrytonFunctions = function() {
    console.log('🧪 Test des fonctions Bryton:');
    console.log('  convertBrytonActivityToRoute:', typeof window.convertBrytonActivityToRoute);
    console.log('  importAllBrytonActivities:', typeof window.importAllBrytonActivities);
    console.log('  importRecentBrytonActivities:', typeof window.importRecentBrytonActivities);
    console.log('  syncBrytonWithLibrary:', typeof window.syncBrytonWithLibrary);
    console.log('  removeBrytonRouteFromLibrary:', typeof window.removeBrytonRouteFromLibrary);
    console.log('  brytonActivities:', typeof brytonActivities, 'count:', brytonActivities ? Object.keys(brytonActivities).length : 'N/A');
    console.log('  savedRoutes:', typeof savedRoutes, 'count:', savedRoutes ? savedRoutes.length : 'N/A');
    return {
        convertBrytonActivityToRoute: typeof window.convertBrytonActivityToRoute,
        importAllBrytonActivities: typeof window.importAllBrytonActivities,
        importRecentBrytonActivities: typeof window.importRecentBrytonActivities,
        syncBrytonWithLibrary: typeof window.syncBrytonWithLibrary,
        removeBrytonRouteFromLibrary: typeof window.removeBrytonRouteFromLibrary
    };
};

// Fonction de test pour l'importation Strava
window.testStravaImport = function() {
    console.log('🚴 Test des fonctions d\'importation Strava:');
    console.log('  importStravaRoute:', typeof window.importStravaRoute);
    console.log('  importGPXFile:', typeof window.importGPXFile);
    console.log('  processGPXFile:', typeof window.processGPXFile);
    console.log('  parseGPXContent:', typeof window.parseGPXContent);
    console.log('  parseTCXContent:', typeof window.parseTCXContent);
    console.log('  addImportedRouteToLibrary:', typeof window.addImportedRouteToLibrary);
    console.log('  Élément gpxFileInput:', !!document.getElementById('gpxFileInput'));

    return {
        importStravaRoute: typeof window.importStravaRoute,
        importGPXFile: typeof window.importGPXFile,
        processGPXFile: typeof window.processGPXFile,
        parseGPXContent: typeof window.parseGPXContent,
        parseTCXContent: typeof window.parseTCXContent,
        addImportedRouteToLibrary: typeof window.addImportedRouteToLibrary,
        gpxFileInputExists: !!document.getElementById('gpxFileInput')
    };
};