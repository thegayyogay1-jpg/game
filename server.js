const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('create_room', ({ roomCode, playerName }) => {
        if (rooms[roomCode]) {
            socket.emit('error_message', 'มีรหัสห้องนี้อยู่แล้ว!');
            return;
        }

        rooms[roomCode] = {
            host: socket.id,
            players: [{
                id: socket.id,
                name: playerName,
                hp: 100,
                energy: 5,
                hand: [],
                deck: generateDeck()
            }],
            currentTurnIndex: 0,
            gameStarted: false
        };

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('room_created', rooms[roomCode]);
        console.log(`Room ${roomCode} created by ${playerName}`);
    });

    socket.on('join_room', ({ roomCode, playerName }) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit('error_message', 'ไม่พบห้องนี้!');
            return;
        }
        if (room.gameStarted) {
            socket.emit('error_message', 'เกมเริ่มไปแล้ว ไม่สามารถเข้าได้!');
            return;
        }
        if (room.players.length >= 8) {
            socket.emit('error_message', 'ห้องเต็มแล้ว (สูงสุด 8 คน)!');
            return;
        }

        room.players.push({
            id: socket.id,
            name: playerName,
            hp: 100,
            energy: 5,
            hand: [],
            deck: generateDeck()
        });

        socket.join(roomCode);
        socket.roomCode = roomCode;

        io.to(roomCode).emit('update_room', room);
        console.log(`${playerName} joined room ${roomCode}`);
    });

    socket.on('start_game', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.host !== socket.id) return;

        room.gameStarted = true;
        room.players.forEach(p => {
            for (let i = 0; i < 2; i++) {
                if (p.deck.length > 0) p.hand.push(p.deck.pop());
            }
            p.energy = 5;
        });

        io.to(socket.roomCode).emit('game_started', room);
    });

    socket.on('draw_card', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);

        if (player.energy < 1) {
            socket.emit('error_message', 'Energy ไม่พอ (ต้องการ 1)');
            return;
        }
        if (player.hand.length >= 3) {
            socket.emit('error_message', 'ถือการ์ดเต็มมือแล้ว (สูงสุด 3 ใบ)');
            return;
        }
        if (player.deck.length === 0) {
            socket.emit('error_message', 'กองการ์ดหมดแล้ว!');
            return;
        }

        player.energy -= 1;
        player.hand.push(player.deck.pop());

        io.to(socket.roomCode).emit('update_room', room);
    });

    socket.on('attack_player', ({ targetId, cardIndex }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const attacker = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);

        if (attacker.energy < 3) {
            socket.emit('error_message', 'Energy ไม่พอ (ต้องการ 3)');
            return;
        }
        if (attacker.hand.length <= cardIndex) {
            socket.emit('error_message', 'เลือกการ์ดไม่ถูกต้อง');
            return;
        }

        attacker.energy -= 3;
        attacker.hand.splice(cardIndex, 1);

        const attackerRoll = Math.floor(Math.random() * 6) + 1;
        const targetRoll = Math.floor(Math.random() * 6) + 1;

        let damage = 1 + attackerRoll - targetRoll;
        if (damage < 0) damage = 0;

        target.hp -= damage;
        if (target.hp < 0) target.hp = 0;

        io.to(socket.roomCode).emit('battle_result', {
            attackerName: attacker.name,
            targetName: target.name,
            attackerRoll,
            targetRoll,
            damage,
            roomState: room
        });

        checkWinCondition(room);
    });

    socket.on('end_turn', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        room.players[room.currentTurnIndex].energy = 5;

        io.to(socket.roomCode).emit('update_room', room);
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
    });
});

function generateDeck() {
    let deck = [];
    for (let i = 0; i < 10; i++) {
        deck.push({ id: i, name: 'การ์ดโจมตี/ป้องกัน', baseDamage: 1 });
    }
    return deck;
}

function checkWinCondition(room) {
    const alivePlayers = room.players.filter(p => p.hp > 0);
    if (alivePlayers.length === 1) {
        io.to(socket.roomCode).emit('game_over', { winner: alivePlayers[0].name });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
