#!/usr/bin/env bash
# Plugs the xStockFi token into the live deployment after launching it on Pons. One transaction from the dev wallet,
# permanent.
#   ./set-token.sh 0x<token address from Pons>
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
stop() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1"; exit 1; }
[ -f "$ROOT/contracts/deployments/robinhood.json" ] || stop "No live deployment (contracts/deployments/robinhood.json). Run ./launch.sh first."
TOKEN="${1:-}"
[[ "$TOKEN" =~ ^0x[0-9a-fA-F]{40}$ ]] || stop "Usage: ./set-token.sh 0x<token address>"
. "$ROOT/tools/env.sh"
load_launch_env "$ROOT/launch.env"
[ -n "${ROBINHOOD_RPC_URL:-}" ] && export ROBINHOOD_RPC_URL
export DEPLOYER_ACCOUNT="${DEPLOYER_ACCOUNT:-xstockfi-dev}" XSF_TOKEN_ADDRESS="$TOKEN"
DEV="$(node "$ROOT/tools/wallet.js" address "$DEPLOYER_ACCOUNT")" || stop "Could not unlock the dev wallet keystore."
printf '\n\033[33mThis permanently sets the token to %s (from the dev wallet %s). It can never be changed.\033[0m\n' "$TOKEN" "$DEV"
read -r -p "Type SET to continue: " ans; [ "$ans" = "SET" ] || stop "Cancelled."
cd "$ROOT/contracts" || exit 1
ok=0
for attempt in 1 2 3; do
  npx hardhat run scripts/set-token.js --network robinhood 2>&1 | grep -v '^\s\+at '
  [ "${PIPESTATUS[0]}" = 0 ] && { ok=1; break; }
  [ $attempt -lt 3 ] && { echo "Attempt $attempt failed; retrying (usually a dropped RPC connection)."; sleep 8; }
done
[ $ok = 1 ] || stop "Could not set the token. Read the message above; nothing was changed if it says so."
npm run export-abis | tail -1
printf '\n\033[32mThe token is set. The site picks it up from web/src/generated: git add -A && git commit -m "Set token" && git push\033[0m\n'
