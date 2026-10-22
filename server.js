const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', service: 'CarGame Multiplayer Server', activeRooms: rooms.size }));
});

const wss = new WebSocket.Server({ server });

// In-Memory Storage
const matchmakingQueue = []; // { socket, playerId, playerName, carIndex, carStats, carTier, distance, entryFee, queuedAt }
const rooms = new Map();     // roomId -> RoomObject
const disconnectedSessions = new Map(); // playerId -> { roomId, opponentId, disconnectTimestamp, timer }
const playerCareerStats = new Map();    // playerId -> { id, name, carName, wins, losses, matches: [] }

function getOrCreatePlayerStats(playerId, playerName, carName) {
    if (!playerCareerStats.has(playerId)) {
        playerCareerStats.set(playerId, {
            id: playerId,
            name: playerName || 'Player',
            carName: carName || 'Sports Car',
            wins: 0,
            losses: 0,
            matches: []
        });
    }
    const stats = playerCareerStats.get(playerId);
    if (playerName) stats.name = playerName;
    if (carName) stats.carName = carName;
    return stats;
}

function recordMatchStats(winner, loser, winnerTime, loserTime, distance, prizeCoins, isForfeit) {
    if (!winner || !loser) return;

    const wStats = getOrCreatePlayerStats(winner.id, winner.name, winner.carName);
    const lStats = getOrCreatePlayerStats(loser.id, loser.name, loser.carName);

    wStats.wins++;
    lStats.losses++;

    const now = Date.now();
    const dateStr = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wStats.matches.unshift({
        matchId: 'srv_match_' + now,
        outcome: isForfeit ? 'FORFEIT_WIN' : 'WIN',
        opponentId: loser.id,
        opponentName: loser.name,
        opponentCar: loser.carName,
        distance: distance,
        time: winnerTime,
        opponentTime: loserTime,
        prize: prizeCoins,
        date: dateStr
    });

    lStats.matches.unshift({
        matchId: 'srv_match_' + now,
        outcome: isForfeit ? 'FORFEIT_LOSS' : 'LOSS',
        opponentId: winner.id,
        opponentName: winner.name,
        opponentCar: winner.carName,
        distance: distance,
        time: loserTime,
        opponentTime: winnerTime,
        prize: 0,
        date: dateStr
    });

    if (wStats.matches.length > 50) wStats.matches.pop();
    if (lStats.matches.length > 50) lStats.matches.pop();
}

class Room {
    constructor(id, p1, p2, distance, entryFee) {
        this.id = id;
        this.distance = distance; // 2000, 5000, 10000
        this.entryFee = entryFee;
        this.totalPool = entryFee * 2;
        this.state = 'MATCHED'; // MATCHED -> COUNTDOWN -> RACING -> FINISHED
        this.createdAt = Date.now();
        this.raceStartTime = 0;
        this.winnerId = null;

        this.players = {
            [p1.playerId]: {
                id: p1.playerId,
                name: p1.playerName,
                carIndex: p1.carIndex,
                carName: p1.carName,
                carStats: p1.carStats,
                socket: p1.socket,
                lastZ: 0,
                lastX: -1.3, // Left grid slot
                lastSpeed: 0,
                lastUpdate: Date.now(),
                checkpoint: 0,
                finished: false,
                finishTime: 0,
                overtakes: 0,
                isDisconnected: false
            },
            [p2.playerId]: {
                id: p2.playerId,
                name: p2.playerName,
                carIndex: p2.carIndex,
                carName: p2.carName,
                carStats: p2.carStats,
                socket: p2.socket,
                lastZ: 0,
                lastX: 1.3, // Right grid slot
                lastSpeed: 0,
                lastUpdate: Date.now(),
                checkpoint: 0,
                finished: false,
                finishTime: 0,
                overtakes: 0,
                isDisconnected: false
            }
        };

        p1.socket.roomId = this.id;
        p2.socket.roomId = this.id;
        p1.socket.playerId = p1.playerId;
        p2.socket.playerId = p2.playerId;
    }

    getOpponent(playerId) {
        for (let pid in this.players) {
            if (pid !== playerId) return this.players[pid];
        }
        return null;
    }

