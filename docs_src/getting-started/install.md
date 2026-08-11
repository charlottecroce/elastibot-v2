# Installation

## Requirements

- Node.js 18 or newer (CI runs the suite on 22.x)
- npm
- An Elasticsearch cluster with Kibana, reachable from wherever you run the bot
- A Slack workspace you can install an app into

Elastibot talks to Elasticsearch directly for alert lookups and to Kibana for the Cases and Spaces APIs. One Elastic API key authenticates to both, so you need one credential per identity, not two.

```bash
git clone https://github.com/charlottecroce/elastibot-v2.git
cd elastibot-v2
npm install
```

## Creating the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → *From an app manifest* and paste in [`manifest.yml`](https://github.com/charlottecroce/elastibot-v2/blob/main/manifest.yml) from the repo root. That declares the four slash commands, the bot scopes (`commands`, `chat:write`, `chat:write.public`) and turns on Socket Mode and interactivity.

Then collect three secrets:

1. **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`
2. **Basic Information → App-Level Tokens** → generate one with the
   `connections:write` scope → `SLACK_APP_TOKEN` (starts with `xapp-`). The name
   doesn't matter.
3. **Install App → Bot User OAuth Token** → `SLACK_BOT_TOKEN` (starts with `xoxb-`)

Finally, invite the bot to whatever channel you're routing alerts to, and grab
that channel's ID for `DEFAULT_CHANNEL`.

## Configuration

Secrets go in `.env`. Everything else lives in `config/index.js`, which reads env vars but has a sensible default for each, so you can leave most of it alone.

```bash
cp .env.example .env

openssl rand -hex 16   # 32-char string for ELASTIBOT_SECRET_KEY
```

The bare minimum to get running:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

KIBANA_URL=https://kibana.internal:5601
ELASTICSEARCH_URL=https://es.internal:9200
ELASTIC_SERVICE_API_KEY=base64EncodedApiKey=

ELASTIBOT_SECRET_KEY=<the openssl output>
DEFAULT_CHANNEL=C0123456789
```

Two things worth setting even though they're optional:

`KIBANA_PUBLIC_URL` is the endpoint an analyst's *browser* reaches, as opposed to
`KIBANA_URL`, which is the endpoint the bot's HTTP client uses. Every case link posted in Slack is built from the public one. If analysts get at Kibana through a proxy and you leave this unset, every link points at the internal hostname and clicking one forces a re-login.

`STATS_TIMEZONE` is what `/stats` buckets hour-of-day and day-of-week into. Set it to your SOC's timezone or "busiest hour" doesn't mean anything.

The full list is in [Configuration](../reference/configuration.md).

## Running it

```bash
npm start        # node app.js
npm run dev      # node --watch app.js
```

Socket Mode is the default, so there's no public URL and no inbound firewall rule to argue about, which is good for an internal deployment. Set `SLACK_SOCKET_MODE=false` to run an HTTP server on `PORT` instead, which means you also have to set up request URLs in the Slack app config.

## Checking it worked

`validateConfig` runs before anything connects and throws a `ConfigError` listing everything that's wrong.

It also emits warnings for things that are legal but probably not what you wanted, and those are worth reading:

- `ELASTIBOT_SECRET_KEY is not set` - analyst API keys go to disk in plaintext
- `WATCHERS_ENABLED is true but ELASTIC_SERVICE_API_KEY is not set` - the
  watchers won't run at all
- `no DEFAULT_CHANNEL and no channelRouting entries` - the watchers run and post
  nothing
- `ELASTIC_TLS_REJECT_UNAUTHORIZED=false` - fine for an internal cluster with a
  self-signed cert, not fine otherwise

A healthy start logs `elastibot started` and then `watchers started` with the poll interval and which pollers are enabled. First tick doesn't backfill: with no cursor on disk the watchers set one to *now* and watch forward, rather than dumping a month of history into the channel.

From there, run `/start` in Slack to register yourself.