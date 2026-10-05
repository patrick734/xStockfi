#!/usr/bin/env bash
# Dev-wallet governance transactions after launch (each sends at most one transaction per run):
#   ./govern.sh handoff         schedule the timelock handoff; run again after 48h to execute it
#   ./govern.sh register-pool   after the token graduates on Pons: register its pool so BuyBurn can buy and burn
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
. "$ROOT/tools/env.sh"
load_launch_env "$ROOT/launch.env"
export DEPLOYER_ACCOUNT="${DEPLOYER_ACCOUNT:-xstockfi-dev}"
[ -n "${ROBINHOOD_RPC_URL:-}" ] && export ROBINHOOD_RPC_URL
case "${1:-}" in
  handoff) S=scripts/handoff.js ;;
  register-pool) S=scripts/register-pool-send.js ;;
  *) sed -n 2,4p "$0"; exit 1 ;;
esac
cd "$ROOT/contracts" && npx hardhat run "$S" --network robinhood
