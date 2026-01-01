// Endpoint API pour synchronisation APK
// Ce fichier est appelé par l'APK pour récupérer les données

// Charge les données depuis le localStorage du site
const apiData = {
    export_date: new Date().toISOString(),
    version: "1.0",
    completed_sessions: [],
    total_completed: 0
};

// Essayer de charger les données depuis window.trainingProgram
try {
    if (typeof window !== 'undefined' && window.trainingProgram && window.trainingProgram.sessions) {
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

                const sessionData = {
                    date: date,
                    session_type: session.session_type || "Endurance",
                    duration_minutes: session.duration_minutes || 0,
                    completed_at: completedData.completedAt || new Date().toISOString(),
                    zone_times: zoneTimes
                };

                apiData.completed_sessions.push(sessionData);
            }
        }

        apiData.total_completed = apiData.completed_sessions.length;
    }
} catch (error) {
    console.error("Erreur lors de la génération de l'API:", error);
}

// Exporter pour être utilisé par le site
if (typeof module !== 'undefined' && module.exports) {
    module.exports = apiData;
} else {
    // Dans le navigateur, on écrit directement dans le document si c'est une requête API
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('format') && urlParams.get('format') === 'json') {
        // Si le paramètre format=json est présent, on retourne du JSON pur
        document.open();
        document.write(JSON.stringify(apiData, null, 2));
        document.close();
    }
}
