const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET','POST'] },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.get('/', (req, res) => res.send('Asteroids X Server running'));

const WORLD_WIDTH  = 4000;
const WORLD_HEIGHT = 4000;
const TICK_RATE    = 1000 / 60;

const rooms = {};

function seededRand(state) {
    state.s = (state.s * 9301 + 49297) % 233280;
    return state.s / 233280;
}

function generateWorld(seed) {
    const state = { s: seed };
    const asteroids = [];
    const enemies   = [];

    for (let i = 0; i < 8; i++) {
        const x    = seededRand(state) * WORLD_WIDTH;
        const y    = seededRand(state) * WORLD_HEIGHT;
        const size = 30 + seededRand(state) * 40;
        const indestructible = seededRand(state) < 0.3;
        const angle = seededRand(state) * Math.PI * 2;
        const speed = seededRand(state) * 2 + 0.5;
        const vertices = [];
        for (let j = 0; j < 8; j++) {
            const a = (Math.PI * 2 / 8) * j;
            const r = size * (0.7 + seededRand(state) * 0.4);
            vertices.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
        }
        asteroids.push({ id: i, x, y, size, angle, speed, indestructible, vertices });
    }

    for (let i = 0; i < 5; i++) {
        enemies.push({
            id: i,
            x: seededRand(state) * WORLD_WIDTH,
            y: seededRand(state) * WORLD_HEIGHT,
            angle: seededRand(state) * Math.PI * 2,
            speed: 0, maxSpeed: 2, hp: 3,
            shootCooldown: Math.floor(seededRand(state) * 60)
        });
    }

    return { asteroids, enemies };
}

function createRoom(roomId, mode) {
    const seed  = Math.floor(Math.random() * 999999);
    const world = generateWorld(seed);
    rooms[roomId] = {
        id: roomId, mode: mode || 'ranked',
        players: {}, started: false, bets: {},
        worldSeed: seed,
        asteroids: world.asteroids,
        enemies:   world.enemies,
        lastSpawn: Date.now(),
        createdAt: Date.now(),
        ownerId: null, loop: null,
        nextAsteroidId: 100
    };
    return rooms[roomId];
}

function getRoomList() {
    return Object.values(rooms).map(r => ({
        id: r.id, mode: r.mode,
        playerCount: Object.keys(r.players).length,
        maxPlayers: 4, started: r.started, ownerId: r.ownerId
    }));
}

function bounceObj(obj) {
    if (obj.x < 0)            { obj.x = 0;            obj.angle = Math.PI - obj.angle; }
    if (obj.x > WORLD_WIDTH)  { obj.x = WORLD_WIDTH;  obj.angle = Math.PI - obj.angle; }
    if (obj.y < 0)            { obj.y = 0;            obj.angle = -obj.angle; }
    if (obj.y > WORLD_HEIGHT) { obj.y = WORLD_HEIGHT; obj.angle = -obj.angle; }
}

function bounceEntity(e) {
    const m = 10;
    if (e.x < m)              { e.x = m;              e.angle = Math.PI - e.angle; e.speed *= 0.9; }
    if (e.x > WORLD_WIDTH-m)  { e.x = WORLD_WIDTH-m;  e.angle = Math.PI - e.angle; e.speed *= 0.7; }
    if (e.y < m)              { e.y = m;              e.angle = -e.angle; e.speed *= 0.7; }
    if (e.y > WORLD_HEIGHT-m) { e.y = WORLD_HEIGHT-m; e.angle = -e.angle; e.speed *= 0.7; }
}

function dist2(a, b) {
    return Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
}

