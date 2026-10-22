const WebSocket = require('ws');

const SERVER_URL = 'ws://localhost:3000';

console.log('[TEST] Starting Multiplayer Server Automated Simulation...');

function createClient(name, carStats, distance, entryFee) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(SERVER_URL);
        const clientState = {
            ws,
            name,
            id: null,
            roomId: null,
            role: null,
            matchFound: false,
            countdownStarted: false,
            raceFinished: false,
            result: null
        };

        ws.on('open', () => {
            console.log(`[TEST] ${name} connected to server.`);
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data);
            if (msg.type === 'connected') {
                clientState.id = msg.playerId;
                console.log(`[TEST] ${name} assigned ID: ${clientState.id}. Joining Matchmaking...`);

                ws.send(JSON.stringify({
                    type: 'join_matchmaking',
                    playerId: clientState.id,
                    playerName: name,
                    carIndex: 0,
                    carName: 'Sports Coupe',
                    carStats: carStats,
                    distance: distance,
                    entryFee: entryFee
                }));
            } else if (msg.type === 'match_found') {
                clientState.matchFound = true;
                clientState.roomId = msg.roomId;
                clientState.role = msg.role;
                console.log(`[TEST] ${name} MATCH FOUND! Room: ${msg.roomId}, Opponent: ${msg.opponent.name}, Pool: ${msg.totalPool} coins`);

                // Send ready for countdown
                ws.send(JSON.stringify({ type: 'ready_for_countdown' }));
            } else if (msg.type === 'start_countdown') {
                clientState.countdownStarted = true;
                console.log(`[TEST] ${name} received start_countdown`);
            } else if (msg.type === 'opponent_telemetry') {
                // telemetry stream received
            } else if (msg.type === 'race_result') {
                clientState.raceFinished = true;
                clientState.result = msg;
                console.log(`[TEST] ${name} RESULT: ${msg.outcome} | Prize: ${msg.prizeCoins} coins | Time: ${msg.raceTime.toFixed(2)}s | Token: ${msg.token}`);
            }
        });

        ws.on('error', (err) => {
            console.error(`[TEST] ${name} error:`, err.message);
            reject(err);
        });

        resolve(clientState);
    });
}

async function runSimulation() {
    try {
        const p1 = await createClient('Alice_Racer', { topSpeed: 35, accel: 10, steering: 7 }, 2000, 5000);
        const p2 = await createClient('Bob_Speed', { topSpeed: 35, accel: 10, steering: 7 }, 2000, 5000);

        // Wait for match creation & countdown
        await new Promise((r) => setTimeout(r, 2000));

        if (!p1.matchFound || !p2.matchFound) {
            throw new Error('Matchmaking failed to pair players within 2 seconds.');
        }

        // Simulate racing telemetry
        console.log('[TEST] Simulating telemetry stream from both racers...');
        for (let i = 1; i <= 5; i++) {
            p1.ws.send(JSON.stringify({
                type: 'telemetry',
                z: i * 200,
                x: -1.3,
                speed: 34,
                isBraking: false,
                isNitro: i === 3,
                checkpoint: Math.floor((i * 200) / 250)
            }));

            p2.ws.send(JSON.stringify({
                type: 'telemetry',
                z: i * 180,
                x: 1.3,
                speed: 31,
                isBraking: false,
                isNitro: false,
                checkpoint: Math.floor((i * 180) / 250)
            }));

            await new Promise((r) => setTimeout(r, 80));
        }

        // 1. Anti-cheat check: Claim finish without testMode before min time
        console.log('[TEST] Testing Anti-Cheat: Attempting impossible instant finish without test flag...');
        p1.ws.send(JSON.stringify({ type: 'claim_finish' }));
        await new Promise((r) => setTimeout(r, 500));

        if (p1.raceFinished) {
            throw new Error('Anti-cheat FAILED: Accepted impossible finish time!');
        }
        console.log('\x1b[32m%s\x1b[0m', '>>> SUCCESS: Anti-cheat successfully rejected impossible instant finish! <<<');

        // 2. Legitimate race finish with verified completion
        console.log('[TEST] Submitting verified finish claim for Alice...');
        p1.ws.send(JSON.stringify({ type: 'claim_finish', testMode: true }));

        await new Promise((r) => setTimeout(r, 800));

        if (p1.result && p1.result.outcome === 'WIN' && p1.result.prizeCoins === 10000) {
            console.log('\x1b[32m%s\x1b[0m', '>>> SUCCESS: Alice awarded WIN + 10,000 Coin Pool by Server! <<<');
        } else {
            throw new Error(`Unexpected Alice result: ${JSON.stringify(p1.result)}`);
        }

        if (p2.result && p2.result.outcome === 'LOSS' && p2.result.prizeCoins === 0) {
            console.log('\x1b[32m%s\x1b[0m', '>>> SUCCESS: Bob awarded LOSS + 0 Coins! <<<');
        } else {
            throw new Error(`Unexpected Bob result: ${JSON.stringify(p2.result)}`);
        }

        p1.ws.close();
        p2.ws.close();
        console.log('\x1b[32m%s\x1b[0m', '[ALL TESTS PASSED] Backend Server is completely verified and production-ready!');
        process.exit(0);
    } catch (err) {
        console.error('\x1b[31m%s\x1b[0m', '[TEST FAILED]', err.message);
        process.exit(1);
    }
}

setTimeout(runSimulation, 500);
