// ===========================
//  ASTEROIDS X — SERVER.JS
// ===========================
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.get('/', (req, res) => res.send('Asteroids X Server running'));

// ===========================
//  ESTADO GLOBAL
// ===========================
const rooms = {};  // { roomId: { players, mode, started, bets } }

function createRoom(roomId, mode = 'ranked') {
    rooms[roomId] = {
        id: roomId,
        mode: mode,        // 'ranked' o 'practice'
        players: {},
        started: false,
        bets: {},
        createdAt: Date.now()
    };
    return rooms[roomId];
}

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        mode: r.mode,
        playerCount: Object.keys(r.players).length,
        maxPlayers: 4,
        started: r.started
    }));
}

// ===========================
//  CONEXIONES
// ===========================
io.on('connection', (socket) => {
    console.log('Jugador conectado:', socket.id);

    // --- Pedir lista de salas ---
    socket.on('get_rooms', () => {
        socket.emit('room_list', getRoomList());
    });

    // --- Crear sala ---
    socket.on('create_room', ({ roomId, mode, playerName }) => {
        if (rooms[roomId]) {
            socket.emit('error_msg', 'Esa sala ya existe');
            return;
        }
        const room = createRoom(roomId, mode || 'ranked');
        joinRoom(socket, roomId, playerName);
        io.emit('room_list', getRoomList()); // actualizar lista para todos
    });

    // --- Unirse a sala ---
    socket.on('join_room', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) { socket.emit('error_msg', 'Sala no encontrada'); return; }
        if (Object.keys(room.players).length >= 4) {
            socket.emit('error_msg', 'Sala llena'); return;
        }
        joinRoom(socket, roomId, playerName);
        io.emit('room_list', getRoomList());
    });

    // --- Actualizar posición del jugador ---
    socket.on('player_update', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        // Actualizar estado del jugador en el servidor
        if (rooms[roomId].players[socket.id]) {
            rooms[roomId].players[socket.id] = {
                ...rooms[roomId].players[socket.id],
                ...data,
                id: socket.id
            };
        }
        // Enviar a TODOS en la sala incluyendo al emisor para confirmar
        io.to(roomId).emit('players_state', rooms[roomId].players);
    });

    // --- Jugador disparó ---
    socket.on('player_shoot', (bullet) => {
        const roomId = socket.roomId;
        if (!roomId) return;
        socket.to(roomId).emit('remote_bullet', {
            ...bullet,
            ownerId: socket.id
        });
    });

    // --- Jugador murió ---
    socket.on('player_died', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        if (rooms[roomId].players[socket.id]) {
            rooms[roomId].players[socket.id].alive = false;
        }

        io.to(roomId).emit('player_died', { id: socket.id });

        // Verificar si queda un solo jugador vivo
        checkWinner(roomId);
    });

    // --- Salir de sala ---
    socket.on('leave_room', () => {
        leaveRoom(socket);
        io.emit('room_list', getRoomList());
    });

    // --- Desconexión ---
    socket.on('disconnect', () => {
        console.log('Jugador desconectado:', socket.id);
        leaveRoom(socket);
        io.emit('room_list', getRoomList());
    });
});

// ===========================
//  FUNCIONES AUXILIARES
// ===========================
function joinRoom(socket, roomId, playerName) {
    socket.join(roomId);
    socket.roomId = roomId;

    const spawnX = 500 + Math.random() * 3000;
    const spawnY = 500 + Math.random() * 3000;

    rooms[roomId].players[socket.id] = {
        id: socket.id,
        name: playerName || 'Jugador',
        x: spawnX,
        y: spawnY,
        angle: 0,
        speed: 0,
        alive: true,
        score: 0,
        color: getPlayerColor(Object.keys(rooms[roomId].players).length - 1)
    };

    // Generar semilla del mundo si es el primer jugador
    if (!rooms[roomId].worldSeed) {
        rooms[roomId].worldSeed = Math.floor(Math.random() * 999999);
    }

    io.to(roomId).emit('player_joined', {
        id: socket.id,
        player: rooms[roomId].players[socket.id],
        allPlayers: rooms[roomId].players,
        roomMode: rooms[roomId].mode
    });
    /// confirmar que entro el jugador
    socket.emit('joined_room', {
        roomId,
        myId: socket.id,
        players: rooms[roomId].players,
        mode: rooms[roomId].mode,
        worldSeed: rooms[roomId].worldSeed
    });

    console.log(`${playerName} entró a sala ${roomId}`);
}

function leaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    delete rooms[roomId].players[socket.id];
    socket.leave(roomId);
    socket.roomId = null;

    // Avisar a los demás
    io.to(roomId).emit('player_left', { id: socket.id });

    // Eliminar sala si está vacía
    const playerCount = Object.keys(rooms[roomId].players).length;
    if (playerCount === 0) {
        delete rooms[roomId];
        console.log(`Sala ${roomId} eliminada`);
    } else {
        checkWinner(roomId);
    }
}

function checkWinner(roomId) {
    if (!rooms[roomId]) return;
    const alive = Object.values(rooms[roomId].players).filter(p => p.alive);
    if (alive.length === 1 && Object.keys(rooms[roomId].players).length > 1) {
        io.to(roomId).emit('game_winner', { winnerId: alive[0].id, winnerName: alive[0].name });
        // Reiniciar sala después de 5 segundos
        setTimeout(() => {
            if (rooms[roomId]) {
                Object.values(rooms[roomId].players).forEach(p => p.alive = true);
                rooms[roomId].started = false;
                io.to(roomId).emit('room_reset');
            }
        }, 5000);
    }
}

function getPlayerColor(index) {
    const colors = ['#00f5ff', '#ff4444', '#39ff14', '#f72585'];
    return colors[index % colors.length];
}

// ===========================
//  ARRANCAR SERVIDOR
// ===========================
const PORT = process.env.PORT || 3000;
// Limpiar salas vacías cada 60 segundos
setInterval(() => {
    Object.keys(rooms).forEach(roomId => {
        const count = Object.keys(rooms[roomId].players).length;
        if (count === 0) {
            delete rooms[roomId];
            console.log(`Sala ${roomId} eliminada por inactividad`);
        }
    });
}, 60000);
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});