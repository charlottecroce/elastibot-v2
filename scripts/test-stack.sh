#!/usr/bin/env bash
#
# Bring up (or reuse) the Elasticsearch stack the integration tests run against.
#
#   scripts/test-stack.sh up [--no-kibana]
#   scripts/test-stack.sh down            stop containers, KEEP the data volume
#   scripts/test-stack.sh reset           destroy the volumes and start clean
#   scripts/test-stack.sh status
#   scripts/test-stack.sh env             print the exports the tests read
#
# `up` is the important command. It starts the stack if it isn't already running.
# Pass --no-kibana for the lighter Elasticsearch-only stack. If the requested
# stack is already answering, `up` prints one line and exits, it does NOT
# restart anything. A cold start is around 40s for Elasticsearch and another
# minute for Kibana; a warm one is instant. Running the integration suite in a
# loop should only ever pay that once.
#
# The corollary is that the stack outlives your test run on purpose. `down`
# when you're finished with it, `reset` when you want to be sure nothing is
# left over from a previous version.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE_FILE=docker-compose.test.yml
PROJECT=elastibot-test

log()  { printf '\033[36m[stack]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[stack]\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# .env.test is optional - somewhere to pin ELASTIC_STACK_VERSION (or a port)
# without exporting it in every shell. Sourced FIRST so that node sees it:
# previously it was read after the ports had already been resolved, which meant
# setting a port in .env.test silently did nothing.
[ -f .env.test ] && set -a && . ./.env.test && set +a

# Ports, password and stack version come from tests/testenv.js, which is also
# what the integration suite reads
#
# docker-compose.test.yml picks these up from the environment exported below;
# the `:-9201` style fallbacks it carries are a backstop for running compose
# directly, without this script.
#
# testenv.js honours the same ELASTIC_TEST_* overrides, so exporting
# ELASTIC_TEST_ES_PORT=9301 still works and now reaches the script and the
# suite from a single read.
command -v node >/dev/null 2>&1 \
  || die "node is not installed or not on PATH (needed to read tests/testenv.js)"

eval "$(node -e '
  const t = require("./tests/testenv");
  const out = {
    ES_PORT: t.stack.esPort,
    KIBANA_PORT: t.stack.kibanaPort,
    PASSWORD: t.stack.password,
    VERSION: t.stack.stackVersion,
    ES_URL: t.stack.esUrl,
    KIBANA_URL: t.stack.kibanaUrl,
  };
  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}=${JSON.stringify(String(v))}`);
  }
')"

export ELASTIC_STACK_VERSION="$VERSION"
export ELASTIC_TEST_ES_PORT="$ES_PORT"
export ELASTIC_TEST_KIBANA_PORT="$KIBANA_PORT"
export ELASTIC_TEST_PASSWORD="$PASSWORD"

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
docker compose version >/dev/null 2>&1 \
  || die "docker compose v2 is required (this uses profiles and --wait)"

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

es_healthy() {
  curl -sf -u "elastic:${PASSWORD}" \
    "${ES_URL}/_cluster/health?wait_for_status=yellow&timeout=3s" >/dev/null 2>&1
}

kibana_healthy() {
  curl -sf "${KIBANA_URL}/api/status" 2>/dev/null | grep -q '"level":"available"'
}

# Guard against reusing something that isn't ours. A stack on the default
# ports that we didn't start is a development cluster, and wiping indices in
# it would be a genuinely bad afternoon
is_ours() {
  local running
  running="$(compose ps --quiet 2>/dev/null | wc -l | tr -d ' ')"
  [ "$running" != "0" ]
}

cmd_up() {
  local with_kibana=1
  for arg in "$@"; do
    case "$arg" in
      --with-kibana) with_kibana=1 ;; # kept for backwards compatibility; it's the default now
      --no-kibana)   with_kibana=0 ;;
      *) die "unknown option: $arg" ;;
    esac
  done

  if es_healthy && ! is_ours; then
    die "something is already listening on ${ES_URL} and it isn't this stack.
     Either stop it, or set ELASTIC_TEST_ES_PORT to a free port."
  fi

  if es_healthy && { [ "$with_kibana" = "0" ] || kibana_healthy; }; then
    log "reusing the stack already running on ${ES_URL} (Elastic ${VERSION})"
    cmd_env
    return 0
  fi

  if [ "$with_kibana" = "1" ]; then
    log "starting Elasticsearch + Kibana ${VERSION} (cold start takes a minute or two)"
    compose --profile kibana up -d --wait
  else
    log "starting Elasticsearch ${VERSION}"
    compose up -d --wait elasticsearch
  fi

  es_healthy || die "Elasticsearch came up but isn't answering on ${ES_URL}"
  log "ready"
  cmd_env
}

cmd_down() {
  log "stopping (data volumes kept - use \`reset\` to destroy them)"
  compose --profile kibana down --remove-orphans
}

cmd_reset() {
  log "destroying containers AND volumes"
  compose --profile kibana down --remove-orphans --volumes
  cmd_up "$@"
}

cmd_status() {
  compose --profile kibana ps || true
  printf '\n'
  if es_healthy; then
    log "elasticsearch: healthy at ${ES_URL}"
    curl -sf -u "elastic:${PASSWORD}" "${ES_URL}" \
      | grep -o '"number"[^,]*' | head -1 >&2 || true
  else
    log "elasticsearch: not answering at ${ES_URL}"
  fi
  if kibana_healthy; then
    log "kibana: healthy at ${KIBANA_URL}"
  else
    log "kibana: not answering at ${KIBANA_URL} (expected only if the stack was started with --no-kibana)"
  fi
}

# Printed to stdout, not stderr, so `eval "$(scripts/test-stack.sh env)"` works
cmd_env() {
  echo "export ELASTIC_TEST_ES_URL=${ES_URL}"
  echo "export ELASTIC_TEST_PASSWORD=${PASSWORD}"
  if kibana_healthy; then
    echo "export ELASTIC_TEST_KIBANA_URL=${KIBANA_URL}"
  fi
}

case "${1:-up}" in
  up)     shift || true; cmd_up "$@" ;;
  down)   cmd_down ;;
  reset)  shift || true; cmd_reset "$@" ;;
  status) cmd_status ;;
  env)    cmd_env ;;
  *)      die "usage: $0 {up [--no-kibana]|down|reset [--no-kibana]|status|env}" ;;
esac