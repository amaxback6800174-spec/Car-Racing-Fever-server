# Car Racing Fever server

Real-time 1 VS 1 matchmaking and race server for Car Racing Fever (WebSocket, Node.js).

## What it does

- **Matchmaking by mode.** A player only meets someone in the same mode, and the car must belong to that mode's classes. Anything else is refused with `queue_rejected`.

  | Mode   | Allowed car classes |
  |--------|---------------------|
  | EASY   | B, C, D, E          |
  | MEDIUM | A                   |
  | HARD   | S, SSS, S+          |

- **No stuck players.** If the opponent closes the game or leaves during the VS or loading screen, the other player gets `match_cancelled` and can search again right away. The same happens when a phone does not load the race within 45 seconds.
- **Race.** Countdown sync, opponent position relay, first to finish wins the pool, and leaving mid-race counts as a forfeit.

## Run locally

```bash
npm install
npm start          # ws://localhost:3000
npm test           # starts a server and plays 10 scenarios with fake phones
```

On Windows you can also double-click `start_server.bat`.

## Put it online (Render, free)

1. Sign in at render.com with GitHub.
2. Click **New > Blueprint** and pick this repo. `render.yaml` sets everything up.
3. When it is live, the game's server address is `wss://<service-name>.onrender.com`.

The free plan sleeps after 15 minutes without players, so the first search after that waits about a minute while it wakes up.

## Messages

The game sends `join_matchmaking` with `mode`, `carClass`, `carIndex`, `carName`, `carStats`, `playerName`, `distance` and `entryFee`. Then it sends `cancel_matchmaking`, `ready_for_countdown`, `telemetry`, `claim_finish` or `leave_race` as the match goes on.

The server answers with `connected`, `queue_joined`, `queue_rejected`, `match_found`, `match_cancelled`, `start_countdown`, `opponent_telemetry`, `opponent_disconnected` and `race_result`.
