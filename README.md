# Elastibot

A Slack bot (Node.js / Bolt) that helps security analysts turn Elastic alerts into Kibana cases without leaving Slack, and pushes new alerts and cases into designated channels.

## Commands

| Command | What it does |
| --- | --- |
| `/start <kibana_username>` | Opens a modal explaining how to create an Elastic API key and lets you paste it privately. Cases you make are then attributed to you. |
| `/case <alertID>` | Creates a case in the alert's own space, titled per the naming scheme, and attaches the alert. Replies in-channel with the case ID and link. |
| `/add_alert <caseID> <alertID>` | Attaches an alert to an existing case. The case ID comes from Elastibot's creation message. |
| `/stats [window] [filters] [share]` | Aggregate view of the alerts index: top and noisiest rules, severity/risk spread, top hosts, users and processes, and when alerts actually fire. |

New alerts also arrive in channel with a **Create case** button (same as `/case`).

### `/stats`

Runs one `size:0` aggregation query under your own API key, so you only ever see what you're allowed to see. The reply is ephemeral (it's a wall of text) unless you add `share`.

```
/stats                              # last 7d, everything
/stats 30d                          # 24h, 7d, 2w ... up to STATS_MAX_WINDOW_DAYS
/stats 24h host:web-01
/stats 30d user:jsmith share
/stats 7d rule:"Suspicious PowerShell Download"
/stats 30d space:soc
/stats help
```

- **Noisiest** ranks by alerts per distinct host.

Set `STATS_TIMEZONE` to your SOC's timezone or "busiest hour" doesn't mean anything.

## Setup

1. **Create the Slack app** from [manifest.yml](manifest.yml)
   (https://api.slack.com/apps > *From an app manifest*), then install it.

2. **Configure secrets**

  After creating the app:
  1. Basic Information > Signing Secret  >  SLACK_SIGNING_SECRET.
  2. Basic Information > App-Level Tokens > generate a token with scope (name doesn't matter. I usually name it elastic-api)  > `connections:write`  >  this is your SLACK_APP_TOKEN (xapp-...).
  3. Install App > copy the Bot User OAuth Token  >  SLACK_BOT_TOKEN (xoxb-...).

   ```bash
   cp .env.example .env
   # fill in Slack + Elastic values; set ELASTIBOT_SECRET_KEY to a long random string

   openssl rand -hex 16   # this will generate a 32-char random string
   ```

3. **Install & run**
   ```bash
   npm install
   npm start
   ```

Runs in **Socket Mode** by default (no public URL needed - good for an internal deployment). Set `SLACK_SOCKET_MODE=false` to run an HTTP server on `PORT`.

## Tests

```bash
npm test              # jest
npm run test:watch
npm run test:coverage
```

Nothing in the suite touches a real cluster or a real Slack workspace: the Elastic client is mocked and [tests/setup.js](tests/setup.js) pins the config the tests assume, so no `.env` is needed.`.github/workflows/tests.yml](.github/workflows/tests.yml) runs the same command on Node 18/20/22 for every push to `main` and every PR.

## Security notes

- Analyst API keys are stored encrypted at rest (AES-256-GCM) when
  `ELASTIBOT_SECRET_KEY` is set; a startup warning fires if it isn't.
- Keys are collected via a modal input, so they never appear in channel history.
- Each user acts with their own Elastic API key, so case ownership/permissions reflect the real analyst. The watchers use a separate service key.

## Creating API Keys

In Kibana Dev Tools

```
POST /_security/api_key
{
  "name": "elastibot-charlotte.croce"
}
```

And copy the base64 encoded value.

Then edit the permissions JSON in Stack Management > Security > Api Keys. The permissions JSONs to use are in the api_permissions directory

## How the Elastic side works

- **Alert lookup** - an `ids` query against `ALERTS_INDEX` (default
  `.alerts-security.alerts-*`) resolves the alert, its space (`kibana.space_ids`),
  rule name/uuid, and solution owner (from `kibana.alert.rule.consumer`).
- **Case creation** - `POST /s/<space>/api/cases`.
- **Alert attach** - `POST /s/<space>/api/cases/<id>/comments` with an `alert`
  attachment (the case and alert share a space).
- **Space display name** - `GET /api/spaces/space/<id>` for the naming scheme.
- **Statistics** - one `size:0` `_search` with terms/cardinality/date_histogram
  aggregations. Hour-of-day and day-of-week are folded out of hourly buckets
  client-side, so the query needs no runtime scripts.
- **Watchers** poll ES for new alerts and the Kibana Cases `_find` API per configured
  space, tracking last-seen timestamps in `data/state.json`.

