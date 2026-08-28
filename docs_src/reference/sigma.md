# Sigma

Two halves that never run at the same time.

**`npm run update-sigmaDB`** builds a local database of every Sigma rule, already converted to the Elasticsearch detection-rule format. It clones a repo, builds a Python virtualenv and runs for minutes.

**`/sigma`** reads that database and reconciles it against a Kibana space. It never converts anything and never touches the network beyond Elastic.

## Building the database

Once, per host:

```bash
npm run sigma:setup      # prisma generate + create the sqlite file
```

Then whenever you want the rules refreshed:

```bash
npm run update-sigmaDB
```

What it does, in order:

1. Shallow-clones `SIGMA_REPO_URL` to `data/sigma-repo`, or fast-forwards it if it's already there.
2. Creates `data/sigvenv` and installs `sigma-cli` plus the backend plugin, unless it exists.
3. Reads every `.yml` under `SIGMA_RULE_DIRS` and indexes them by Sigma id.
4. Converts them with `sigma convert -t lucene -p ecs_windows -f siem_rule_ndjson`, in batches.
5. Inserts one row per rule into `data/sigma.db`, and deletes rows for rules that are no longer upstream.

Requires `git`, `python3` with `venv`, and network access to GitHub and PyPI.

## `/sigma update`

Compares every detection rule in one space against the database and lists the ones that have drifted, ten to a page, each with an **Update rule** button.

A rule is skipped when:

- it has no `rule_id` field. NOT `id`: every rule has one of those. Only Sigma-derived rules carry a `rule_id` we can match on.
- its `rule_id` isn't in the database. That's what keeps Elastic's prebuilt rules and anything hand-written out of the way, without needing to recognise them individually.
- it's Elastic-managed (`immutable`). Those are listed so you know they're there, but Kibana won't patch them.

### What an update changes

Taken from Sigma:

`name`, `description`, `query`, `language`, `severity`, `risk_score`, `references`, `false_positives`, `threat`, `author`, `license`, `note`

Left exactly as it was:

index patterns, data views, exceptions, custom highlighted fields (`investigation_fields`), the schedule (`interval`, `from`, `to`), `max_signals`, enabled state, actions, throttling, filters and timelines.

Tags are **merged**.

## `/sigma search <keyword>`

Keyword match over rule titles and descriptions in the database, paged the same way. Each result gets one of:

| | |
| --- | --- |
| **Add rule** | the space doesn't have it |
| **Update rule** | it's there and has drifted |
| **View rule** | it's there and is up to date |

Added rules are created **disabled** by default (`SIGMA_ENABLE_NEW_RULES`). A freshly converted rule has never run against your data and its index patterns are whatever the pipeline guessed.

## Choosing a space

Neither subcommand does anything until it knows which space it's working in. Pass `space:<id>` and it goes straight there; leave it off and the first reply is a row of buttons, one per space your API key can see.

There's no default. Both paths write detection rules, and writing them into whichever space happened to be configured is a bad idea.

## Paging

Results are held in memory for `SIGMA_SESSION_TTL_MS` (15 minutes) and the Back/Next buttons carry a token into that cache. A restart drops every open pager.

Recomputing on each click was the alternative, and for `/sigma update` that means re-sweeping every rule in the space per page turn.

## Settings
 
The whole `sigma:` block in `elastibot.yml` is optional; delete it and every default below applies. As everywhere else, the file wins over the environment variable.
 
| Key | Env | Default | |
| --- | --- | --- | --- |
| `sigma.repo_url` | `SIGMA_REPO_URL` | SigmaHQ/sigma | |
| `sigma.repo_ref` | `SIGMA_REPO_REF` | `master` | |
| `sigma.repo_path` | `SIGMA_REPO_PATH` | `./data/sigma-repo` | shallow clone |
| `sigma.rule_dirs` | `SIGMA_RULE_DIRS` | `rules`, `rules-emerging-threats`, `rules-threat-hunting` | drop the last two if they're noise |
| `sigma.venv_path` | `SIGMA_VENV_PATH` | `./data/sigvenv` | |
| `sigma.python` | `SIGMA_PYTHON` | `python3` | |
| `sigma.backend` | `SIGMA_BACKEND` | `lucene` | must match your data |
| `sigma.pipeline` | `SIGMA_PIPELINE` | `ecs_windows` | must match your data |
| `sigma.format` | `SIGMA_FORMAT` | `siem_rule_ndjson` | |
| `sigma.convert_batch` | `SIGMA_CONVERT_BATCH` | `200` | speed only — a bad batch is retried per file |
| `sigma.command_timeout_ms` | `SIGMA_COMMAND_TIMEOUT_MS` | `900000` | any one git/pip/sigma/prisma call |
| `sigma.database_url` | `SIGMA_DATABASE_URL` | `file:<cwd>/data/sigma.db` | make it absolute if you set it |
| `sigma.page_size` | `SIGMA_PAGE_SIZE` | `10` | above ~20 a message stops rendering |
| `sigma.session_ttl_ms` | `SIGMA_SESSION_TTL_MS` | `900000` | how long Back/Next keep working |
| `sigma.max_sessions` | `SIGMA_MAX_SESSIONS` | `200` | |
| `sigma.max_search_results` | `SIGMA_MAX_SEARCH_RESULTS` | `200` | |
| `sigma.stack_page_size` | `SIGMA_STACK_PAGE_SIZE` | `100` | `_find` page size |
| `sigma.max_stack_rules` | `SIGMA_MAX_STACK_RULES` | `5000` | circuit breaker on the `/sigma update` sweep |
| `sigma.enable_new_rules` | `SIGMA_ENABLE_NEW_RULES` | `false` | |
 
## Troubleshooting

**"The Sigma database is not set up yet"**: `npm run sigma:setup`, then `npm run update-sigmaDB`.

**Everything reports as drifted**: the backend or pipeline doesn't match the data the rules were written against. Check `SIGMA_PIPELINE`; `ecs_windows` rules compared against Linux logs will differ on `query` forever.

**Lots of conversion failures**: usually a missing backend plugin. Delete `data/sigvenv` and re-run to rebuild it.