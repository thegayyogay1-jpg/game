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
                id: socket.id, name: playerName, hp: 15, 
                energy: 5, visibleEnergy: 5,
                hand: [], deck: generateDeck(),
                doubleEnergyTurns: 0, lowEnergyTurns: 0, isDefenseBlocked: false,
                activeCounter: null 
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
            id: socket.id, name: playerName, hp: 15, 
            energy: 5, visibleEnergy: 5,
            hand: [], deck: generateDeck(),
            doubleEnergyTurns: 0, lowEnergyTurns: 0, isDefenseBlocked: false,
            activeCounter: null
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
            p.visibleEnergy = 5;
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
        socket.emit('update_room', room);
    });

    // 1. กดใช้การ์ดสวนกลับในตาตัวเอง (สุ่มทอยพลังสวนกลับเก็บไว้)
    socket.on('prepare_counter_card', ({ cardIndex }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);

        if (player.energy < 2) return socket.emit('error_message', 'Energy ไม่พอสำหรับใช้การ์ดสวนกลับ (ต้องการ 2)');

        const card = player.hand.splice(cardIndex, 1)[0];
        player.energy -= 2;

        const counterDamageBase = Math.floor(Math.random() * 6) + 1;
        player.activeCounter = {
            name: card.name,
            damageBase: counterDamageBase // ค่าพลังสวนกลับตายตัวที่สุ่มได้ตอนร่าย
        };

        socket.emit('alert_message', `⚔️ ตั้งท่าสวนกลับสำเร็จ! (ได้ดาเมจสวนกลับพื้นฐาน: ${counterDamageBase})`);
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
            target.doubleEnergyTurns = 1;
            socket.emit('alert_message', `🪄 ใช้การ์ดเวทมนตร์ "เร่งพลังงาน" ใส่ ${target.name} เรียบร้อย!`);
        } else if (card.type === 'block_defense') {
            target.isDefenseBlocked = true;
            socket.emit('alert_message', `🔮 ร่ายคำสาป "บล็อคการป้องกัน" ใส่ ${target.name} เรียบร้อย! (เป้าหมายจะไม่รู้ตัว)`);
        }

        socket.emit('update_room', room);
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
        const usedCards = [];
        cardIndices.forEach(idx => {
            usedCards.push(attacker.hand.splice(idx, 1)[0]);
        });
        attacker.energy -= attackCost;

        room.pendingAttack = {
            attackerId: attacker.id,
            targetId: target.id,
            usedCards: usedCards,
            attackerRolls: [],
            targetRoll: 0,
            targetDefenseCard: null,
            useCounter: false
        };

        const hasDefenseCards = target.hand.some(c => c.type === 'attack_defend' || c.type === 'fixed_value');

        if (target.isDefenseBlocked) {
            target.isDefenseBlocked = false;
            
            // ถึงติดคำสาปบล็อคเกราะ ก็ยังกดใช้สวนกลับได้
            if (target.activeCounter) {
                io.to(target.id).emit('defend_prompt', {
                    attackerName: attacker.name,
                    hasDefenseCard: false,
                    isCurseBlocked: true,
                    cardCount: cardIndices.length
                });
            } else {
                io.to(target.id).emit('curse_blocked_alert', { attackerName: attacker.name });
                startDicePhase(room, false);
            }
        } else {
            io.to(target.id).emit('defend_prompt', {
                attackerName: attacker.name,
                hasDefenseCard: hasDefenseCards,
                isCurseBlocked: false,
                cardCount: cardIndices.length
            });
        }

        socket.emit('update_room', room);
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
        
        let defenseCard = null;
        if (target.hand.length > defenseCardIndex) {
            defenseCard = target.hand.splice(defenseCardIndex, 1)[0];
        }
        room.pendingAttack.targetDefenseCard = defenseCard;
        startDicePhase(room, true);
    });

    socket.on('use_counter_defense', () => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;

        room.pendingAttack.useCounter = true;
        startDicePhase(room, true);
    });

    function startDicePhase(room, isDefending) {
        const attackInfo = room.pendingAttack;
        attackInfo.isDefending = isDefending;

        let fixedSum = 0;
        let randomDiceCount = 0;

        attackInfo.usedCards.forEach(c => {
            if (c.type === 'fixed_value') {
                fixedSum += c.value;
            } else {
                randomDiceCount += 1;
            }
        });

        attackInfo.attackerFixedSum = fixedSum;
        attackInfo.attackerRandomCount = randomDiceCount;

        if (randomDiceCount > 0) {
            io.to(attackInfo.attackerId).emit('request_attacker_roll', {
                targetId: attackInfo.targetId,
                diceCount: randomDiceCount,
                fixedSum: fixedSum
            });
        } else {
            attackInfo.attackerRolls = [fixedSum];
            processDefenderPhase(room);
        }
    }

    socket.on('submit_attacker_roll', ({ rolls }) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        
        const attackInfo = room.pendingAttack;
        if (attackInfo.attackerFixedSum > 0) {
            rolls.push(attackInfo.attackerFixedSum);
        }
        attackInfo.attackerRolls = rolls;

        processDefenderPhase(room);
    });

    function processDefenderPhase(room) {
        const attackInfo = room.pendingAttack;

        // ถ้าเลือกใช้การ์ดสวนกลับ ให้ส่งไปทอยเต๋าป้องกันแบบสวนกลับ
        if (attackInfo.useCounter) {
            io.to(attackInfo.targetId).emit('request_counter_roll');
            return;
        }

        // ป้องกันปกติ
        if (attackInfo.isDefending && attackInfo.targetDefenseCard) {
            const defCard = attackInfo.targetDefenseCard;
            if (defCard.type === 'fixed_value') {
                finalizeBattle(room, defCard.value);
            } else {
                io.to(attackInfo.targetId).emit('request_defender_roll');
            }
        } else {
            finalizeBattle(room, 0);
        }
    }

    // เมื่อทอยเต๋าป้องกันปกติสำเร็จ
    socket.on('submit_defender_roll', ({ roll }) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        finalizeBattle(room, roll);
    });

    // เมื่อทอยเต๋าสวนกลับสำเร็จ
    socket.on('submit_counter_roll', ({ roll }) => {
        const room = rooms[socket.roomCode];
        if (!room || !room.pendingAttack) return;
        finalizeBattle(room, roll);
    });

    function finalizeBattle(room, targetRoll) {
        const attackInfo = room.pendingAttack;
        const attacker = room.players.find(p => p.id === attackInfo.attackerId);
        const target = room.players.find(p => p.id === attackInfo.targetId);

        // --- ระบบคำนวณการสวนกลับแบบแยกคิดเต๋าทีละลูก (กติกาใหม่: เสมอ = ฝ่ายสวนกลับแพ้) ---
        if (attackInfo.useCounter && target.activeCounter) {
            const counterDamageBase = target.activeCounter.damageBase;
            const counterDefRoll = targetRoll; // แต้มที่ทอยป้องกันได้
            target.activeCounter = null; // รีเซ็ตท่าสวนกลับ
        
            let damageToTarget = 0;   // ดาเมจที่เราโดน
            let damageToAttacker = 0; // ดาเมจที่เราสวนกลับใส่คนโจมตี
        
            // เปรียบเทียบกับลูกเต๋าโจมตีทีละลูก
            attackInfo.attackerRolls.forEach(attDice => {
                if (attDice >= counterDefRoll) {
                    // โจมตีมากกว่า หรือ เสมอกัน (>=) -> ฝ่ายสวนกลับแพ้ รับดาเมจลูกนี้เต็มๆ
                    damageToTarget += attDice;
                } else {
                    // เต๋าโจมตี < แต้มวัดสวนกลับ -> สวนกลับสำเร็จ!
                    damageToAttacker += counterDamageBase + Math.floor(attDice / 2);
                }
            });
        
            // หัก HP ของทั้งสองฝ่าย
            target.hp = Math.max(0, target.hp - damageToTarget);
            attacker.hp = Math.max(0, attacker.hp - damageToAttacker);
        
            io.to(socket.roomCode).emit('battle_result', {
                isCounterBattle: true,
                attackerName: attacker.name,
                targetName: target.name,
                attackerRolls: attackInfo.attackerRolls,
                counterDefRoll: counterDefRoll,
                counterDamageBase: counterDamageBase,
                damageToTarget: damageToTarget,
                damageToAttacker: damageToAttacker,
                roomState: room
            });
        
            room.pendingAttack = null;
            checkWinCondition(room);
            return;
        }

        // --- คำนวณการโจมตี/ป้องกันปกติ ---
        const totalAttackerRoll = attackInfo.attackerRolls.reduce((a, b) => a + b, 0);
        let damage = totalAttackerRoll - targetRoll;
        if (damage < 0) damage = 0;

        target.hp = Math.max(0, target.hp - damage);

        io.to(socket.roomCode).emit('battle_result', {
            isCounterBattle: false,
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

        if (currentPlayer.energy > 5) {
            currentPlayer.energy = 5;
        }
        currentPlayer.visibleEnergy = currentPlayer.energy;

        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const nextPlayer = room.players[room.currentTurnIndex];

        if (nextPlayer.doubleEnergyTurns > 0) {
            nextPlayer.energy += 6;
            nextPlayer.doubleEnergyTurns = 0;
            nextPlayer.lowEnergyTurns = 1;
        } else if (nextPlayer.lowEnergyTurns > 0) {
            nextPlayer.energy = Math.min(5, nextPlayer.energy + 1);
            nextPlayer.lowEnergyTurns = 0;
        } else {
            nextPlayer.energy = Math.min(5, nextPlayer.energy + 3);
        }

        nextPlayer.visibleEnergy = nextPlayer.energy;

        io.to(socket.roomCode).emit('update_room', room);
    });

    socket.on('disconnect', () => console.log(`User disconnected: ${socket.id}`));
});

function generateDeck() {
    let deck = [];
    for (let i = 0; i < 12; i++) {
        deck.push({ id: `atk_${i}`, name: '🎲 การ์ดสุ่มเต๋า', type: 'attack_defend' });
    }
    for (let val = 1; val <= 6; val++) {
        deck.push({ id: `fixed_${val}`, name: `🎯 การ์ดแต้มล็อค [${val}]`, type: 'fixed_value', value: val });
    }
    for (let i = 0; i < 5; i++) {
        deck.push({ id: 'counter_' + i, name: '⚔️ การ์ดสวนกลับ', type: 'counter_attack' });
    }
    deck.push({ id: 'magic_1', name: '🪄 เวท: เร่งพลังงาน', type: 'double_energy' });
    deck.push({ id: 'magic_2', name: '🔮 เวท: คำสาปไร้เกราะ', type: 'block_defense' });

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
