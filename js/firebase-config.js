
// Configuration Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, get, onValue, push, update, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Importer la configuration météo
import { WEATHER_CONFIG } from "../weather-config.mjs";
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

// Exporter toutes les fonctions nécessaires
export { db, auth, ref, set, get, onValue, push, update, remove, onAuthStateChanged, WEATHER_CONFIG };