function spawnAsteroid(room, x, y, size, indestructible) {
    x = x ?? Math.random() * WORLD_WIDTH;
    y = y ?? Math.random() * WORLD_HEIGHT;
    size = size ?? (30 + Math.random() * 40);
    indestructible = indestructible ?? (Math.random() < 0.3);
    const vertices = [];
    for (let j = 0; j < 8; j++) {
        const a = (Math.PI * 2 / 8) * j;
        const r = size * (0.7 + Math.random() * 0.4);
        vertices.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    const asteroid = {
        id: room.nextAsteroidId++,
        x, y, size,
        angle: Math.random() * Math.PI * 2,
        speed: Math.random() * 2 + 0.5,
        indestructible, vertices
    };
    room.asteroids.push(asteroid);
    return asteroid;
}

function tickRoom(roomId) {
    const room = rooms[roomId];
    if (!room || !room.started) return;

    const alivePlayers = Object.values(room.players).filter(p => p.alive);

    // Mover asteroides
    room.asteroids.forEach(a => {
        a.x += Math.cos(a.angle) * a.speed;
        a.y += Math.sin(a.angle) * a.speed;
        bounceObj(a);
    });

    // Spawn cada 15s
    if (Date.now() - room.lastSpawn > 15000) {
        const newOnes = [];
        for (let i = 0; i < 3; i++) newOnes.push(spawnAsteroid(room, null, null, null, false));
        room.lastSpawn = Date.now();
        io.to(roomId).emit('asteroids_spawned', newOnes);
    }

    // Mover enemigos
    const enemiesToRemove = [];
    room.enemies.forEach(e => {
        if (alivePlayers.length === 0) return;

        // Buscar jugador más cercano
        let nearest = alivePlayers[0];
        let nearDist = dist2(e, nearest);
        alivePlayers.forEach(p => {
            const d = dist2(e, p);
            if (d < nearDist) { nearest = p; nearDist = d; }
        });

        // Girar hacia jugador
        const targetAngle = Math.atan2(nearest.y - e.y, nearest.x - e.x);
        let diff = targetAngle - e.angle;
        if (diff > Math.PI)  diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;
        e.angle += diff * 0.05;

        // Esquivar asteroides
        room.asteroids.forEach(a => {
            const ax = a.x - e.x;
            const ay = a.y - e.y;
            const aDist = Math.sqrt(ax*ax + ay*ay);
            if (aDist < a.size + 80 && aDist > 0) {
                const avoidAngle = Math.atan2(ay, ax) + Math.PI;
                const strength   = (1 - aDist / (a.size + 80)) * 0.2;
                let ad = avoidAngle - e.angle;
                if (ad > Math.PI)  ad -= Math.PI * 2;
                if (ad < -Math.PI) ad += Math.PI * 2;
                e.angle += ad * strength;
            }
        });

        e.speed = Math.min(e.speed + 0.05, e.maxSpeed);
        e.x += Math.cos(e.angle) * e.speed;
        e.y += Math.sin(e.angle) * e.speed;
        bounceEntity(e);

        // Disparar
        e.shootCooldown--;
        if (e.shootCooldown <= 0 && nearDist < 600) {
            e.shootCooldown = 90 + Math.floor(Math.random() * 60);
            io.to(roomId).emit('enemy_shoot', {
                x: e.x, y: e.y, angle: e.angle, speed: 5, life: 90
            });
        }

        // Colisión con asteroide
        for (let ai = room.asteroids.length - 1; ai >= 0; ai--) {
            const a = room.asteroids[ai];
            if (dist2(e, a) < a.size + 15) {
                io.to(roomId).emit('explosion', { x: e.x, y: e.y, size: 'medium' });
                enemiesToRemove.push(e.id);
                if (!a.indestructible) {
                    room.asteroids.splice(ai, 1);
                    if (a.size > 20) {
                        const c1 = spawnAsteroid(room, a.x, a.y, a.size/2, false);
                        const c2 = spawnAsteroid(room, a.x, a.y, a.size/2, false);
                        io.to(roomId).emit('asteroids_spawned', [c1, c2]);
                    }
                    io.to(roomId).emit('asteroid_destroyed', { id: a.id, x: a.x, y: a.y, size: a.size });
                }
                break;
            }
        }
    });

    // Eliminar enemigos que chocaron
    enemiesToRemove.forEach(eid => {
        const idx = room.enemies.findIndex(e => e.id === eid);
        if (idx !== -1) {
            io.to(roomId).emit('enemy_destroyed', { id: eid, x: room.enemies[idx].x, y: room.enemies[idx].y });
            room.enemies.splice(idx, 1);
        }
    });

    // Enviar estado del mundo a todos
    io.to(roomId).emit('world_state', {
        asteroids: room.asteroids,
        enemies:   room.enemies
    });
}

function startRoomLoop(roomId) {
    if (rooms[roomId].loop) clearInterval(rooms[roomId].loop);
    rooms[roomId].loop = setInterval(() => tickRoom(roomId), TICK_RATE);
}

function stopRoomLoop(roomId) {
    if (rooms[roomId]?.loop) { clearInterval(rooms[roomId].loop); rooms[roomId].loop = null; }
}

// ===========================
//  CONEXIONES
// ===========================
io.on('connection', (socket) => {
    console.log('+ Conectado:', socket.id);

    socket.on('get_rooms', () => socket.emit('room_list', getRoomList()));

    socket.on('create_room', ({ roomId, mode, playerName }) => {
        if (rooms[roomId]) { socket.emit('error_msg', 'Esa sala ya existe'); return; }
        const room = createRoom(roomId, mode);
        room.ownerId = socket.id;
        joinRoom(socket, roomId, playerName);
        io.emit('room_list', getRoomList());
    });

    socket.on('join_room', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room)                                 { socket.emit('error_msg', 'Sala no encontrada'); return; }
        if (room.started)                          { socket.emit('error_msg', 'Partida ya iniciada'); return; }
        if (Object.keys(room.players).length >= 4) { socket.emit('error_msg', 'Sala llena'); return; }
        joinRoom(socket, roomId, playerName);
        io.emit('room_list', getRoomList());
    });

    socket.on('start_game', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        if (rooms[roomId].ownerId !== socket.id) { socket.emit('error_msg', 'Solo el creador puede iniciar'); return; }
        rooms[roomId].started = true;
        io.to(roomId).emit('game_started', {
            worldSeed: rooms[roomId].worldSeed,
            players:   rooms[roomId].players,
            asteroids: rooms[roomId].asteroids,
            enemies:   rooms[roomId].enemies
        });
        startRoomLoop(roomId);
        io.emit('room_list', getRoomList());
        console.log(`Partida iniciada: ${roomId}`);
    });

    socket.on('player_update', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId] || !rooms[roomId].started) return;
        if (rooms[roomId].players[socket.id]) {
            Object.assign(rooms[roomId].players[socket.id], data, { id: socket.id });
        }
        socket.to(roomId).emit('players_state', rooms[roomId].players);
    });

    socket.on('player_shoot', (bullet) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        // Reenviar bala a los demás
        socket.to(roomId).emit('remote_bullet', { ...bullet, ownerId: socket.id });

        const room = rooms[roomId];

        // Colisión con asteroides
        for (let ai = room.asteroids.length - 1; ai >= 0; ai--) {
            const a = room.asteroids[ai];
            if (dist2(bullet, a) < a.size) {
                if (a.indestructible) {
                    io.to(roomId).emit('bullet_hit', { x: bullet.x, y: bullet.y });
                    return;
                }
                room.asteroids.splice(ai, 1);
                io.to(roomId).emit('asteroid_destroyed', { id: a.id, x: a.x, y: a.y, size: a.size });
                if (a.size > 20) {
                    const c1 = spawnAsteroid(room, a.x, a.y, a.size/2, false);
                    const c2 = spawnAsteroid(room, a.x, a.y, a.size/2, false);
                    io.to(roomId).emit('asteroids_spawned', [c1, c2]);
                }
                if (rooms[roomId].players[socket.id])
                    rooms[roomId].players[socket.id].score = (rooms[roomId].players[socket.id].score || 0) + 10;
                return;
            }
        }

        // Colisión con enemigos
        for (let ei = room.enemies.length - 1; ei >= 0; ei--) {
            const e = room.enemies[ei];
            if (dist2(bullet, e) < 20) {
                e.hp--;
                if (e.hp <= 0) {
                    room.enemies.splice(ei, 1);
                    io.to(roomId).emit('enemy_destroyed', { id: e.id, x: e.x, y: e.y });
                    if (rooms[roomId].players[socket.id])
                        rooms[roomId].players[socket.id].score = (rooms[roomId].players[socket.id].score || 0) + 50;
                } else {
                    io.to(roomId).emit('enemy_damaged', { id: e.id, hp: e.hp });
                }
                return;
            }
        }
    });

    socket.on('player_died', () => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;
        if (rooms[roomId].players[socket.id]) rooms[roomId].players[socket.id].alive = false;
        io.to(roomId).emit('player_died', { id: socket.id });
        checkWinner(roomId);
    });

    socket.on('leave_room', () => { leaveRoom(socket); io.emit('room_list', getRoomList()); });

    socket.on('disconnect', () => {
        console.log('- Desconectado:', socket.id);
        leaveRoom(socket);
        io.emit('room_list', getRoomList());
    });
});

