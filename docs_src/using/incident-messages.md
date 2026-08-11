# Incident Messages

When the alert watcher finds new alerts it collapses related ones into an *incident* and posts one message per incident, not one per alert. That message is then re-rendered in place as more alerts arrive and as a case gets made, so a message you scroll back to two hours later shows current state rather than state at post time.

## What the message shows

A burst:

```
🚨 3 related alerts — `jsmith` (+SYSTEM) on host `web-01`

Top severity: high · Space: Security Operations
Window: 2026-07-30T12:00:00Z → 2026-07-30T12:45:00Z
Rules: Malware Detected ×2, Beaconing ×1

[ Create case (3 alerts) ]
```

A single alert gets a different header (`New alert — <rule>`) and its metadata line carries the alert ID, host and user instead of a time window.

The identity line shows the machine accounts that grouping folded in, rather than hiding them. `` `jsmith` (+SYSTEM, svc_backup) ``.

## Incident states

The same message renders one of three ways depending on where the incident is:

**1. No case yet.** A green **Create case** button. Clicking it files every alert
on the message into one case.

**2. Case exists, nothing outstanding.** No buttons at all, as there's genuinely
nothing left to do to it from Slack. A context line names the case, links it, and
says how much of the incident is on it:

```
📂 SO-073026-Malware Detected — 3 of 3 alerts attached
```

**3. Case exists, new alerts have arrived since.** The case line, plus a section listing what isn't attached yet, plus a green **Add N new alerts to case** button:

```
📂 SO-073026-Malware Detected — 1 of 3 alerts attached
─────────────────────────────────────────────
🆕 2 new alerts since the case was created
Beaconing ×1, Malware Detected ×1

    /add_alert case-1 a2
    /add_alert case-1 a3

[ Add 2 new alerts to case ]
```

Past ten pending alerts the list is truncated to `+N more not listed — use the button`, since at that point it's just noise.

## Two analysts clicking the button at the same time

Between the click and the message update there are two or three Elastic round trips (~1-3 seconds) and for that whole window the button is still green on everyone else's screen. An incident *claim* is taken synchronously before any network call, so the second click loses instantly and gets told who's already on it:

> Someone else is creating a case for this incident right now. Give it a second
> and refresh.

While a claim is held the message shows `⏳ @jsmith is creating a case…`, which is purely cosmetic (the claim is what actually blocks the duplicate) but it stops the second analyst wondering why nothing happened.

The **Add N new alerts** button takes the same claim because Kibana's attach isn't idempotent, so two clicks would double-attach.

More detail in [Incidents](../internals/incidents.md#claims).

## Incident Reaping

An incident is reaped after `INCIDENT_IDLE_MS` with no new alerts (8 hours by default, roughly a shift) or `INCIDENT_MAX_LIFETIME_MS` regardless of activity (24 hours).

Reaping doesn't delete the Slack message. It stays in the channel with whatever buttons it last had, and clicking one tells you the incident has closed out:

> That incident has closed out (no new alerts for 8h) and is no longer tracked.
> Use `/add_alert <caseID> <alertID>` for the alert IDs on the message.

The next alert on that host starts a fresh incident with a fresh green button. That's the intended behaviour. An incident from last night shouldn't absorb this morning's alerts.

## New case notifications

Separately from all of the above, the case watcher posts a short message for every case created in a watched space:

```
📂 New case — SO-073026-Malware Detected
Case ID: `case-1` · Space: Security Operations · Created by: jsmith
```

These are informational and have no buttons. Configure which spaces get watched with `WATCH_CASE_SPACES`.