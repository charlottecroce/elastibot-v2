# Elastibot Documentation

Elastibot is a Slack bot (Node.js / Bolt) that lets security analysts turn Elastic alerts into Kibana cases without leaving Slack, and pushes new alerts and cases into the channels they're supposed to land in.

They're are two main components: the **watchers** poll Elastic on a timer and post what they find(alerts). The **commands** are what an analyst runs or clicks in response. They both use the incident store, which is the thing that keeps a Slack message and a Kibana case agreeing with each other.

!!! note
    Elastibot is still in active development. The concepts below are stable, but
    specific config keys, block layouts and internal function signatures still
    move around.

## Table of Contents

- [Getting Started](getting-started/install.md)
    * [Installation](getting-started/install.md)
    * [Elastic API Keys](getting-started/api-keys.md)
- [Using Elastibot](using/commands.md)
    * [Slash Commands](using/commands.md)
    * [Incident Messages](using/incident-messages.md)
- [How It Works](internals/architecture.md)
    * [Architecture](internals/architecture.md)
    * [The Watchers](internals/watchers.md)
    * [Alert Grouping](internals/grouping.md)
    * [Incidents](internals/incidents.md)
    * [Cases](internals/cases.md)
    * [Storage](internals/storage.md)
- [Reference](reference/configuration.md)
    * [Configuration](reference/configuration.md)
    * [Logging and Errors](reference/logging.md)
- [Developer Guide](developer-guide.md)

## Quick reference

| Command | What it does |
| --- | --- |
| `/start [kibana_username]` | Register your Elastic API key so cases are attributed to you |
| `/case <alertID>` | Create a case for an alert and attach it |
| `/add_alert <caseID> <alertID>` | Attach an alert to a case that already exists |
| `/stats [window] [filters] [share]` | Aggregate view of the alerts index |