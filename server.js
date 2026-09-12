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
            players: [{ 
                id: socket.id, name: playerName, hp: 100, energy: 5, hand: [], deck: generateDeck(),
                doubleEnergyTurns: 0, lowEnergyTurns: 0, isDefenseBlocked: false 
            }],
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

        room.players.push({ 
            id: socket.id, name: playerName, hp: 100, energy: 5, hand: [], deck: generateDeck(),
            doubleEnergyTurns: 0, lowEnergyTurns: 0, isDefenseBlocked: false 
        });
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

    // ใช้นักเวทมนตร์
    socket.on('use_magic_card', ({ targetId, cardIndex }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const caster = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);

        if (caster.energy < 2) return socket.emit('error_message', 'Energy ไม่พอสำหรับใช้การ์ดเวทมนตร์ (ต้องการ 2)');

        const card = caster.hand.splice(cardIndex, 1)[0];
        caster.energy -= 2;

        if (card.type === 'double_energy') {
            target.doubleEnergyTurns = 1; // ส่งผลในเทิร์นหน้าของเป้าหมาย
            socket.emit('alert_message', `🪄 ใช้การ์ดเวทมนตร์ "เร่งพลังงาน" ใส่ ${target.name} เรียบร้อย!`);
        } else if (card.type === 'block_defense') {
            target.isDefenseBlocked = true; // ล็อคไม่ให้ป้องกันแบบลับๆ
            socket.emit('alert_message', `🔮 ร่ายคำสาป "บล็อคการป้องกัน" ใส่ ${target.name} เรียบร้อย! (เป้าหมายจะไม่รู้ตัว)`);
        }

        io.to(socket.roomCode).emit('update_room', room);
    });

    // โจมตี
    socket.on('initiate_attack', ({ targetId, cardIndices }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const attacker = room.players.find(p => p.id === socket.id);
        const target = room.players.find(p => p.id === targetId);

        const attackCost = cardIndices.length === 2 ? 5 : 3;
        if (attacker.energy < attackCost) return socket.emit('error_message', `Energy ไม่พอ (ต้องการ ${attackCost})`);

        cardIndices.sort((a, b) => b - a);
        cardIndices.forEach(idx => attacker.hand.splice(idx, 1));
        attacker.energy -= attackCost;

        room.pendingAttack = {
            attackerId: attacker.id,
            targetId: target.id,
            cardCount: cardIndices.length,
            attackerRolls: [],
            targetRoll: 0
        };

        // ตรวจสอบคำสาปบล็อคป้องกัน
        if (target.isDefenseBlocked) {
            target.isDefenseBlocked = false; // ปลดบัฟออกเมื่อทำงาน
            // โดนเซอร์ไพรส์! ข้ามเฟสป้องกัน ให้ผู้โจมตีทอยเต๋าเพียวๆ
            startDicePhase(room, false);
        } else {
            const hasDefenseCard = target.hand.some(c => c.type === 'attack_defend');
            io.to(target.id).emit('defend_prompt', {
                attackerName: attacker.name,
                hasDefenseCard,
                cardCount: cardIndices.length
            });
        }

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
            io.to(room.pendingAttack.targetId).emit('request_defender_roll');
        } else {
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
        
        // คำนวณแบบเอาลูกเต๋าลบกันตรงๆ
        let damage = totalAttackerRoll - targetRoll;
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

        const currentPlayer = room.players[room.currentTurnIndex];
        // หากเทิร์นก่อนหน้าได้เอนเนอร์จี้ล้นมา ให้ตัดเหลือไม่เกิน 5 เมื่อจบเทิร์นนั้น
        if (currentPlayer.energy > 5) {
            currentPlayer.energy = 5;
        }

        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const nextPlayer = room.players[room.currentTurnIndex];

        // คำนวณระบบเวทมนตร์ Energy ในเทิร์นถัดไป
        if (nextPlayer.doubleEnergyTurns > 0) {
            nextPlayer.energy += 6; // ทะลุเพดาน Max 5 ได้
            nextPlayer.doubleEnergyTurns = 0;
            nextPlayer.lowEnergyTurns = 1; // ตั้งค่าให้เทิร์นถัดไปโดนลดเหลือ +1
        } else if (nextPlayer.lowEnergyTurns > 0) {
            nextPlayer.energy = Math.min(5, nextPlayer.energy + 1);
            nextPlayer.lowEnergyTurns = 0;
        } else {
            nextPlayer.energy = Math.min(5, nextPlayer.energy + 3);
        }

        io.to(socket.roomCode).emit('update_room', room);
    });

    socket.on('disconnect', () => console.log(`User disconnected: ${socket.id}`));
});

function generateDeck() {
    let deck = [];
    for (let i = 0; i < 16; i++) {
        deck.push({ id: `atk_${i}`, name: 'การ์ดโจมตี/ป้องกัน', type: 'attack_defend' });
    }
    deck.push({ id: 'magic_1', name: '🪄 เวท: เร่งพลังงาน', type: 'double_energy' });
    deck.push({ id: 'magic_2', name: '🔮 เวท: คำสาปไร้เกราะ', type: 'block_defense' });

    // สลับไพ่ในกอง
    return deck.sort(() => Math.random() - 0.5);
}

function checkWinCondition(room) {
    const alive = room.players.filter(p => p.hp > 0);
    if (alive.length === 1) {
        io.to(room.host).emit('game_over', { winner: alive[0].name });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
