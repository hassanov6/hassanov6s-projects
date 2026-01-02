const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3004;

const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);

    // Extension par défaut
    let extname = path.extname(filePath);
    let contentType = 'text/html';

    // Types MIME corrects
    switch (extname) {
        case '.js':
            contentType = 'application/javascript';
            break;
        case '.mjs':
            contentType = 'application/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
        case '.json':
            contentType = 'application/json';
            break;
        case '.png':
            contentType = 'image/png';
            break;
        case '.jpg':
            contentType = 'image/jpg';
            break;
    }

    // Lire le fichier
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // Fichier non trouvé
                fs.readFile(path.join(__dirname, '404.html'), (err, content404) => {
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    res.end(content404 || '404 Not Found');
                });
            } else {
                // Erreur serveur
                res.writeHead(500);
                res.end(`Server Error: ${err.code}`);
            }
        } else {
            // Succès
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
});