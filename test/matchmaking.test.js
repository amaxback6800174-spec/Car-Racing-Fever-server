// End-to-end checks for the 1 VS 1 server: starts a real server process and connects fake phones to it.
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const WebSocket = require('ws');

const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = `ws://127.0.0.1:${PORT}`;
let serverProc;

before(async () => {
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), READY_TIMEOUT_MS: '1500' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
        serverProc.stdout.on('data', d => { if (String(d).includes('Server Online')) resolve(); });
        serverProc.on('exit', code => reject(new Error('server exited ' + code)));
    });
});

after(() => { if (serverProc) serverProc.kill(); });

// A fake phone: collects every message so tests can wait for a given type
function connect() {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(URL);
        const inbox = [];
        const waiters = [];
        ws.on('message', raw => {
            const msg = JSON.parse(raw);
            const w = waiters.findIndex(x => x.type === msg.type);
            if (w !== -1) waiters.splice(w, 1)[0].resolve(msg);
            else inbox.push(msg);
        });
        ws.on('error', reject);
        const client = {
            ws,
            send: obj => ws.send(JSON.stringify(obj)),
            next(type, timeoutMs = 3000) {
                const i = inbox.findIndex(m => m.type === type);
                if (i !== -1) return Promise.resolve(inbox.splice(i, 1)[0]);
                return new Promise((res, rej) => {
                    const entry = { type, resolve: m => { clearTimeout(t); res(m); } };
                    const t = setTimeout(() => {
                        waiters.splice(waiters.indexOf(entry), 1);
                        rej(new Error('timed out waiting for ' + type));
                    }, timeoutMs);
                    waiters.push(entry);
                });
            },
            // Resolves true if a message of this type shows up within the window, false otherwise
            async gets(type, windowMs) {
                try { await client.next(type, windowMs); return true; } catch { return false; }
            },
            close: () => ws.close()
        };
        client.next('connected').then(msg => { client.id = msg.id; resolve(client); }, reject);
    });
}

function join(client, name, mode, carClass, extra = {}) {
    client.send({
        type: 'join_matchmaking',
        playerName: name,
        carIndex: 3,
        carName: name + ' Car',
        carClass,
        mode,
        carStats: { topSpeed: 60, accel: 12, steering: 7 },
        playerLevel: 17,
        flag: 'pk',
        distance: 5000,
        entryFee: 5000,
        ...extra
    });
}

test('connected message carries the player id in both fields', async () => {
    const a = await connect();
    assert.ok(a.id && a.id.startsWith('ply_'));
    a.close();
});

test('two players in the same mode are matched with each other', async () => {
    const a = await connect();
    const b = await connect();
    join(a, 'Ali', 'HARD', 'S');
    await a.next('queue_joined');
    join(b, 'Bilal', 'HARD', 'SSS');

    const ma = await a.next('match_found');
    const mb = await b.next('match_found');
    assert.strictEqual(ma.roomId, mb.roomId);
    assert.strictEqual(ma.mode, 'HARD');
    assert.strictEqual(ma.opponent.name, 'Bilal');
    assert.strictEqual(ma.opponent.carClass, 'SSS');
    assert.strictEqual(ma.opponent.level, 17);
    assert.strictEqual(ma.opponent.flag, 'pk');
    assert.strictEqual(mb.opponent.name, 'Ali');
    assert.notStrictEqual(ma.role, mb.role);
    a.close(); b.close();
});

test('players in different modes are never matched', async () => {
    const a = await connect();
    const b = await connect();
    join(a, 'Easy Guy', 'EASY', 'C');
    join(b, 'Hard Guy', 'HARD', 'S');
    await a.next('queue_joined');
    await b.next('queue_joined');
    assert.strictEqual(await a.gets('match_found', 2500), false);
    a.send({ type: 'cancel_matchmaking' });
    b.send({ type: 'cancel_matchmaking' });
    await a.next('queue_cancelled');
    await b.next('queue_cancelled');
    a.close(); b.close();
});