function joinRoom(socket, roomId, playerName) {
    socket.join(roomId);
    socket.roomId = roomId;
    const colors = ['#00f5ff', '#ff4444', '#39ff14', '#f72585'];
    const idx    = Object.keys(rooms[roomId].players).length;
    rooms[roomId].players[socket.id] = {
        id: socket.id, name: playerName || 'Jugador',
        x: 500 + Math.random() * 3000, y: 500 + Math.random() * 3000,
        angle: 0, speed: 0, alive: true, score: 0,
        color: colors[idx % colors.length]
    };
    io.to(roomId).emit('player_joined', {
        id: socket.id,
        player: rooms[roomId].players[socket.id],
        allPlayers: rooms[roomId].players
    });
    socket.emit('joined_room', {
        roomId, myId: socket.id,
        players: rooms[roomId].players,
        mode: rooms[roomId].mode,
        worldSeed: rooms[roomId].worldSeed,
        ownerId: rooms[roomId].ownerId,
        started: rooms[roomId].started
    });
    console.log(`${playerName} → sala ${roomId}`);
}

function leaveRoom(socket) {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const name = rooms[roomId].players[socket.id]?.name || 'Jugador';
    delete rooms[roomId].players[socket.id];
    socket.leave(roomId);
    socket.roomId = null;
    io.to(roomId).emit('player_left', { id: socket.id, name });
    const count = Object.keys(rooms[roomId].players).length;
    if (count === 0) { stopRoomLoop(roomId); delete rooms[roomId]; return; }
    if (rooms[roomId].ownerId === socket.id) {
        const newOwner = Object.keys(rooms[roomId].players)[0];
        rooms[roomId].ownerId = newOwner;
        io.to(roomId).emit('new_owner', { ownerId: newOwner });
    }
    if (rooms[roomId].started) checkWinner(roomId);
}

function checkWinner(roomId) {
    if (!rooms[roomId]) return;
    const players = Object.values(rooms[roomId].players);
    const alive   = players.filter(p => p.alive);
    if (players.length > 1 && alive.length === 1) {
        stopRoomLoop(roomId);
        io.to(roomId).emit('game_winner', { winnerId: alive[0].id, winnerName: alive[0].name });
        setTimeout(() => {
            if (!rooms[roomId]) return;
            const world = generateWorld(rooms[roomId].worldSeed);
            rooms[roomId].asteroids = world.asteroids;
            rooms[roomId].enemies   = world.enemies;
            Object.values(rooms[roomId].players).forEach(p => p.alive = true);
            rooms[roomId].started = false;
            io.to(roomId).emit('room_reset');
            io.emit('room_list', getRoomList());
        }, 5000);
    }
}

setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        const room  = rooms[roomId];
        const count = Object.keys(room.players).length;
        const age   = now - room.createdAt;
        if (count === 0 || (!room.started && age > 30 * 60 * 1000)) {
            stopRoomLoop(roomId);
            delete rooms[roomId];
            io.emit('room_list', getRoomList());
        }
    });
}, 2 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
