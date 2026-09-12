const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const rooms = {};

io.on('connection', (socket) => {
    socket.on('create_room', ({ roomCode, playerName }) => {
        if (rooms[roomCode]) return socket.emit('error_message', 'มีรหัสห้องนี้อยู่แล้ว!');
        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: playerName, hp: 100, energy: 5, hand: [], deck: generateDeck() }],
            currentTurnIndex: 0,
            gameStarted: false,
            pendingAttack: null
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('room_joined', rooms[roomCode]);
    });

    socket.on('join_room', ({ roomCode, playerName }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error_message', 'ไม่พบห้องนี้!');
        if (room.gameStarted) return socket.emit('error_message', 'เกมเริ่มไปแล้ว!');
        if (room.players.length >= 8) return socket.emit('error_message', 'ห้องเต็มแล้ว!');
        if (room.players.some(p => p.name === playerName)) return socket.emit('error_message', 'ชื่อซ้ำ!');

        room.players.push({ id: socket.id, name: playerName, hp: 100, energy: 5, hand: [], deck: generateDeck() });
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.emit('room_joined', room);
        io.to(roomCode).emit('update_room', room);
    });

    socket.on('start_game', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.host !== socket.id) return;
        room.gameStarted = true;
        room.players.forEach(p => {
            for (let i = 0; i < 3; i++) {
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
        const maxHand = 5 + (room.players.length - 2);

        if (player.energy < 1) return socket.emit('error_message', 'Energy ไม่พอ (ต้องการ 1)');
        if (player.hand.length >= maxHand) return socket.emit('error_message', `ถือการ์ดเต็มมือแล้ว (สูงสุด ${maxHand} ใบ)`);
        if (player.deck.length === 0) return socket.emit('error_message', 'กองการ์ดหมดแล้ว!');

        player.energy -= 1;
        player.hand.push(player.deck.pop());
        io.to(socket.roomCode).emit('update_room', room);
    });

    // โจมตีโดยระบุรายการ Index ของการ์ด (1 หรือ 2 ใบ)
    socket.on('initiate_attack', ({ targetId, cardIndices }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const attacker = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);

        const attackCost = cardIndices.length === 2 ? 5 : 3;
        if (attacker.energy < attackCost) return socket.emit('error_message', `Energy ไม่พอ (ต้องการ ${attackCost})`);

        // ทิ้งการ์ดที่ถูกเลือกใช้งาน
        cardIndices.sort((a, b) => b - a);
        const usedCards = [];
        cardIndices.forEach(idx => {
            usedCards.push(attacker.hand.splice(idx, 1)[0]);
        });

        attacker.energy -= attackCost;

        room.pendingAttack = {
            attackerId: attacker.id,
            targetId: target.id,
            cardCount: cardIndices.length,
            attackerRolls: [],
            targetRoll: 0
        };

        const hasDefenseCard = target.hand.some(c => c.name === 'การ์ดโจมตี/ป้องกัน');
        io.to(target.id).emit('defend_prompt', {
            attackerName: attacker.name,
            hasDefenseCard,
            cardCount: cardIndices.length
        });

        io.to(socket.roomCode).emit('update_room', room);
    });

    socket.on('skip_defense', () => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        startDicePhase(room, false);
    });

    socket.on('use_defense_card', ({ defenseCardIndex }) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        const target = room.players.find(p => p.id === socket.id);
        
        if (target.hand.length > defenseCardIndex) {
            target.hand.splice(defenseCardIndex, 1);
        }
        startDicePhase(room, true);
    });

    function startDicePhase(room, isDefending) {
        const attackInfo = room.pendingAttack;
        attackInfo.isDefending = isDefending;

        // สั่งให้ผู้โจมตีทอยเต๋าก่อน
        io.to(attackInfo.attackerId).emit('request_attacker_roll', {
            targetId: attackInfo.targetId,
            cardCount: attackInfo.cardCount
        });
    }

    socket.on('submit_attacker_roll', ({ rolls }) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        room.pendingAttack.attackerRolls = rolls;

        if (room.pendingAttack.isDefending) {
            // ส่งต่อให้ฝ่ายป้องกันทอยเต๋าหักล้าง
            io.to(room.pendingAttack.targetId).emit('request_defender_roll');
        } else {
            // ฝ่ายป้องกันไม่ได้ใช้การ์ดป้องกัน (ถือว่าทอยได้ 0)
            finalizeBattle(room, 0);
        }
    });

    socket.on('submit_defender_roll', ({ roll }) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        finalizeBattle(room, roll);
    });

    function finalizeBattle(room, targetRoll) {
        const attackInfo = room.pendingAttack;
        const attacker = room.players.find(p => p.id === attackInfo.attackerId);
        const target = room.players.find(p => p.id === attackInfo.targetId);

        const totalAttackerRoll = attackInfo.attackerRolls.reduce((a, b) => a + b, 0);
        let damage = (1 * attackInfo.cardCount) + totalAttackerRoll - targetRoll;
        if (damage < 0) damage = 0;

        target.hp = Math.max(0, target.hp - damage);

        io.to(socket.roomCode).emit('battle_result', {
            attackerName: attacker.name,
            targetName: target.name,
            attackerRolls: attackInfo.attackerRolls,
            targetRoll,
            damage,
            roomState: room
        });

        room.pendingAttack = null;
        checkWinCondition(room);
    }

    socket.on('end_turn', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const nextPlayer = room.players[room.currentTurnIndex];
        // เพิ่ม Energy รอบละ +3 แต่สะสมไม่เกิน 5
        nextPlayer.energy = Math.min(5, nextPlayer.energy + 3);

        io.to(socket.roomCode).emit('update_room', room);
    });

    socket.on('disconnect', () => console.log(`User disconnected: ${socket.id}`));
});

function generateDeck() {
    let deck = [];
    for (let i = 0; i < 20; i++) {
        deck.push({ id: i, name: 'การ์ดโจมตี/ป้องกัน', baseDamage: 1 });
    }
    return deck;
}

function checkWinCondition(room) {
    const alive = room.players.filter(p => p.hp > 0);
    if (alive.length === 1) {
        io.to(room.host).emit('game_over', { winner: alive[0].name });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
