# Incidents

[Grouping](grouping.md) only sees one poll's worth of alerts. With a 1-minute poll tick, two related alerts ten minutes apart would land in two different batches and get two different messages, which creates the spammy channel the grouping was supposed to fix.

The incident store is the persistence layer that fixes that. It remembers what was posted, so a later tick can merge into an existing message instead of posting a new one, and so two analysts can't open two cases for the same burst.

It lives in `src/incidents.js`, persists to `data/incidents.json`, and is shared between the watchers and the button handlers via the [application context](architecture.md#the-application-context).

## What a record holds

```js
{
  key,                    // random UUID. carried on every button
  spaceId, hostName, spaceName,
  userNames, primaryUser,

  channel, messageTs,     // where the message is, so it can be updated

  alertIds,               // everything shown on the message
  attachedIds,            // the subset that made it onto the case
  alertRules,             // id > rule name, for every alert

  caseId, caseTitle, caseLink, caseOwner,
  claim,                  // { by, at } while someone is mid-click

  ruleCounts,             // derived from alertRules
  representativeRule,
  topSeverity,
  from, to,

  createdAt, lastActivityAt,
}
```

`alertRules` is the single source of truth for `ruleCounts` and `representativeRule`. Both are recomputed from it on every change rather than maintained separately, so the two can't disagree.

Keys are generated, not derived from anything. They're plain UUIDs, which keeps them safe to put in a Slack button `value`.

## Matching a new burst to an open incident

`findMatch(group)` is deliberately narrow. Same space and host is necessary but not sufficient. Two analysts' sessions on one jump box are two incidents.

A record matches when all of:

- same `spaceId` and same `hostName` (no host at all → no match, ever)
- it has a `messageTs` (a failed or in-flight post is inert)
- it hasn't expired
- and **either** the incoming identities overlap the record's, **or** the whole incoming burst is `machineOnly` and so carries no information that would contradict the match

If somehow there are two candidates, the most recently active wins.

`findByAlertId(id)` is the other lookup, used by `/case` and `/add_alert` so a case made from the command line still updates the block kit.

## Claims

`tryClaim` is the thing that makes a duplicate case impossible.

```js
tryClaim(key, slackUserId, { allowExistingCase })
  → { ok: true, rec }
  → { ok: false, reason: 'case_exists' | 'claimed' | 'gone', rec }
```

It's synchronous and runs **before** any network call, so the second click loses instantly. The refusal reasons map to different messages:

| reason | meaning |
| --- | --- |
| `case_exists` | there's already a case — use it instead of making another |
| `claimed` | another analyst is mid-click, wait a second |
| `gone` | the incident was reaped out from under the message |

`allowExistingCase` is for the add-alerts path, which needs the mutual exclusion (Kibana's attach isn't idempotent, two clicks would double-attach) but for which an existing case is the precondition rather than a refusal.

A claim is honoured for `INCIDENT_CLAIM_TTL_MS` (60s) and then treated as abandoned. Claims are also cleared wholesale at boot, since nothing can be mid-creation when the process has just started.

!!! warning
    This is a single-process lock. It's correct within one Elastibot instance and
    **not** correct across two pointed at the same workspace. Running more than
    one means moving the claim to something with a real compare-and-set - Redis
    `SETNX`, or an ES document updated with `if_seq_no`.

## Pending alerts

`pending(rec)` is `alertIds` minus `attachedIds`, the alerts shown on the message that aren't on the case yet. It's what drives state 3 of the
[incident message](../using/incident-messages.md#incident-states).

The important bit is that `recordCase` takes the ids that *actually* attached, not the ids it tried to attach. A partial attach reporting success would under-report pending, and the analyst would never find out an alert is missing from the case.

`ruleCountsFor(rec, ids)` computes a rule breakdown over any subset, so the "N new alerts" section can show a breakdown for just the pending ones. It reads off the record rather than off whatever batch triggered the render, otherwise a pending alert left over from an earlier tick goes missing from the count the analyst reads.

## Reaping

`sweep()` runs at the top of every alert poll, so the store stays bounded without needing its own timer. A record is dropped when either:

- `now - lastActivityAt >= INCIDENT_IDLE_MS` (8h default). Pick something like a shift length rather than something short.
- `now - createdAt >= INCIDENT_MAX_LIFETIME_MS` (24h default). To prevent infinitely growing cases.

A reaped incident isn't deleted from Slack. The message stays with whatever buttons it last had, and those buttons report that the incident has closed out.