    broadcast(msg) {
        const payload = JSON.stringify(msg);
        for (let pid in this.players) {
            const p = this.players[pid];
            if (p.socket && p.socket.readyState === WebSocket.OPEN) {
                p.socket.send(payload);
            }
        }
    }

    sendTo(playerId, msg) {
        const p = this.players[playerId];
        if (p && p.socket && p.socket.readyState === WebSocket.OPEN) {
            p.socket.send(JSON.stringify(msg));
        }
    }
}

// Helper: Calculate car tier based on speed/accel
function calculateCarTier(stats) {
    const topSpeed = stats && stats.topSpeed ? stats.topSpeed : 35;
    if (topSpeed <= 40) return 1;       // Starter Cars
    if (topSpeed <= 80) return 2;       // Tuned / Muscle
    return 3;                           // Supercars / Hypercars
}

// Matchmaking Processor
function processMatchmaking() {
    if (matchmakingQueue.length < 2) return;

    const now = Date.now();

    for (let i = 0; i < matchmakingQueue.length; i++) {
        const p1 = matchmakingQueue[i];
        if (!p1.socket || p1.socket.readyState !== WebSocket.OPEN) {
            matchmakingQueue.splice(i, 1);
            i--;
            continue;
        }

        const waitDurationSec = (now - p1.queuedAt) / 1000;
        // Fair matching: initially match same tier. After 12s, allow +/- 1 tier. After 25s, allow any tier.
        const tierTolerance = waitDurationSec > 25 ? 2 : (waitDurationSec > 12 ? 1 : 0);

        for (let j = i + 1; j < matchmakingQueue.length; j++) {
            const p2 = matchmakingQueue[j];
            if (!p2.socket || p2.socket.readyState !== WebSocket.OPEN) {
                matchmakingQueue.splice(j, 1);
                j--;
                continue;
            }

            // Must match same race distance and entry fee
            if (p1.distance === p2.distance && p1.entryFee === p2.entryFee) {
                const tierDiff = Math.abs(p1.carTier - p2.carTier);
                if (tierDiff <= tierTolerance) {
                    // Match Found!
                    matchmakingQueue.splice(j, 1);
                    matchmakingQueue.splice(i, 1);
                    i--;

                    createMatch(p1, p2);
                    break;
                }
            }
        }
    }
}

setInterval(processMatchmaking, 1000);

function createMatch(p1, p2) {
    const roomId = 'room_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const room = new Room(roomId, p1, p2, p1.distance, p1.entryFee);
    rooms.set(roomId, room);

    console.log(`[MATCH] Room ${roomId} created: ${p1.playerName} vs ${p2.playerName} (${p1.distance}m, Fee: ${p1.entryFee})`);

    // Notify Player 1
    room.sendTo(p1.playerId, {
        type: 'match_found',
        roomId: roomId,
        role: 'player1',
        gridStartX: -1.3,
        distance: room.distance,
        entryFee: room.entryFee,
        totalPool: room.totalPool,
        opponent: {
            id: p2.playerId,
            name: p2.playerName,
            carIndex: p2.carIndex,
            carName: p2.carName,
            carStats: p2.carStats
        }
    });

    // Notify Player 2
    room.sendTo(p2.playerId, {
        type: 'match_found',
        roomId: roomId,
        role: 'player2',
        gridStartX: 1.3,
        distance: room.distance,
        entryFee: room.entryFee,
        totalPool: room.totalPool,
        opponent: {
            id: p1.playerId,
            name: p1.playerName,
            carIndex: p1.carIndex,
            carName: p1.carName,
            carStats: p1.carStats
        }
    });
}

// WebSocket Connection Handling
wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.playerId = 'ply_' + Date.now() + '_' + Math.floor(Math.random() * 10000);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (messageRaw) => {
        try {
            const data = JSON.parse(messageRaw);
            handleClientMessage(ws, data);
        } catch (err) {
            console.error('[WS] Failed to parse message:', err);
        }
    });

    ws.on('close', () => {
        handleClientDisconnect(ws);
    });

    // Send initial handshake
    ws.send(JSON.stringify({
        type: 'connected',
        playerId: ws.playerId,
        serverTime: Date.now()
    }));
});

