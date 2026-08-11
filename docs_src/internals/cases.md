# Cases

Case creation and alert attachment live in `src/services/caseService.js`. Everything here runs under the analyst's own API key, so the case in Kibana is attributed to them.

## Entry points

| Function | Triggered by | Does |
| --- | --- | --- |
| `createCaseForAlert(apiKey, alertId)` | `/case <id>` | one alert → one case |
| `createCaseForIds(apiKey, ids, {spaceId})` | green **Create case** | a whole incident → one case |
| `attachAlertsToCase(apiKey, {...})` | **Add N new alerts** | pending ids → existing case |
| `addAlertToCase(apiKey, caseId, alertId)` | `/add_alert` | one alert → any case |

`createCaseForIds` deliberately does **not** re-run a user+host+time query. The incident record is already the authoritative list of what the Slack message
shows, and a fresh query could disagree with it. An alert that aged out of the window, a stale cursor, whatever. It does filter fetched alerts to the expected
`spaceId` as a sanity check, since an id resolving to a different space than the incident it came from would otherwise land in the wrong case.

Resolving ids tolerates individual misses but not a systemic failure: a 400/404 on one id just means that alert is gone, anything else aborts the whole thing. If *nothing* resolves you get a user-facing error rather than an empty case.

## Case naming

```
PART1-MMDDYY-Rule Name
```

- **part 1** — the space's *display* name. One word → first three letters
  (`default` → `DEF`). Two or more → initials (`Security Operations` → `SO`)
- **part 2** — `MMDDYY`
- **part 3** — the most common rule in the burst, whole by default. Set
  `CASE_TITLE_RULE_WORDS` to truncate to N words.

```
SO-073026-Malware Detected
DEF-070426-Suspicious PowerShell
```

Every date is rendered in an explicit IANA zone (`CASE_TITLE_TIMEZONE`, falling back to `STATS_TIMEZONE`, then `UTC`), so the same alert produces the same title whatever region the process happens to be running in.

Cases are also tagged `elastibot` and with a month-year tag (`July 2026`) in the same zone.

## Owner and space

A case is created in the space its alerts came from, with an *owner*, the Kibana solution the case belongs to. The owner is derived from each alert's rule consumer:

| consumer | owner | cases live at |
| --- | --- | --- |
| `siem` | `securitySolution` | `/app/security/cases` |
| `logs`, `metrics`, `apm`, `uptime`, `slo`, … | `observability` | `/app/observability/cases` |
| anything else | `DEFAULT_CASE_OWNER` | `/app/management/insightsAndAlerting/cases` |

When a burst spans owners, the most common one wins for the whole case, and it's then forced across every attach batch. When attaching to a case that *already* exists, each alert keeps its own owner instead. The case's owner was fixed at creation and isn't up for renegotiation.

The owner is stored on the incident record so a "View case" link can be rebuilt from the record alone later. A wrong-solution path is still a link an analyst can follow.

Links themselves are built in `src/services/kibanaLinks.js` from `KIBANA_PUBLIC_URL`, with `/s/<space>` prefixed for any non-default space.

## Attaching in per-rule batches

Kibana's comments API takes one rule per alert-comment but accepts an array of alert ids. So alerts get grouped by rule and posted one comment per rule, in
`src/services/attachAlerts.js`.

Failures are collected rather than thrown:

- **some batches failed** → the case exists, the successful ids are recorded, and
  a `⚠️` warning is appended to the Slack message. The incident's pending list
  stays honest because only the ids that actually attached get marked attached.
- **every batch failed** → user-facing error naming the case that *was* created,
  so it isn't orphaned silently.

Both cases are also logged, so there's a record after the Slack message scrolls
away.

Cases are created with `settings: { syncAlerts: true }`, which means the case status drives the status of every alert attached to it from then on. Closing the case closes its alerts.

## Alert workflow status

Case syncing only pushes status to alerts when the **case** status changes. So an alert joining an already in-progress or closed case would otherwise sit there open forever.

`addAlertToCase` reads the case first, and if its status isn't `open`, forces the matching workflow status on the alert once. After that the case's own syncing keeps it in line.

```
open        → open
in-progress → acknowledged
closed      → closed
```

This is best-effort. If the status call fails, it's logged at `warn` and the attach still counts. The alert is on the case, it just didn't inherit the status. Failing the whole operation over that would be worse.