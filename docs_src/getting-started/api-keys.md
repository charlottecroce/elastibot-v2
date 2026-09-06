# Elastic API Keys

## Why every analyst needs their own

Elastibot never acts as a single shared identity when it's doing something on an analyst's behalf. `/case`, `/add_alert`, `/stats` and both incident buttons all run under the API key of whoever ran the command, so the case in Kibana is attributed to that person and not to a bot account nobody can be held to.

That's the whole reason `/start` exists. A command with `requireUser` set will refuse to do anything until you've registered:

> You need to connect first. Run `/start <kibana_username>` to register your
> Elastic API key.

The watchers are not acting for anyone, so they use the service key from `ELASTIC_SERVICE_API_KEY`.

## Creating a key by hand

In Kibana Dev Tools:

```
POST /_security/api_key
{
  "name": "elastibot-charlotte.croce"
}
```

Copy the `encoded` value out of the response - that base64 blob is what you paste into `/start`, not the `id` and not the `api_key` on their own.

Then set the key's permissions under **Stack Management → Security → API Keys**. The JSON to use is in the [`api_permissions/`](https://github.com/charlottecroce/elastibot-v2/tree/main/api_permissions) directory:

| File | For | Grants |
| --- | --- | --- |
| `elastibot_analyst.json` | analysts | read + write on the security alerts indices, `feature_securitySolutionCases.all`, `feature_siem.read` |
| `elastibot_service.json` | the watchers | read-only on the alerts indices, `feature_securitySolutionCases.read` |

The analyst descriptor needs `write` on the alerts indices because attaching an alert to a case updates the alert document (the case ids and the workflow status). Read alone will attach nothing.

**Note:** You can also define permissions directly into the the `POST /_security/api_key` request. A template can be found in the [`api_permissions/`](https://github.com/charlottecroce/elastibot-v2/tree/main/api_permissions) directory.

## Letting Elastibot create an API key

`/start` can also call `POST /_security/api_key` itself, so an analyst never has to touch Dev Tools. Pick "create one for me" in the modal, paste an admin username and password, and Elastibot creates a key named `elastibot-<username>`, scoped with the exact same `api_permissions/elastibot_analyst.json` role descriptor an admin would have pasted by hand.

The admin credential authenticates over HTTP Basic for that one request and is never stored, cached, or logged. It doesn't go into the client cache, which only ever holds API-key-authenticated clients.

This option is off by default. `AUTO_PROVISION_SLACK_IDS` is a comma-separated list of Slack user IDs allowed to see it. Note that this is Slack-side gating only. Elasticsearch separately and always enforces that whatever credential gets pasted actually holds `manage_api_key` or `manage_own_api_key`. A credential without it is rejected no matter what the allowlist says.

Because provisioning is a network round trip and Slack times out a view submission after a few seconds, the modal acks closed immediately and the result comes back as a DM.

## The service key

`ELASTIC_SERVICE_API_KEY` is used for the alert and case polls and for space-name lookups. Give it `elastibot_service.json` - read-only. It never creates a case and never attaches an alert, so it doesn't need to be able to.

If it isn't set, the watchers log a warning and don't start. Everything else still works, you just don't get channel notifications.

## Rotating and revoking

Re-running `/start` overwrites the stored key and invalidates the cached Elastic client built from the old one. Without that invalidation a revoked key would keep working until `ELASTIC_CLIENT_TTL_MS` expired it (15 minutes by default).

Revoking a key in Kibana doesn't notify the bot. The analyst's next command fails with a 401/403, which Elastibot translates into "Elastic rejected your API key — re-run `/start`".