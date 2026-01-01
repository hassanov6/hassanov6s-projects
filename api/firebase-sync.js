// Vercel Serverless Function pour synchronisation Firebase
export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // Récupérer les données depuis Firebase
        const firebaseUrl = 'https://cycling-tracker-projet-default-rtdb.europe-west1.firebasedatabase.app/users.json';

        const response = await fetch(firebaseUrl);

        if (!response.ok) {
            throw new Error(`Firebase returned status: ${response.status}`);
        }

        const usersData = await response.json();

        if (!usersData || Object.keys(usersData).length === 0) {
            return res.json({
                export_date: new Date().toISOString(),
                version: '1.0',
                completed_sessions: [],
                total_completed: 0,
                message: 'No data found in Firebase'
            });
        }

        // Récupérer le premier utilisateur
        const firstUserKey = Object.keys(usersData)[0];
        const userData = usersData[firstUserKey];

        if (!userData || !userData.sessions) {
            return res.json({
                export_date: new Date().toISOString(),
                version: '1.0',
                completed_sessions: [],
                total_completed: 0,
                message: 'No sessions found'
            });
        }

        const sessionsData = userData.sessions;

        if (!sessionsData.completed_sessions) {
            return res.json({
                export_date: new Date().toISOString(),
                version: '1.0',
                completed_sessions: [],
                total_completed: 0,
                message: 'No completed sessions found'
            });
        }

        // Transformer le format si nécessaire
        const completedSessions = sessionsData.completed_sessions.map(session => {
            const zoneTimes = {
                z1: session.zone_times?.z1 || 0,
                z2: session.zone_times?.z2 || 0,
                z3: session.zone_times?.z3 || 0,
                z4: session.zone_times?.z4 || 0,
                z5: session.zone_times?.z5 || 0
            };

            return {
                date: session.date,
                session_type: session.session_type || 'Endurance',
                duration_minutes: session.duration_minutes || 0,
                completed_at: session.completed_at || new Date().toISOString(),
                zone_times: zoneTimes
            };
        });

        const exportData = {
            export_date: new Date().toISOString(),
            version: '1.0',
            completed_sessions: completedSessions,
            total_completed: completedSessions.length
        };

        return res.json(exportData);

    } catch (error) {
        console.error('Error syncing from Firebase:', error);
        return res.status(500).json({
            error: error.message,
            export_date: new Date().toISOString(),
            version: '1.0',
            completed_sessions: [],
            total_completed: 0
        });
    }
}
