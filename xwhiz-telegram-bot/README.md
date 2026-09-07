# XWhiz Telegram Bot — Fully Automatic Football Prediction Bot

A production-ready Node.js service that:

- Collects real football data from multiple APIs (API-Football, football-data.org,
  SportScore, WorldCup26, openfootball/football.json).
- Runs a real statistical prediction engine (Dixon-Coles bivariate Poisson + Elo +
  form + league-average scaling + optional odds signal). Never invents stats.
- Publishes predictions in natural Arabic to your Telegram channel every
  1–2 hours automatically.
- Tracks real results, computes accuracy statistics (1X2 / BTTS / O/U / CS) by
  league and confidence bucket.
- Has a Telegram admin panel (commands) and an HTTP web admin dashboard.
- Generates SEO-friendly public HTML pages with Schema.org structured data for
  every published prediction.

## Quick start

```bash
cd telegram-bot
cp .env.example .env
# Edit .env and set TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, TELEGRAM_ADMIN_IDS
npm install
npm start
```

> Requires **Node.js 22.5+** (uses the built-in `node:sqlite` module — no
> native build dependencies needed).

> At least one data source should be configured. The bot will still run without
> API keys using the free fallbacks (SportScore, WorldCup26, openfootball).

## Environment variables

See `.env.example` for the complete list. Key variables:

| Variable | Required | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from @BotFather |
| `TELEGRAM_CHANNEL_ID` | recommended | `@yourchannel` or `-100xxx` |
| `TELEGRAM_ADMIN_IDS` | ✅ | Comma-separated Telegram user IDs allowed to run admin commands |
| `API_FOOTBALL_KEY` | optional | Primary data source. Get at <https://www.api-football.com/> |
| `FOOTBALL_DATA_API_KEY` | optional | Secondary source |
| `PUBLISH_INTERVAL_MINUTES` | optional | Default `90` (publish every 1.5 hours) |
| `MIN_CONFIDENCE` | optional | Default `65` (drop predictions below this) |
| `MAX_PREDICTIONS_PER_CYCLE` | optional | Default `4` |
| `HOURS_AHEAD_MIN`, `HOURS_AHEAD_MAX` | optional | Time window for upcoming fixtures (default 1..36h) |
| `WEB_PORT` | optional | HTTP dashboard port (default `8080`) |
| `DRY_RUN` | optional | If `true`, never sends to Telegram |

## Telegram admin commands

Send these to your bot in a private chat (the bot will only respond to admin IDs).

```
/status             — bot health & 30-day accuracy
/today              — today's matches
/upcoming           — upcoming matches in DB
/predictions [N]    — last N predictions
/accuracy [days]    — accuracy stats
/errors             — last errors
/api                — data source status

/pause              — stop automatic posting
/resume             — resume automatic posting
/trigger            — run one publish cycle immediately
/publish <matchId>  — publish a specific match
/cancel <matchId>   — delete a posted prediction

/setmin <0-100>     — minimum confidence threshold
/setmax <N>         — max predictions per cycle
/setinterval <min>  — publish interval (15..240 minutes)
/include <text>     — include only leagues containing <text>
/exclude <text>     — exclude leagues containing <text>
/leagues            — show league policy
/channels           — show channel info
```

## Web admin dashboard

```
http://localhost:8080/admin/
```

Provides:

- Status cards (paused/running, last publish, predictions today, source health).
- Accuracy statistics for the last 30 days.
- Table of recent predictions with delete buttons.
- Pause / resume / trigger / set controls.

JSON API:

- `GET  /healthz`
- `GET  /api/status`
- `GET  /api/predictions?limit=20`
- `GET  /api/upcoming?limit=50`
- `GET  /api/accuracy?days=30`
- `POST /api/pause`
- `POST /api/resume`
- `POST /api/trigger`
- `POST /api/track_results`
- `POST /api/set_min {value}`
- `POST /api/set_max {value}`
- `POST /api/set_interval {value}`
- `DELETE /api/prediction/:matchId`

