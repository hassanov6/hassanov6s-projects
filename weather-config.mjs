// ========================================
//   CONFIGURATION MÉTÉO PERSONNELLE
// ========================================

// Étape 1: Obtenez votre clé API GRATUITE sur https://openweathermap.org/
// Étape 2: Remplacez "YOUR_API_KEY_HERE" par votre vraie clé
// Étape 3: Ce fichier sera utilisé automatiquement par le système

const WEATHER_CONFIG = {
    // METTREZ VOTRE CLÉ API ICI (FREE - 1000 appels/jour)
    apiKey: "cf9a837b3587ea62fe9694d15cf44af5",

    // Configuration OpenWeatherMap
    units: "metric",        // Celsius, km/h
    lang: "fr",            // Langue française

    // Configuration des prévisions
    forecastDays: 7,      // Jours de prévision
    hourlyForecast: true, // Prévisions horaires

    // Région par défaut (si géolocalisation échoue)
    defaultLocation: {
        lat: 48.8566,   // Paris (remplacez par votre ville)
        lon: 2.3522,
        name: "Paris"
    },

    // Fréquence de mise à jour (en minutes)
    updateInterval: 30,

    // Options avancées
    enableWindAnalysis: true,
    enablePrecipitationAlerts: true,
    enableUVIndex: false,
    enableAirQuality: false
};

// Validation de la configuration
function validateWeatherConfig() {
    if (WEATHER_CONFIG.apiKey === "YOUR_API_KEY_HERE") {
        console.warn("⚠️ Veuillez configurer votre clé API OpenWeatherMap dans weather-config.js");
        console.log("📖 Instructions:");
        console.log("1. Allez sur https://openweathermap.org/");
        console.log("2. Créez un compte gratuit");
        console.log("3. Obtenez votre clé API dans 'My API keys'");
        console.log("4. Remplacez 'YOUR_API_KEY_HERE' par votre clé");
        return false;
    }
    return true;
}

// Exporter la configuration
export { WEATHER_CONFIG, validateWeatherConfig };

// Afficher les instructions si pas configuré
if (typeof window !== 'undefined') {
    window.validateWeatherConfig = validateWeatherConfig;
    console.log("🌤️ Système météo initialisé");

    // Instructions dans la console
    console.log("\n📋 Pour configurer les prévisions météo réelles:");
    console.log("1. Éditez le fichier weather-config.js");
    console.log("2. Remplacez YOUR_API_KEY_HERE par votre clé OpenWeatherMap");
    console.log("3. Rechargez la page pour appliquer les changements");
    console.log("\n🔗 OpenWeatherMap: https://openweathermap.org/");
}