# Storage

Everything persistent is JSON on local disk under `data/`.

## The three storage files

| File | Class | Holds |
| --- | --- | --- |
| `data/users.json` | `UserStore` | Slack user ID → `{ kibanaUsername, apiKey }`, key encrypted |
| `data/state.json` | `StateStore` | watcher cursors - `alertsLastTs`, `casesLastTs` (per space) |
| `data/incidents.json` | `IncidentStore` | posted incidents, their cases, their claims |

Paths are overridable with `USER_STORE_PATH`, `STATE_PATH` and
`INCIDENT_STORE_PATH`.

Only `users.json` holds credentials. Losing `incidents.json` doesn't leak anything, but every open incident forgets its case and starts offering a **create case** button again. Losing `state.json` re-baselines the watchers to *now* and drops every alert between the loss and the restart.

All three stores extend `JsonFileStore`, which gives them:

**Atomic writes.** Write to a temp file, then rename. A crash mid-write leaves the previous contents intact rather than a truncated file, which matters a lot for `state.json`. A truncated one reads back as "no cursor", which silently re-baselines the watchers.

**Mode 0600**, and the parent directory is created if it doesn't exist.

**Write-through by default** (`debounceMs = 0`), so `set()` is synchronous from the caller's point of view. Debouncing is supported but not used: a registration that appeared to succeed has to survive an immediate crash, and a claim that isn't on disk when the process dies is a claim that never existed.

**Failure tolerance on read.** A missing file is normal (first boot) and logged at `debug`. A file that exists but won't parse is *not* normal: it's logged at `error` with a "restore from backup before restarting" remedy, and the store starts empty rather than crashing at boot.

A failed write is logged, not thrown, as to not crash the watcher loop.

`flush()` is called on shutdown to write anything pending.

## Encryption at rest

Analyst API keys are encrypted with AES-256-GCM before they touch disk (`src/util/crypto.js`). The key comes from `ELASTIBOT_SECRET_KEY`, derived with scrypt and a per-value random salt.

The envelope, base64 after an `enc:` prefix:

```
[1 byte version][16 byte salt][12 byte iv][16 byte gcm tag][ciphertext]
```

Some properties that follow from that:

- the same input encrypts differently every time (random IV)
- a wrong secret or a tampered blob fails the GCM auth tag rather than decrypting to garbage
- an encrypted value with no secret configured throws, naming the env var
- with no secret configured at all, values are stored **as-is** and the operator is warned at boot and the analyst is warned in their `/start` DM

scrypt derivation is 50–100ms, which is why decrypted records are cached rather than derived per request.

## Caching

Four caches, all TTL'd:

| Cache | TTL var | Why the TTL exists |
| --- | --- | --- |
| decrypted user records | `USER_CACHE_TTL_MS` (5m) | bounds how long a rotated key lingers in memory |
| per-analyst Elastic clients | `ELASTIC_CLIENT_TTL_MS` (15m) | bounds the window in which a revoked key still has a working client |
| space display names | `SPACE_NAME_TTL_MS` (1h) | spaces very rarely get renamed; an hour of renaming delay is a fine trade for one lookup per space per hour |
| — | `ELASTIC_MAX_CLIENTS` (250) | ceiling on the client cache |

`USER_CACHE_TTL_MS=0` is read as "don't cache" and floored to 1ms, not as "never expire". the underlying `TtlCache` reads `0` the other way round, and an operator setting zero means the opposite of what the cache does.

The space cache is keyed on space ID only, not on whose key asked, since the display name is a property of the space.

On shutdown, `ctx.close()` clears the decrypted-key cache and the space cache.

## Backups

Every store is write-through partly because of this: anything that copies `data/` out from under a live process captures whatever was last written.

If you restore a `state.json` older than what's actually been posted, you rewind the cursor onto alerts that are already in the channel. The `findByAlertId` filter in the alert watcher catches most of that (any alert already on a live incident record is dropped), but incidents that have since been reaped aren't protected, and they'll be posted again.

My Suggestion: Back up `users.json`, because losing it means every analyst has to re-run `/start`. The other two files are cheap to lose and expensive to restore wrong.