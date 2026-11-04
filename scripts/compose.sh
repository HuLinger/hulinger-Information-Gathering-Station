#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/compose.sh"
hub_compose_init
exec "${compose[@]}" "$@"