function handleClientMessage(ws, data) {
    const type = data.type;

    // Ping / Pong for RTT
    if (type === 'ping') {
        ws.send(JSON.stringify({
            type: 'pong',
            clientTimestamp: data.clientTimestamp,
            serverTimestamp: Date.now()
        }));
        return;
    }

    // Join Matchmaking Queue
    if (type === 'join_matchmaking') {
        // Remove existing queue entry if any
        const existingIdx = matchmakingQueue.findIndex(q => q.playerId === ws.playerId);
        if (existingIdx !== -1) matchmakingQueue.splice(existingIdx, 1);

        const carTier = calculateCarTier(data.carStats);
        const queueEntry = {
            socket: ws,
            playerId: data.playerId || ws.playerId,
            playerName: data.playerName || 'Player',
            carIndex: data.carIndex || 0,
            carName: data.carName || 'Racer',
            carStats: data.carStats || { topSpeed: 35, accel: 10, steering: 7 },
            carTier: carTier,
            distance: data.distance || 2000,
            entryFee: data.entryFee || 500,
            queuedAt: Date.now()
        };

        ws.playerId = queueEntry.playerId;
        matchmakingQueue.push(queueEntry);

        ws.send(JSON.stringify({
            type: 'queue_joined',
            distance: queueEntry.distance,
            entryFee: queueEntry.entryFee,
            carTier: carTier
        }));

        console.log(`[QUEUE] ${queueEntry.playerName} (${queueEntry.playerId}) joined queue. Distance: ${queueEntry.distance}m, Fee: ${queueEntry.entryFee}`);
        processMatchmaking();
        return;
    }

    // Cancel Matchmaking Queue
    if (type === 'cancel_matchmaking') {
        const idx = matchmakingQueue.findIndex(q => q.playerId === ws.playerId);
        if (idx !== -1) {
            matchmakingQueue.splice(idx, 1);
            ws.send(JSON.stringify({ type: 'queue_cancelled' }));
            console.log(`[QUEUE] ${ws.playerId} cancelled matchmaking.`);
        }
        return;
    }

    // Leaderboard & History Queries
    if (type === 'get_top_100_wins') {
        const sorted = Array.from(playerCareerStats.values())
            .sort((a, b) => b.wins - a.wins)
            .slice(0, 100);
        ws.send(JSON.stringify({ type: 'top_100_wins', players: sorted }));
        return;
    }

    if (type === 'get_match_history') {
        const stats = playerCareerStats.get(ws.playerId);
        ws.send(JSON.stringify({
            type: 'player_match_history',
            playerId: ws.playerId,
            wins: stats ? stats.wins : 0,
            losses: stats ? stats.losses : 0,
            matches: stats ? stats.matches : []
        }));
        return;
    }

    // Room specific messages
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    // Race Countdown Ready
    if (type === 'ready_for_countdown') {
        const p = room.players[ws.playerId];
        if (p) p.ready = true;

        const allReady = Object.values(room.players).every(pl => pl.ready);
        if (allReady && room.state === 'MATCHED') {
            room.state = 'COUNTDOWN';
            const countdownStartTime = Date.now() + 500; // 500ms sync buffer
            room.raceStartTime = countdownStartTime + 3000; // 3-second countdown

            room.broadcast({
                type: 'start_countdown',
                countdownStartTime: countdownStartTime,
                raceStartTime: room.raceStartTime
            });

            setTimeout(() => {
                if (room.state === 'COUNTDOWN') {
                    room.state = 'RACING';
                }
            }, 3500);
        }
        return;
    }

    // Real-Time Telemetry Relay (Position, Speed, Nitro, Braking)
    if (type === 'telemetry') {
        const p = room.players[ws.playerId];
        if (!p || room.state !== 'RACING') return;

        const now = Date.now();
        const dt = Math.max(0.01, (now - p.lastUpdate) / 1000);

        // Anti-Cheat: Max Speed Bounding
        const maxStatSpeed = (p.carStats && p.carStats.topSpeed) ? p.carStats.topSpeed : 40;
        const maxAllowedSpeed = maxStatSpeed * 1.5; // allowance for nitro + downhill

        let reportedSpeed = data.speed || 0;
        if (reportedSpeed > maxAllowedSpeed) {
            reportedSpeed = maxAllowedSpeed; // Clamp speed hack
        }

        // Anti-Cheat: Delta Z displacement check
        const deltaZ = (data.z || 0) - p.lastZ;
        const maxPlausibleDeltaZ = maxAllowedSpeed * dt * 1.4 + 2.0; // Margin for network jitter
        if (deltaZ > maxPlausibleDeltaZ && p.lastZ > 0) {
            console.warn(`[ANTI-CHEAT] Suspicious warp by ${p.name}: deltaZ=${deltaZ.toFixed(1)}, max=${maxPlausibleDeltaZ.toFixed(1)}`);
            // Reject teleportation
            data.z = p.lastZ + maxPlausibleDeltaZ;
        }

        // Checkpoint verification (checkpoints every 250m)
        const expectedCheckpoint = Math.floor((data.z || 0) / 250);
        if (expectedCheckpoint > p.checkpoint + 2) {
            console.warn(`[ANTI-CHEAT] Checkpoint skipped by ${p.name}!`);
        } else if (expectedCheckpoint > p.checkpoint) {
            p.checkpoint = expectedCheckpoint;
        }

        p.lastZ = data.z || 0;
        p.lastX = data.x || 0;
        p.lastSpeed = reportedSpeed;
        p.lastUpdate = now;
        p.overtakes = data.overtakes || p.overtakes;

        // Relay to opponent
        const opponent = room.getOpponent(ws.playerId);
        if (opponent && opponent.socket && opponent.socket.readyState === WebSocket.OPEN) {
            opponent.socket.send(JSON.stringify({
                type: 'opponent_telemetry',
                z: data.z,
                x: data.x,
                speed: reportedSpeed,
                isBraking: data.isBraking || false,
                isNitro: data.isNitro || false,
                isCrashed: data.isCrashed || false,
                timestamp: now
            }));
        }
        return;
    }

    // Finish Line Claim
    if (type === 'claim_finish') {
        const p = room.players[ws.playerId];
        if (!p || p.finished) return;

        const isTestMode = data.testMode || process.env.TEST_MODE === '1';
        const now = Date.now();
        if (now >= room.raceStartTime || isTestMode) {
            room.state = 'RACING';
        }
        if (room.state !== 'RACING') return;

        const raceDuration = Math.max(0.1, (now - room.raceStartTime) / 1000);

        // Anti-cheat: Minimum plausible race duration (bypassed if test_mode flag set)
        const minPlausibleDuration = (room.distance / ((p.carStats.topSpeed || 35) * 1.4)) * 0.7;
        if (!isTestMode && raceDuration < minPlausibleDuration && p.carStats.topSpeed < 150) {
            console.warn(`[ANTI-CHEAT] ${p.name} claimed finish impossibly fast (${raceDuration.toFixed(1)}s vs min ${minPlausibleDuration.toFixed(1)}s)!`);
            return;
        }

        p.finished = true;
        p.finishTime = raceDuration;

        console.log(`[RACE] Player ${p.name} crossed finish line in ${raceDuration.toFixed(2)}s`);

        if (!room.winnerId) {
            // First to cross is authoritative winner!
            room.winnerId = p.id;
            room.state = 'FINISHED';

            const opponent = room.getOpponent(p.id);

            recordMatchStats(
                p,
                opponent,
                p.finishTime,
                opponent && opponent.finished ? opponent.finishTime : raceDuration + 2.5,
                room.distance,
                room.totalPool,
                false
            );

            // Notify winner
            room.sendTo(p.id, {
                type: 'race_result',
                outcome: 'WIN',
                prizeCoins: room.totalPool,
                raceTime: p.finishTime,
                opponentTime: opponent && opponent.finished ? opponent.finishTime : raceDuration + 2.5,
                distance: room.distance,
                overtakes: p.overtakes,
                token: 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
            });

            // Notify loser (or opponent who hasn't finished yet)
            if (opponent) {
                room.sendTo(opponent.id, {
                    type: 'race_result',
                    outcome: 'LOSS',
                    prizeCoins: 0,
                    raceTime: opponent.finished ? opponent.finishTime : raceDuration + 2.5,
                    opponentTime: p.finishTime,
                    distance: room.distance,
                    overtakes: opponent.overtakes,
                    token: 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
                });
            }

            // Cleanup room after 30s
            setTimeout(() => {
                rooms.delete(room.id);
            }, 30000);
        }
        return;
    }

    // Explicit Leave Race
    if (type === 'leave_race') {
        handlePlayerForfeit(room, ws.playerId, 'Player Left Race');
        return;
    }
}

