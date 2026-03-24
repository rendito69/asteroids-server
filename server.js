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

const rooms = {};

function createRoom(roomId, mode = 'ranked') {
    rooms[roomId] = {
        id: roomId,
        mode: mode,
        players: {},
        started: false,
        bets: {},
        worldSeed: Math.floor(Math.random() * 999999),
        createdAt: Date.now(),
        ownerId: null
    };
    return rooms[roomId];
}

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id,
        mode: r.mode,
        playerCount: Object.keys(r.players).length,
        maxPlayers: 4,
        started: r.started,
        ownerId: r.ownerId
    }));
}

io.on('connection', (socket) => {
    console.log('Jugador conectado:', socket.id);

    socket.on('get_rooms', () => {
        socket.emit('room_list', getRoomList());
    });

    socket.on('create_room', ({ roomId, mode, playerName }) => {
        if (rooms[roomId]) {
            socket.emit('error_msg', 'Esa sala ya existe');
            return;
        }
        const room = createRoom(roomId, mode || 'ranked');
        room.ownerId = socket.id;
        joinRoom(socket, roomId, playerName);
        io.emit('room_list', getRoomList());
    });

    socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
        if (!room) { socket.emit('error_msg', 'Sala no encontrada'); return; }
        if (room.started) { socket.emit('error_msg', 'Partida ya iniciada'); return; }
        if (Object.keys(room.players).length >= 4) {
            socket.emit('error_msg', 'Sala llena'); return;
        }
        joinRoom(socket, roomId, playerName);
        io.emit('room_list', getRoomList());
    });

    // El dueño inicia la partida
    socket.on('start_game', () => {
    const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        if (rooms[roomId].ownerId !== socket.id) {
            socket.emit('error_msg', 'Solo el creador puede iniciar');
            return;
        }
        rooms[roomId].started = true;
        io.to(roomId).emit('game_started', {
            worldSeed: rooms[roomId].worldSeed,
            players: rooms[roomId].players
        });
        io.emit('room_list', getRoomList());
        console.log(`Partida iniciada en sala ${roomId}`);
    });

    socket.on('player_update', (data) => {
                // Estado del mundo (solo el host lo envía)
        socket.on('world_update', (data) => {
            const roomId = socket.roomId;
            if (!roomId || !rooms[roomId]) return;
            // Solo el dueño puede enviar el estado del mundo
            if (rooms[roomId].ownerId !== socket.id) return;
            // Reenviar a todos menos al dueño
            socket.to(roomId).emit('world_state', data);
        });

        // Evento sincronizado: asteroide destruido
        socket.on('asteroid_destroyed', (data) => {
            const roomId = socket.roomId;
            if (!roomId) return;
            socket.to(roomId).emit('asteroid_destroyed', data);
        });

        // Evento sincronizado: enemigo dañado/destruido
        socket.on('enemy_hit', (data) => {
            const roomId = socket.roomId;
            if (!roomId) return;
            socket.to(roomId).emit('enemy_hit', data);
        });
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        if (!rooms[roomId].started) return;

        if (rooms[roomId].players[socket.id]) {
            rooms[roomId].players[socket.id] = {
                ...rooms[roomId].players[socket.id],
                ...data,
                id: socket.id
            };
        }
        // Solo enviar a los demás, no al emisor
        socket.to(roomId).emit('players_state', rooms[roomId].players);
    });

    socket.on('player_shoot', (bullet) => {
        const roomId = socket.roomId;
        if (!roomId) return;
        socket.to(roomId).emit('remote_bullet', {
            ...bullet,
            ownerId: socket.id
        });
    });

    socket.on('player_died', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        if (rooms[roomId].players[socket.id]) {
            rooms[roomId].players[socket.id].alive = false;
        }
        io.to(roomId).emit('player_died', { id: socket.id });
        checkWinner(roomId);
    });

    socket.on('leave_room', () => {
        leaveRoom(socket);
        io.emit('room_list', getRoomList());
    });

    socket.on('disconnect', () => {
        console.log('Jugador desconectado:', socket.id);
        leaveRoom(socket);
        io.emit('room_list', getRoomList());
    });
});

function joinRoom(socket, roomId, playerName) {
    socket.join(roomId);
    socket.roomId = roomId;

    const colors = ['#00f5ff', '#ff4444', '#39ff14', '#f72585'];
    const idx = Object.keys(rooms[roomId].players).length;

    rooms[roomId].players[socket.id] = {
        id: socket.id,
        name: playerName || 'Jugador',
        x: 500 + Math.random() * 3000,
        y: 500 + Math.random() * 3000,
        angle: 0,
        speed: 0,
        alive: true,
        score: 0,
        color: colors[idx % colors.length]
    };

    // Avisar a todos en la sala que entró alguien
    io.to(roomId).emit('player_joined', {
        id: socket.id,
        player: rooms[roomId].players[socket.id],
        allPlayers: rooms[roomId].players,
        roomMode: rooms[roomId].mode
    });

    // Confirmar al jugador que entró, con info del lobby
    socket.emit('joined_room', {
        roomId,
        myId: socket.id,
        players: rooms[roomId].players,
        mode: rooms[roomId].mode,
        worldSeed: rooms[roomId].worldSeed,
        ownerId: rooms[roomId].ownerId,
        started: rooms[roomId].started
    });

    console.log(`${playerName} entró a sala ${roomId} (${rooms[roomId].mode})`);
}

function leaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;

    const playerName = rooms[roomId].players[socket.id]?.name || 'Jugador';
    delete rooms[roomId].players[socket.id];
    socket.leave(roomId);
    socket.roomId = null;

    io.to(roomId).emit('player_left', { id: socket.id, name: playerName });

    const playerCount = Object.keys(rooms[roomId].players).length;

    if (playerCount === 0) {
        delete rooms[roomId];
        console.log(`Sala ${roomId} eliminada por vacía`);
        return;
    }

    // Si el dueño se fue, pasar dueño al siguiente
    if (rooms[roomId].ownerId === socket.id) {
        const newOwner = Object.keys(rooms[roomId].players)[0];
        rooms[roomId].ownerId = newOwner;
        io.to(roomId).emit('new_owner', { ownerId: newOwner });
    }

    if (rooms[roomId].started) {
        checkWinner(roomId);
    }
}

function checkWinner(roomId) {
    if (!rooms[roomId]) return;
    const players = Object.values(rooms[roomId].players);
    const alive = players.filter(p => p.alive);

    if (players.length > 1 && alive.length === 1) {
        io.to(roomId).emit('game_winner', {
            winnerId: alive[0].id,
            winnerName: alive[0].name
        });
        setTimeout(() => {
            if (!rooms[roomId]) return;
            Object.values(rooms[roomId].players).forEach(p => p.alive = true);
            rooms[roomId].started = false;
            io.to(roomId).emit('room_reset');
            io.emit('room_list', getRoomList());
        }, 5000);
    }
}

// Limpiar salas vacías o inactivas cada 2 minutos
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        const room = rooms[roomId];
        const count = Object.keys(room.players).length;
        const age = now - room.createdAt;
        // Eliminar si está vacía o lleva más de 30 min sin iniciarse
        if (count === 0 || (!room.started && age > 30 * 60 * 1000)) {
            delete rooms[roomId];
            console.log(`Sala ${roomId} eliminada por inactividad`);
            io.emit('room_list', getRoomList());
        }
    });
}, 2 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});