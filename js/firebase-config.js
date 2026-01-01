// Configuration Firebase pour synchronisation
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, onValue, push, update, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Configuration Firebase
const firebaseConfig = {
  apiKey: "AIzaSyCSAyZZSqjun0C0fc4MZze4o3oy05oK6LY",
  authDomain: "cycling-tracker-projet.firebaseapp.com",
  databaseURL: "https://cycling-tracker-projet-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "cycling-tracker-projet",
  storageBucket: "cycling-tracker-projet.firebasestorage.app",
  messagingSenderId: "545589672511",
  appId: "1:545589672511:web:8307e64f37b32a4199168a",
  measurementId: "G-Q62FG5D7QK"
};

// Initialisation Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);

// Fonction d'authentification anonyme
export async function authenticateUser() {
    return new Promise((resolve, reject) => {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                console.log("Utilisateur authentifié avec UID:", user.uid);
                resolve(user);
            } else {
                signInAnonymously(auth)
                    .then((userCredential) => {
                        console.log("Nouvel utilisateur anonyme créé:", userCredential.user.uid);
                        resolve(userCredential.user);
                    })
                    .catch((error) => {
                        console.error("Erreur d'authentification:", error);
                        reject(error);
                    });
            }
        });
    });
}

// API de synchronisation avec Firebase pour APK
export async function syncWithFirebase(deviceId) {
    try {
        const user = await authenticateUser();
        const sessionsRef = ref(db, `users/${user.uid}/sessions`);

        // Récupérer les sessions depuis Firebase
        const snapshot = await get(sessionsRef);
        const firebaseSessions = snapshot.exists() ? snapshot.val() : {};

        // Exporter les sessions complétées
        const completedSessions = [];

        if (window.trainingProgram && window.trainingProgram.sessions) {
            for (const date in window.trainingProgram.sessions) {
                const session = window.trainingProgram.sessions[date];
                const completedData = window.userProgress ? window.userProgress[date] : null;

                if (completedData && completedData.completed) {
                    const zoneTimes = {
                        z1: completedData.zoneTimes?.[0] || 0,
                        z2: completedData.zoneTimes?.[1] || 0,
                        z3: completedData.zoneTimes?.[2] || 0,
                        z4: completedData.zoneTimes?.[3] || 0,
                        z5: completedData.zoneTimes?.[4] || 0
                    };

                    completedSessions.push({
                        date: date,
                        session_type: session.session_type || "Endurance",
                        duration_minutes: session.duration_minutes || 0,
                        completed_at: completedData.completedAt || new Date().toISOString(),
                        zone_times: zoneTimes
                    });
                }
            }
        }

        const exportData = {
            export_date: new Date().toISOString(),
            version: "1.0",
            completed_sessions: completedSessions,
            total_completed: completedSessions.length,
            device_id: deviceId
        };

        // Sauvegarder dans Firebase
        await set(sessionsRef, exportData);

        console.log("✅ Données synchronisées avec Firebase");
        return exportData;
    } catch (error) {
        console.error("❌ Erreur de synchronisation Firebase:", error);
        return {error: error.message};
    }
}

// Récupérer les sessions depuis Firebase
export async function getSessionsFromFirebase(deviceId) {
    try {
        const user = await authenticateUser();
        const sessionsRef = ref(db, `users/${user.uid}/sessions`);

        const snapshot = await get(sessionsRef);
        if (snapshot.exists()) {
            return snapshot.val();
        } else {
            return null;
        }
    } catch (error) {
        console.error("❌ Erreur de récupération Firebase:", error);
        return {error: error.message};
    }
}

// Exporter les fonctions nécessaires
export { db, auth, ref, set, get, onValue, push, update, remove, onAuthStateChanged };