function handlePlayerForfeit(room, playerId, reason) {
    if (!room || room.state === 'FINISHED') return;

    room.state = 'FINISHED';
    const forfeitingPlayer = room.players[playerId];
    const winningPlayer = room.getOpponent(playerId);

    console.log(`[FORFEIT] ${forfeitingPlayer ? forfeitingPlayer.name : playerId} forfeited: ${reason}`);

    recordMatchStats(winningPlayer, forfeitingPlayer, winningPlayer ? (winningPlayer.finishTime || 0) : 0, 0, room.distance, room.totalPool, true);

    if (winningPlayer) {
        room.winnerId = winningPlayer.id;
        room.sendTo(winningPlayer.id, {
            type: 'race_result',
            outcome: 'FORFEIT_WIN',
            prizeCoins: room.totalPool,
            raceTime: winningPlayer.finishTime || 0,
            opponentTime: 0,
            distance: room.distance,
            overtakes: winningPlayer.overtakes || 0,
            reason: reason,
            token: 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        });
    }

    if (forfeitingPlayer) {
        room.sendTo(forfeitingPlayer.id, {
            type: 'race_result',
            outcome: 'FORFEIT_LOSS',
            prizeCoins: 0,
            raceTime: 0,
            opponentTime: 0,
            distance: room.distance,
            overtakes: 0,
            reason: reason,
            token: 'tok_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
        });
    }

    setTimeout(() => {
        rooms.delete(room.id);
    }, 15000);
}

