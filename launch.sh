#!/usr/bin/env bash
# xStockFi launch: deploys every contract from one dev wallet and exports the addresses to the website.
# The dev wallet becomes the timelock's proposer and executor and the guardian. The keeper is a separate bot
# wallet, since it signs on its own from GitHub Actions.
#
#   ./launch.sh               real deploy to Robinhood Chain
#   ./launch.sh --rehearsal   the same on a local copy of the live chain; spends nothing
#
# The dev wallet signs from ~/.foundry/keystores/$DEPLOYER_ACCOUNT (default xstockfi-dev, made by
# `node tools/wallet.js create xstockfi-dev`), unlocked with ~/.foundry/xstockfi.pw. No key is typed or printed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
C="$ROOT/contracts"
REHEARSAL=0; FORCE=0
for a in "$@"; do case "$a" in --rehearsal) REHEARSAL=1 ;; --force) FORCE=1 ;; *) echo "unknown option $a"; exit 1 ;; esac; done
step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
stop() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1"; exit 1; }
mtime() { [ -f "$1" ] && { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; } || echo none; }

step "Settings"
for d in "$C" "$ROOT/keeper"; do [ -d "$d/node_modules" ] || (cd "$d" && npm install --no-audit --no-fund); done
. "$ROOT/tools/env.sh"
[ -f "$ROOT/launch.env" ] && { load_launch_env "$ROOT/launch.env"; echo "Loaded launch.env"; }
[[ "${KEEPER_ADDRESS:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || stop "KEEPER_ADDRESS is not set in launch.env (node tools/wallet.js keeper-secret patrick734/xStockfi prints it)."
[ -n "${ROBINHOOD_RPC_URL:-}" ] && export ROBINHOOD_RPC_URL
[ -z "${XSF_TOKEN_ADDRESS:-}" ] && echo "No XSF_TOKEN_ADDRESS: deploying before the token. After the Pons launch, run ./set-token.sh with its address."

export DEPLOYER_ACCOUNT="${DEPLOYER_ACCOUNT:-xstockfi-dev}"
KS="$HOME/.foundry/keystores/$DEPLOYER_ACCOUNT"
[ -f "$KS" ] || stop "No dev wallet keystore $KS. Create it with: node tools/wallet.js create $DEPLOYER_ACCOUNT"
DEV="$(node "$ROOT/tools/wallet.js" address "$DEPLOYER_ACCOUNT")" || stop "Could not unlock the dev wallet keystore."
export DEPLOYER_ADDRESS="$DEV"
lc() { echo "$1" | tr A-F a-f; }
for n in ADMIN_MULTISIG GUARDIAN_MULTISIG; do
  v="${!n:-}"; [ -z "$v" ] || [ "$(lc "$v")" = "$(lc "$DEV")" ] || stop "$n in launch.env is $v, not the dev wallet. Remove it from launch.env (one-wallet launch)."
done
export ADMIN_MULTISIG="$DEV" GUARDIAN_MULTISIG="$DEV"
echo "Dev wallet: $DEV (deployer, timelock proposer/executor, guardian)"
echo "Keeper:     $KEEPER_ADDRESS"
[ "$(lc "$KEEPER_ADDRESS")" != "$(lc "$DEV")" ] || stop "The keeper must be a separate wallet from the dev wallet."

OUT="$C/deployments/robinhood.json"
if [ $REHEARSAL = 0 ] && [ -f "$OUT" ] && [ $FORCE = 0 ]; then stop "contracts/deployments/robinhood.json exists: already deployed. Use --force only for a second deployment."; fi

cd "$C" || exit 1
step "Compiling"
npx hardhat compile 2>&1 | tail -1 || stop "Compile failed."
step "Refreshing live pool data"
node scripts/probe-pools.js | grep -E "TSLA|NVDA|AAPL|PLTR|META|chainId" || stop "Could not read the live pools. Check your connection (or set ROBINHOOD_RPC_URL) and run again."
step "Preflight checks"
node scripts/preflight.js || stop "Preflight failed. Fix the FAIL lines above and run again."

if [ $REHEARSAL = 1 ]; then
  step "Rehearsal: full deploy on a local copy of Robinhood Chain"
  FORK=1 DEPLOY_LIVE=1 LOCAL_SINGLE_WALLET=1 npx hardhat run scripts/deploy.js 2>&1 | grep -v '^\s\+at '
  [ "${PIPESTATUS[0]}" = 0 ] && [ -f "$C/deployments/fork.json" ] || stop "Rehearsal did not finish (usually a dropped RPC connection). Set ROBINHOOD_RPC_URL and run it again."
  rm -f "$C/deployments/fork.json"
  step "Rehearsal complete. Nothing was sent to Robinhood Chain."; exit 0
fi

printf '\n\033[33mThis deploys xStockFi to Robinhood Chain with real gas from %s.\033[0m\n' "$DEV"
read -r -p "Type DEPLOY to continue: " ans; [ "$ans" = "DEPLOY" ] || stop "Cancelled."

step "Deploying"
ok=0
for attempt in 1 2 3; do
  before="$(mtime "$OUT")"
  npx hardhat run scripts/deploy.js --network robinhood 2>&1 | grep -v '^\s\+at '
  status=${PIPESTATUS[0]}
  [ "$status" = 0 ] && [ "$(mtime "$OUT")" != "none" ] && [ "$(mtime "$OUT")" != "$before" ] && { ok=1; break; }
  # A half-finished attempt holds no funds and the site never lists it; a retry deploys a full fresh set.
  printf '\033[33mAttempt %s did not finish (usually a dropped connection to the Robinhood RPC).\033[0m\n' "$attempt"
  [ $attempt -lt 3 ] && sleep 10
done
[ $ok = 1 ] || stop "Deploy did not finish after 3 attempts. Try another connection or set ROBINHOOD_RPC_URL in launch.env, then run ./launch.sh again."

step "Exporting addresses to the website"
npm run export-abis || stop "Deployed, but exporting addresses failed. Run: (cd contracts && npm run export-abis)"
step "Deployed"
echo "Addresses: contracts/deployments/robinhood.json (the website reads web/src/generated/deployments.ts)"
echo "Next:"
echo "  1. Publish (Vercel rebuilds; the keeper starts dry runs): git add -A && git commit -m Deploy && git push"
echo "  2. Publish the source code: ./verify.sh"
echo "  3. Timelock handoff (run it again after 48h): ./govern.sh handoff"
echo "  4. Keeper live: set the GitHub repository variable KEEPER_LIVE=1"
