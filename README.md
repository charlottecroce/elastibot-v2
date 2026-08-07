# Elastibot

[![tests](https://github.com/charlottecroce/elastibot-v2/actions/workflows/tests.yml/badge.svg)](https://github.com/charlottecroce/elastibot-v2/actions/workflows/tests.yml)

A Slack bot (Node.js / Bolt) that helps security analysts turn Elastic alerts into Kibana cases without leaving Slack, and pushes new alerts and cases into designated channels.

## Commands

| Command | What it does |
| --- | --- |
| `/start <kibana_username>` | Opens a modal explaining how to create an Elastic API key and lets you paste it privately. Cases you make are then attributed to you. |
| `/case <alertID>` | Creates a case in the alert's own space, titled per the naming scheme, and attaches the alert. Replies in-channel with the case ID and link. |
| `/add_alert <caseID> <alertID>` | Attaches an alert to an existing case. The case ID comes from Elastibot's creation message. |
| `/stats [window] [filters] [share]` | Aggregate view of the alerts index: top and noisiest rules, severity/risk spread, top hosts, users and processes, and when alerts actually fire. |

New alerts also arrive in channel with a **Create case** button (same as `/case`).


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

## Creating API Keys

In Kibana Dev Tools

```
POST /_security/api_key
{
  "name": "elastibot-charlotte.croce"
}
```

And copy the base64 encoded value.

Then edit the permissions JSON in Stack Management > Security > Api Keys. The permissions JSONs to use are in the [api_permissions](api_permissions) directory. 

There is also an option to auto-create API keys via admins credentials. To configure this, add authorized user's SlackIDs to .env and you'll be able to enter elastic admin credentials to create an analyst API key.