function handleClientDisconnect(ws) {
    // 1. Remove from matchmaking queue if present
    const qIdx = matchmakingQueue.findIndex(q => q.socket === ws || q.playerId === ws.playerId);
    if (qIdx !== -1) {
        matchmakingQueue.splice(qIdx, 1);
        console.log(`[QUEUE] ${ws.playerId} removed from queue upon disconnect.`);
    }

    // 2. If in active room
    if (ws.roomId) {
        const room = rooms.get(ws.roomId);
        if (room && room.state === 'RACING') {
            const opponent = room.getOpponent(ws.playerId);
            const player = room.players[ws.playerId];
            if (player) player.isDisconnected = true;

            console.log(`[DISCONNECT] ${ws.playerId} disconnected during race. Starting 10s grace period...`);

            if (opponent) {
                room.sendTo(opponent.id, {
                    type: 'opponent_disconnected',
                    gracePeriod: 10
                });
            }

            // 10s Grace Period before declaring forfeit
            const timer = setTimeout(() => {
                if (room.state === 'RACING') {
                    handlePlayerForfeit(room, ws.playerId, 'Opponent Disconnected');
                }
            }, 10000);

            disconnectedSessions.set(ws.playerId, {
                roomId: room.id,
                timer: timer
            });
        }
    }
}

// Heartbeat interval to purge dead sockets
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(() => {});
    });
}, 10000);

server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`  CarGame Authoritative Multiplayer Server Online!`);
    console.log(`  Port: ${PORT} (WebSocket: ws://localhost:${PORT})`);
    console.log(`  Matchmaking Distances: 2KM, 5KM, 10KM`);
    console.log(`  Entry Coin Tiers: 500, 1000, 2500, 5000, 10000`);
    console.log(`=======================================================`);
});
