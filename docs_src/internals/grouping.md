# Alert Grouping

A burst of alerts from the same user on the same host, close together in time, is really one incident, even if the alerts fired different rules. `src/grouping.js` collapses those bursts into one group, so the channel shows one message per incident and a case attaches the whole burst.

This is what stops the channel being spammy and unusable. Twelve alerts from one PowerShell session should be one message, not twelve.

## Two clocks

Alerts carry two timestamps and mixing them up causes subtle, annoying bugs:

| Field | Source | Used for |
| --- | --- | --- |
| `alert.timestamp` | `kibana.alert.@timestamp`, falling back to `@timestamp` | detection time. what a human means by "when did this fire". clustering and display |
| `alert.cursorTimestamp` | `@timestamp` | ingest time. what Elastic ranges and sorts on. only `watchers/alerts.js` touches it |

Nothing in `grouping.js` hands a timestamp back to a query (cases are built from an explicit alert id list) so detection time is all this file needs.

## Pass 1: space, host, user, time

Alerts are bucketed on `spaceId + host.name + user.name`, then each bucket is clustered on detection time with a window of `GROUP_WINDOW_MS` (1 hour default).

The window is measured **from the first alert in the cluster**, not from the previous one. So alerts at 0, 45 and 90 minutes give you two groups, not one. A sliding window would let a slow trickle of alerts grow forever.

An alert with no `host.name` can't be correlated to anything, so it skips both passes and stays a singleton.

## Pass 2: machine identities

The reason this pass exists is beause a session on one host can fire alerts under their own name *and* under whatever service account ran the command. Those used to be separate messages with separate buttons, which is how the same incident ended up in two cases.

So within one space+host, machine-identity clusters get absorbed into the human cluster they overlap in time.

An identity counts as machine if:

- it matches a glob in `GROUP_MACHINE_USERS` (`SYSTEM`, `LOCAL SERVICE`, `root`,
  `svc_*`, `sa_*`, `_*`, …)
- it ends in `$` (an AD computer account, e.g. `WEB-01$`)
- it's absent. An alert with no `user.name` can't contradict a match either, and treating it as machine is what finally gets those alerts out of the singleton bucket they used to land in

The domain prefix is stripped before matching, so `NT AUTHORITY\SYSTEM` and `CORP/svc_backup` match the same way `SYSTEM` and `svc_backup` do. Identities are counted on the *bare* name, because `userNames` is what `incidents.findMatch` compares across polls. The same account arriving under two spellings would look like two users on one host and split the incident.

If a machine cluster overlaps more than one human cluster, it goes to the nearest in time. If there's nobody human on the host at all, overlapping machine clusters fold together anyway.

You can turn this whole pass off with `GROUP_MERGE_MACHINE_USERS=false`.

## What a group looks like

```js
{
  spaceId, hostName,
  userName,           // a human identity always wins
  userNames,          // every identity in the burst, bare
  machineOnly,        // nothing here identifies a human
  machineUsers,
  alerts, count,      // sorted by detection time
  from, to,
  ruleCounts,         // { 'Malware Detected': 2, Beaconing: 1 }
  userCounts,
  topSeverity,        // critical > high > medium > low > unknown
  representativeRule, // most common rule in the burst
}
```

`userName` prefers a human even if SYSTEM fired more of the alerts.

## Where grouping doesn't happen

**Two distinct human users on one host stay separate.** A shared jump box with jsmith and adoe on it is two investigations, and merging them would put one analyst's alerts in the other's case.

**Different hosts never merge, and different spaces never merge.**

**Grouping only sees one batch.** It runs over whatever a single poll returned. Correlating across polls (which is what makes an 8-hour incident possible) is the [incident store's](incidents.md) job, not this file's.
