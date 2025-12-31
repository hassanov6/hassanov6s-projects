// =====================================================================
// API POUR SYNCHRONISATION AVEC APK - Sessions terminées
// =====================================================================

function exportCompletedSessionsForApp() {
    console.log("🚀 Démarrage de l'export pour APK...");

    const completedSessions = [];

    // Vérifier que les données existent
    if (!window.trainingProgram || !window.trainingProgram.sessions) {
        console.error("❌ trainingProgram non trouvé");
        return {error: "Données d'entraînement non trouvées"};
    }

    console.log("📊 Recherche des sessions...");

    // Parcourir toutes les sessions et sélectionner celles qui sont marquées comme complétées
    for (const date in trainingProgram.sessions) {
        const session = trainingProgram.sessions[date];
        const completedData = window.userProgress ? window.userProgress[date] : null;

        if (completedData && completedData.completed) {
            console.log("✅ Session trouvée: " + date + " (" + (session.session_type || "Endurance") + ")");

            // Extraire les temps de zone si disponibles
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

            completedSessions.push(sessionData);
        }
    }

    console.log("🎯 Export de " + completedSessions.length + " sessions terminées");

    // Créer le format compatible APK
    const exportData = {
        export_date: new Date().toISOString(),
        version: "1.0",
        completed_sessions: completedSessions,
        total_completed: completedSessions.length
    };

    console.log("✅ Export terminé");
    return exportData;
}

// Exposer globalement pour que l'APK puisse y accéder
window.getApiExport = exportCompletedSessionsForApp;

console.log("🎉 API pour APK chargée avec succès !");
console.log("📖 Utilisez getApiExport() pour obtenir les données");
