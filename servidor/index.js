const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3000;

// Configuración de SQLite
const dbPath = path.join(__dirname, 'feeder_logs.db');
const db = new Database(dbPath);

// Crear tabla de registros si no existe
db.prepare(`
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        accion TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`).run();

app.use(express.static(path.join(__dirname, '../public')));

// Traduce comandos crudos a descripciones legibles para el usuario
function describirComando(cmd) {
    const parts = cmd.trim().split(/\s+/);
    const tipo = parts[0];
    const valor = parts[1];

    switch (tipo) {
        case '1': {
            const g = parseInt(valor, 10) || 0;
            const gramos = Math.abs(Math.round(g / 10));
            return g >= 0
                ? `Dosificador giró ${gramos} g de alimento`
                : `Dosificador retrocedió ${gramos} g`;
        }
        case '2':
            return valor === '90' || valor === '180'
                ? 'Se abrió la compuerta superior'
                : 'Se cerró la compuerta superior';
        case '3':
            return valor === '90' || valor === '180'
                ? 'Se abrió la compuerta inferior'
                : 'Se cerró la compuerta inferior';
        case '4':
            return valor === '1'
                ? 'Humedecedor activado 💧'
                : 'Humedecedor desactivado';
        case '5':
            return 'Ciclo de limpieza de faja ejecutado 🧹';
        case '6': {
            const n = parseInt(valor, 10) || 1;
            return `Se dispensaron ${n} ración(es) · ${n * 12} g de alimento 🍖`;
        }
        default:
            return `Acción del sistema: ${cmd}`;
    }
}

// Función para enviar los últimos logs a un cliente
function enviarHistorial(ws) {
    const stmt = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 20');
    const logs = stmt.all().reverse();
    ws.send(JSON.stringify({ type: 'history', data: logs }));
}

// Función para registrar y broadcast a todos
function registrarYTransmitir(accion) {
    const stmt = db.prepare('INSERT INTO logs (accion) VALUES (?)');
    const info = stmt.run(accion);

    const nuevoLog = { id: info.lastInsertRowid, accion, timestamp: new Date().toISOString() };

    wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            client.send(JSON.stringify({ type: 'new_log', data: nuevoLog }));
        }
    });
}

wss.on('connection', (ws) => {
    console.log('Cliente web conectado.');

    // Enviar historial al conectar
    enviarHistorial(ws);

    ws.on('message', (message) => {
        const mensajeStr = message.toString();
        console.log(`Comando recibido: ${mensajeStr}`);

        // Traducir a descripción legible antes de guardar
        const descripcion = describirComando(mensajeStr);
        registrarYTransmitir(descripcion);
    });

    ws.on('close', () => {
        console.log('Cliente web desconectado.');
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log(`Acceso desde otra red: http://192.168.0.208:${PORT}`);
});
