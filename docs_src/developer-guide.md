# Developer Guide

## Module dependency order

Roughly bottom to top. Anything can require downward; requiring upward is likely not good design and usually means the thing belongs in `services/`.

```
util/logger                    depends on nothing
util/{crypto,errors,cache,atomicFile,retry,sleep,url,mrkdwn}
config/                        depends on util
constants.js
store.js, incidents.js         depends on config + util
elastic.js                     depends on config + util
grouping.js, naming.js         depends on config + constants
services/                      depends on all of the above
commands/, watchers/           depends on services
context.js                     assembles the stores
app.js                         wires everything
```

`services/incidentRender.js` exists specifically because of that rule. Both the watcher (new alerts folded in) and the button handlers in `commands/case.js` (a case made, alerts attached) need to re-render an incident message, and a command module requiring the watcher would be backwards coupling. There should be exactly one place that knows how to put an incident on screen.

## Adding a slash command

Drop a file in `src/commands/` that exports a register function. Discovery is automatic, there's no `app.js` edit step.

```js
'use strict';

const { COMMANDS } = require('../constants');

module.exports = function registerThing(reg) {
  reg.command(
    COMMANDS.THING,
    async ({ argv, user, reply, ctx, log }) => {
      // user.apiKey is the analyst's decrypted Elastic key
      await reply.ephemeral('hello');
    },
    {
      requireUser: true,
      usage: 'Usage: `/thing <id>`',
      minArgs: 1,
    }
  );
};
```

Files starting with `_` are skipped, for helpers that live alongside commands but aren't commands. `index.js` is skipped too. Registration order is alphabetical and therefore deterministic.

A module exporting the wrong shape is logged at `error` and skipped rather than failing silently.

Handler args, on top of what Bolt gives you:

| | |
| --- | --- |
| `ctx` | the application context (`users`, `state`, `incidents`, `spaces`) |
| `log` | scoped logger, already carrying `traceId` and `slackUserId` |
| `reply` | `.ephemeral(msg)` / `.inChannel(msg)`, string or Block Kit payload |
| `user` | the registered user record, when `requireUser` is set |
| `text`, `argv` | trimmed command text, and it split on whitespace |
| `traceId`, `slackUserId` | |

Options: `requireUser`, `usage`, `minArgs`, `userErrorSuffix`, `autoAck`.

Then add the command to `COMMANDS` in `src/constants.js` **and** to `manifest.yml`. Those two have to agree; `constants.js` exists so the mismatch is at least in one obvious place.

## Adding a button

Add the `action_id` to `ACTIONS` in `src/constants.js`, render the button with
that id, and register a handler with `reg.action(...)`. Modal callback ids go in
`VIEWS` the same way.

Buttons carry the incident key in `value`, as a bare string and nothing else. If the action mutates an incident, take a claim first:

```js
const claim = await withClaim(ctx.incidents, key, slackUserId, async (rec) => {
  // ... network work here. the claim is already held
}, { allowExistingCase: true });

if (!claim.ok) {
  await reply.ephemeral(claimRefusal(claim));
  return;
}
```

`withClaim` releases on success as well as on failure, so a body that doesn't happen to call `recordCase` doesn't leave the incident wedged for a minute.

Then re-render with `renderIncident(client, ctx.incidents, key)`. It swallows Slack failures and returns `null`, so a stale message never fails the operation the analyst actually asked for.

## Tests

```bash
npm test
npm run test:watch
npm run test:coverage
```

Jest, `tests/**/*.test.js`. Nothing touches a real cluster or a real Slack workspace. The Elastic client is mocked and `tests/setup.js` pins the config the tests assume, so no `.env` is needed and forks can run the suite too.

`setupFiles` (not `setupFilesAfterEach`) matters here: `config/index.js` reads `process.env` at require time, and half the modules under test pull it in.

CI runs `npm run check` then `npm test -- --ci` on every push to `main` and every PR.

## Lint and syntax checks

```bash
npm run check        # lint + syntax
npm run lint
npm run lint:fix
```

`scripts/check-syntax.js` parses every `.js` file with `node --check`. It overlaps with eslint but has no dependencies, so it still runs when `node_modules` is missing or eslint itself is broken.

`docs/`, `coverage/` and `data/` are in `.eslintignore` - the first two ship bundled third-party JS that isn't ours to lint.

## Building these docs

```bash
pip install mkdocs
mkdocs serve     # http://127.0.0.1:8000
mkdocs build
```

Source is `docs_src/`, output is `docs/`. The built site is committed to the repo by `.github/workflows/docs.yml` on every push to `main`, which is what GitHub Pages serves. The workflow ignores changes under `docs/` so it doesn't trigger itself.

Add a page by dropping the markdown in `docs_src/` and adding it to `nav` in `mkdocs.yml`. Then add it to the table of contents in `docs_src/index.md` too.
