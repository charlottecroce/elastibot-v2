# The Watchers

`src/watchers/index.js` decides whether the watchers should run at all, assembles their dependencies, and hands a single `tick` to the runner. The polling logic is in `alerts.js` and `cases.js`; the loop is in `runner.js`.

The watchers don't start if `WATCHERS_ENABLED=false`, or if `ELASTIC_SERVICE_API_KEY` isn't set. Either way you get a runner-shaped no-op back, so `app.js` never has to null-check it.

## The runner

A `setTimeout` chain rather than `setInterval`, so a slow tick delays the next one instead of stacking up behind it. Each interval is randomised by `WATCH_JITTER_RATIO` (±10% by default) so two replicas started by the same deploy don't hit Elastic in lockstep forever.

A tick that throws is caught, counted and survived. Consecutive failures escalate from `warn` to `error` at ten in a row.

`stop()` clears the timer and waits for any tick already in flight.

## The alert watcher

Each tick, in order:

1. **Sweep expired incidents.** Done first, so an incident that went quiet overnight can't absorb this morning's alerts.
2. **Read the cursor.** No cursor on disk means first run: set it to *now* and return. No backfill.
3. **Query.** `getAlertsSince(cursor, WATCH_FETCH_SIZE)`. everything with an ingest timestamp strictly after the cursor, oldest first.
4. **Drop anything already on a live incident record.** Makes replaying a batch idempotent. This matters most for hostless alerts, which `findMatch` can't correlate at all. Without this filter a rewound cursor posts them a second time.
5. **Group.** See [Alert Grouping](grouping.md).
6. **Route each group to a channel**, then either post a new incident message or
   merge into and re-render an existing one.
7. **Advance the cursor.**

The incident record is opened *before* the message is posted, because the buttons carry the incident key and the key has to exist to render them. That's what lets an incident go out in one API call instead of a skeleton followed by an update. If the post then fails, the record is discarded. A record with no `messageTs` would make `findMatch` fold the next tick's alerts into a message that doesn't exist, and they'd never be seen.

Posts are spaced by `WATCH_POST_DELAY_MS` (300ms) to stay under Slack's roughly one-message-per-second channel limit.

## The case watcher

Polls the Kibana Cases `_find` API per space in `WATCH_CASE_SPACES` and posts anything created since that space's cursor. Each space keeps its own cursor.

Cases come back newest-first, so the fresh ones get filtered then re-sorted ascending, to post in the order they actually happened.

Same first-run rule: with no cursor, set it to the newest case (or to now, if the space has no cases) and backfill nothing.

If every case on the page was new, that's logged as a warning. Some may have been missed, and the fix is raising `WATCH_CASES_PER_PAGE` or lowering the poll interval for that space.

The cursor is only written when something actually moved, so a quiet space isn't a pointless disk write every minute.

## Cursors and the rules about them

A cursor has exactly two ways to be wrong, and both are bad:

- **advance it when a post failed** → the alert is lost forever
- **fail to advance it** → the channel gets the same alerts every minute

So the rules are:

- **A failed query holds the cursor.** Advancing there would skip everything created during the outage.
- **A failed post does not.** The cursor advances past failures, meaning those incidents are dropped rather than retried. Retrying a Slack post that failed for a structural reason (`channel_not_found`) just fails forever. Failures are counted and logged at `error` so they're visible.
- **A batch with no usable cursor timestamp holds the cursor**, and logs loudly, because that means `@timestamp` isn't mapped the way the query assumes and every alert *will* repeat.
- **A full page sharing one millisecond gets forced forward 1ms.** A `gt` range can never step past it otherwise, and the remaining ties get dropped. Also logged loudly, with `raise WATCH_FETCH_SIZE` as the remedy.

The alert cursor is `@timestamp`, the ingest time, exposed on the alert object as `cursorTimestamp`. This is **not** the same field as `alert.timestamp`, which prefers `kibana.alert.@timestamp` (detection time) and is what grouping and display use. Two clocks, two jobs. See [Two clocks](grouping.md#two-clocks).

## Channel routing

```js
config.watchers.channelRouting[spaceId] || config.watchers.defaultChannel
```

`channelRouting` is a plain object in `config/index.js`, keyed by Elastic space
ID:

```js
channelRouting: {
  'soc': 'C0123456789',
  'observability': 'C0987654321',
},
```

Anything unmatched goes to `DEFAULT_CHANNEL`. Small SOCs with only a few spaces can probably just route everything to `DEFAULT_CHANNEL` for convenience. A space that routes to nothing is skipped, but it's *counted* in the tick summary rather than silently ignored, because an unrouted space is a mistake that should be errored.