## Prediction engine

The engine is in `src/lib/engine.js`. It combines:

1. **Dixon-Coles bivariate Poisson** for the joint goal distribution,
   with Elo ratings from `scripts/dixon_coles.js` (~150-club databank).
2. **League-average scaling** so each league's predicted total matches its
   historical norm (e.g. Bundesliga more open than Serie A).
3. **Form adjustment** (last-5 W/D/L points → Elo-equivalent delta).
4. **Head-to-head adjustment** (when ≥3 H2H matches are available).
5. **Odds adjustment** (tiny; only used as a secondary signal, never sole
   source).
6. **Data-quality score** combining standings availability, recent results
   count, H2H count, odds, league priority.
7. **Ranking score** = weighted combination of confidence, data quality,
   league priority, and recency — used to publish strongest opportunities first.

Markets returned when data is sufficient:

- 1X2 probabilities
- Over 0.5 / 1.5 / 2.5 / 3.5 and under 2.5
- BTTS yes / no
- Correct score (argmax of the score matrix) + top-5
- Expected goals (xG)
- Double chance (1X / X2 / 12)
- Draw-no-bet
- First team to score
- Clean-sheet probability
- Half-time result probabilities
- Corners (range, league baseline)
- Cards (range, league baseline)
- Asian handicap
- Confidence + data-quality score

Markets with insufficient data are omitted. We **never** claim "100%" or
"guaranteed". All output is presented as probabilities.

## Data sources

The bot does not invent data. It tries these in priority order:

1. **API-Football (api-sports.io)** — most comprehensive (fixtures, statistics,
   lineups, injuries, odds, H2H, standings). Recommended.
2. **football-data.org** — good free fallback.
3. **openfootball/football.json** — public-domain season JSON for top-5
   leagues + Championship / Eredivisie / Primeira Liga.
4. **WorldCup26.ir** — free, covers England + Spain.
5. **SportScore** — free, broad coverage.

All sources deduplicate by team-name + date. Cached in-memory for ~5 minutes
(fixtures), 1 hour (standings), 24 hours (H2H), 10 minutes (odds).

## Data storage

SQLite at `telegram-bot/data/bot.sqlite`. Tables:

- `matches` — fixtures, results, status
- `predictions` — every published prediction (UNIQUE on match_id so re-publish
  updates the existing row)
- `results` — actual outcomes per prediction
- `errors` — error log
- `state` — last publish, min confidence, etc.

Logs are rotated daily to `telegram-bot/logs/bot-YYYY-MM-DD.log`.

## SEO / public pages

Every prediction generates a static HTML page with Schema.org `SportsEvent`
+ `FAQPage` structured data at:

```
<PUBLIC_BASE_URL>/predict/<match_id>/
```

A `sitemap.xml` is also generated for the prediction pages. The web admin
server serves them from the `publicDir`.

## Deploying

The bot is a standard long-running Node.js process. Recommended hosts:

- **Railway** / **Render** / **Fly.io** — easy deploy, free tier is enough.
- **VPS** (DigitalOcean / Hetzner) — use systemd or pm2.

### Railway one-liner

1. Push this repo to GitHub.
2. New project on Railway → "Deploy from GitHub".
3. Set environment variables (copy from `.env.example`).
4. Expose port `8080` for the dashboard.
5. Railway will run `npm start` automatically.

### systemd

```ini
[Unit]
Description=XWhiz Telegram Bot
After=network.target

[Service]
WorkingDirectory=/opt/xwhiz/telegram-bot
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
EnvironmentFile=/opt/xwhiz/telegram-bot/.env

[Install]
WantedBy=multi-user.target
```

## Smoke test

```bash
node test/smoke.js
```

Runs offline checks: engine produces sane probabilities, Arabic formatter
emits the required sections, DB migrations succeed.

## CLI helpers

```bash
npm run analyze         # dry-run analysis (no Telegram publish)
npm run publish-one <id> # manually publish one prediction
npm run track-results    # one-shot results tracking
```

## License

MIT
