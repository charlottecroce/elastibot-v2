# Slash Commands

## `/start`

```
/start [kibana_username]
```

Opens a modal to register your Elastic API key. The username argument is optional and only used to label the key and the confirmation message.

Two ways to connect, chosen with a radio toggle in the modal:

- **paste my own key**: you create the key in Kibana and paste the encoded
  value in. Nothing is verified against Elastic at this point; the first command
  you run is what finds out whether the key works.
- **create one for me**: you paste an admin username and password and Elastibot
  creates a correctly-scoped key for you. Only shown if your Slack ID is in
  `AUTO_PROVISION_SLACK_IDS`.

Either way the key is encrypted with AES-256-GCM before it goes to disk, and the confirmation arrives as a DM. If `ELASTIBOT_SECRET_KEY` isn't configured the DM says so, because a key sitting in plaintext on disk is something you should know about.

Re-run it any time to rotate. See [Elastic API Keys](../getting-started/api-keys.md).

## `/case`

```
/case <alertID>
```

Creates a case for that one alert, in the alert's own space, titled per the [naming scheme](../internals/cases.md#case-naming), and attaches the alert to it. Replies in-channel with the case ID, title and link.

If the alert is already on a posted incident message, `/case` routes through the same claim the green button uses. And if that incident *already* has a case, the command refuses and points you at the existing one:

> Alert `abc123` is already part of an incident with case `case-1`. Use the **Add
> new alerts to case** button on that message, or `/add_alert` if you want it
> somewhere else.

Note that this is the single-alert path. To file a whole burst into one case, use the green **Create case** button on the incident message. That one uses the message's own alert list.

## `/add_alert`

```
/add_alert <caseID> <alertID>
```

Attaches an alert to a case that already exists. The case ID comes from Elastibot's creation message.

This is also the manual fallback for the **Add N new alerts to case** button. Incident messages render one ready-to-run `/add_alert` command per pending alert, inside a code fence, precisely so you can copy them out when the button fails.

Running one updates the incident message too, as long as the alert landed on the incident's *own* case. If you file an alert onto some unrelated case from last week, the incident message correctly goes on listing it as pending, because it still isn't on the case that message links to.

## `/stats`

```
/stats [window] [filters] [share]
```

An aggregate view of the alerts index. Everything comes out of one `size: 0` aggregation search, so nothing pages through documents and a 30-day window costs about what an hour does.

| Part | Values |
| --- | --- |
| window | `24h`, `7d`, `2w`, `30m` - default `7d`, capped at `STATS_MAX_WINDOW_DAYS` |
| filters | `rule:"Rule name"`, `host:web-01`, `user:jsmith`, `space:soc` |
| `share` | post the result in-channel instead of only to you |

Order doesn't matter, and quoted filter values keep their spaces. Tokens are parsed *before* the Elastic client is built, so junk input never reaches the cluster.

```
/stats 30d space:soc
/stats 24h rule:"Suspicious PowerShell Download" share
/stats help
```

What comes back:

- headline counters: total alerts, distinct rules/hosts/users, alerts/day,
  what percentage is attached to a case, average and max risk
- severity and workflow-status spread
- **top rules by volume**, with per-rule host count and case rate
- **noisiest rules**, ranked by alerts per *distinct host* rather than raw
  volume, so 60 alerts on one box beats 30 spread over fifteen.
- top hosts, users, processes, and spaces
- hour-of-day as a sparkline, plus day-of-week, both bucketed in `STATS_TIMEZONE`

The reply is ephemeral unless you add `share`.

!!! note
    `/stats` only reads aggregate numbers back from Elasticsearch. It never
    downloads alert documents. That's what makes it fast, and it's also the limit
    on what it can do. Anything needing per-alert analysis (exception monitoring,
    say) would mean pulling alerts into a local store first, which is a different
    piece of work.

## Errors


**Expected failures** (bad input, a missing alert, a rejected key) get a message that says what to do about it, and are logged at `info` because they aren't defects:

```
:x: No alert found with ID `abc123` in `.alerts-security.alerts-*`.
:x: Building statistics: Elastic rejected your API key (403). Re-run `/start`...
:x: `banana` isn't a window I understand — try `24h`, `7d` or `2w`.
```

For commands with a usage string, that string gets appended.

**Unexpected failures** get a trace reference instead of the real message, because the real message is often an internal hostname or a stack trace:

```
:x: Something went wrong on my end (ref `a1b2c3d4`). An admin can find the details in the logs.
```

That same `a1b2c3d4` is on every log line for that interaction, so a grepping to find where the error fired is easy.