test('a car from the wrong class is refused for that mode', async () => {
    const a = await connect();
    join(a, 'Sneaky', 'EASY', 'S');
    const r = await a.next('queue_rejected');
    assert.strictEqual(r.reason, 'car_class_not_allowed');
    assert.deepStrictEqual(r.allowedClasses, ['B', 'C', 'D', 'E']);

    join(a, 'Sneaky', 'TURBO', 'S');
    assert.strictEqual((await a.next('queue_rejected')).reason, 'unknown_mode');
    a.close();
});

test('cancelled search leaves the queue so nobody gets matched with a ghost', async () => {
    const a = await connect();
    join(a, 'Leaver', 'MEDIUM', 'A');
    await a.next('queue_joined');
    a.send({ type: 'cancel_matchmaking' });
    await a.next('queue_cancelled');

    const b = await connect();
    join(b, 'Waiter', 'MEDIUM', 'A');
    await b.next('queue_joined');
    assert.strictEqual(await b.gets('match_found', 2000), false);
    b.send({ type: 'cancel_matchmaking' });
    await b.next('queue_cancelled');
    a.close(); b.close();
});

test('opponent closing the game during VS / loading frees the other player', async () => {
    const a = await connect();
    const b = await connect();
    join(a, 'Stayer', 'EASY', 'B');
    join(b, 'Quitter', 'EASY', 'D');
    await a.next('match_found');
    await b.next('match_found');

    b.close();
    const c = await a.next('match_cancelled');
    assert.strictEqual(c.reason, 'opponent_left');

    // The stayer can search again straight away and find someone new
    const d = await connect();
    join(a, 'Stayer', 'EASY', 'B');
    join(d, 'Newcomer', 'EASY', 'E');
    assert.strictEqual((await a.next('match_found')).opponent.name, 'Newcomer');
    a.close(); d.close();
});

test('a match where one phone never loads is called off after the ready timeout', async () => {
    const a = await connect();
    const b = await connect();
    join(a, 'Fast Phone', 'MEDIUM', 'A');
    join(b, 'Slow Phone', 'MEDIUM', 'A');
    await a.next('match_found');
    await b.next('match_found');
    a.send({ type: 'ready_for_countdown' });

    assert.strictEqual((await a.next('match_cancelled', 4000)).reason, 'ready_timeout');
    assert.strictEqual((await b.next('match_cancelled', 4000)).reason, 'ready_timeout');
    a.close(); b.close();
});

test('full race: both ready, countdown, first to finish wins the pool', async () => {
    const a = await connect();
    const b = await connect();
    join(a, 'Winner', 'HARD', 'S+');
    join(b, 'Runner', 'HARD', 'S');
    const ma = await a.next('match_found');
    await b.next('match_found');

    a.send({ type: 'ready_for_countdown' });
    b.send({ type: 'ready_for_countdown' });
    const ca = await a.next('start_countdown');
    await b.next('start_countdown');
    assert.ok(ca.raceStartTime > ca.countdownStartTime);

    a.send({ type: 'claim_finish', raceTime: 61.2, overtakes: 2, testMode: true });
    const ra = await a.next('race_result');
    const rb = await b.next('race_result');
    assert.strictEqual(ra.outcome, 'WIN');
    assert.strictEqual(ra.prizeCoins, ma.totalPool);
    assert.strictEqual(rb.outcome, 'LOSS');
    a.close(); b.close();
});

test('leaving mid-race gives the other racer a forfeit win', async () => {
    const a = await connect();
    const b = await connect();
    join(a, 'Brave', 'EASY', 'C');
    join(b, 'Rage Quit', 'EASY', 'C');
    await a.next('match_found');
    await b.next('match_found');
    a.send({ type: 'ready_for_countdown' });
    b.send({ type: 'ready_for_countdown' });
    await a.next('start_countdown');
    await new Promise(r => setTimeout(r, 3700)); // countdown finishes, race is live

    b.send({ type: 'leave_race' });
    assert.strictEqual((await a.next('race_result')).outcome, 'FORFEIT_WIN');
    assert.strictEqual((await b.next('race_result')).outcome, 'FORFEIT_LOSS');
    a.close(); b.close();
});

test('health page reports players online', async () => {
    const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/`, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
    assert.strictEqual(body.status, 'online');
    assert.strictEqual(typeof body.playersOnline, 'number');
});
