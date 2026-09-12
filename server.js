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
            gameStarted: false,
            pendingAttack: null
        };

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('room_joined', rooms[roomCode]);
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

        // เช็คชื่อซ้ำ
        const nameExists = room.players.some(p => p.name === playerName);
        if (nameExists) {
            socket.emit('error_message', 'ชื่อนี้ถูกใช้ไปแล้วในห้องนี้ กรุณาใช้ชื่ออื่น!');
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
        socket.emit('room_joined', room);
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

    // เริ่มกระบวนการโจมตี (หัก 3 Energy, ทิ้งการ์ด, ส่งสัญญาณให้เป้าหมายเลือกป้องกัน)
    socket.on('initiate_attack', ({ targetId, cardIndex }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const attacker = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);

        if (attacker.energy < 3) {
            socket.emit('error_message', 'Energy ไม่พอ (ต้องการ 3)');
            return;
        }
        if (attacker.hand.length <= cardIndex) {
            socket.emit('error_message', 'การ์ดไม่ถูกต้อง');
            return;
        }

        attacker.energy -= 3;
        const usedCard = attacker.hand.splice(cardIndex, 1)[0];

        // บันทึกสถานะการโจมตีค้างไว้
        room.pendingAttack = {
            attackerId: attacker.id,
            targetId: target.id,
            card: usedCard
        };

        // แจ้งเตือนผู้ถูกโจมตีให้เลือกว่าจะใช้การ์ดป้องกันไหม
        const hasDefenseCard = target.hand.some(c => c.name === 'การ์ดโจมตี/ป้องกัน');
        io.to(target.id).emit('defend_prompt', {
            attackerName: attacker.name,
            hasDefenseCard: hasDefenseCard
        });

        io.to(socket.roomCode).emit('update_room', room);
    });

    // กรณีผู้ถูกโจมตีเลือก "ไม่มีการ์ดป้องกัน" หรือ "ไม่ใช้"
    socket.on('skip_defense', () => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        
        // ให้ผู้โจมตีทอยเต๋าคนเดียว (ไม่มีฝ่ายป้องกันทอยหักล้าง)
        executeBattle(room, 0);
    });

    // กรณีผู้ถูกโจมตีเลือก "ใช้การ์ดป้องกัน" (ต้องเลือกการ์ดในมือมาทิ้ง 1 ใบ)
    socket.on('use_defense_card', ({ defenseCardIndex }) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;

        const target = room.players.find(p => p.id === socket.id);
        if (target.hand.length > defenseCardIndex) {
            target.hand.splice(defenseCardIndex, 1); // ทิ้งการ์ดป้องกัน
        }

        // ให้ผู้โจมตีและผู้ป้องกันทอยเต๋ามาหักล้างกัน
        executeBattle(room, 1);
    });

    function executeBattle(room, hasDefenderRolled) {
        const attackInfo = room.pendingAttack;
        const attacker = room.players.find(p => p.id === attackInfo.attackerId);
        const target = room.players.find(p => p.id === attackInfo.targetId);

        // ส่งสัญญาณให้คนโจมตีเด้งป๊อปอัพทอยเต๋า
        io.to(attacker.id).emit('request_attacker_roll', {
            targetId: target.id,
            hasDefenderRolled: hasDefenderRolled
        });
        room.pendingAttack = null;
    }

    // ผู้โจมตีทอยเต๋าเรียบร้อย คำนวณดาเมจ
    socket.on('submit_attacker_roll', ({ targetId, attackerRoll, hasDefenderRolled }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const attacker = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);

        let targetRoll = 0;
        if (hasDefenderRolled === 1) {
            targetRoll = Math.floor(Math.random() * 6) + 1;
        }

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
