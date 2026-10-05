#!/usr/bin/env bash
# Publishes the source code of every deployed xStockFi contract on the Robinhood Chain explorer
# (robinhoodchain.blockscout.com), so anyone can read it and each contract shows its name and a verified check.
# Read-only: no wallet is unlocked, no key is used, no gas is spent. Safe to run again: verified contracts are skipped.
#   ./verify.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
stop() { printf '\n\033[31mSTOPPED: %s\033[0m\n' "$1"; exit 1; }
. "$ROOT/tools/env.sh"
load_launch_env "$ROOT/launch.env"
[ -n "${ROBINHOOD_RPC_URL:-}" ] && export ROBINHOOD_RPC_URL
[ -f "$ROOT/contracts/deployments/robinhood.json" ] || stop "No contracts/deployments/robinhood.json. Run this in the folder you deployed from."
[ -d "$ROOT/contracts/node_modules" ] || (cd "$ROOT/contracts" && npm install --no-audit --no-fund)

run() { (cd "$ROOT/contracts" && npx hardhat run scripts/verify.js --network explorer); }
run; s=$?

if [ $s = 3 ] && [ -z "${VERIFY_API_KEY:-}" ]; then
  printf '\n\033[33mSome contracts did not verify on Sourcify, and the explorer blocks scripts. Blockscout'"'"'s developer API may get through:\033[0m\n'
  echo "  1. Open https://dev.blockscout.com and sign in (any email)."
  echo "  2. Create an API key (free)."
  read -rs -p "  3. Paste the key here (hidden), or press Enter to skip: " VERIFY_API_KEY; echo
  if [ -n "$VERIFY_API_KEY" ]; then export VERIFY_API_KEY; run; s=$?; fi
fi

if [ $s = 0 ]; then
  printf '\n\033[32mDone. Open the links above to see the verified contracts.\033[0m\n'
elif [ -f "$ROOT/verify-files/README.txt" ]; then
  printf '\n\033[33mNot all contracts are verified yet. Run ./verify.sh again in a few minutes, or verify the rest in the\n'
  printf 'browser with the files in verify-files/ (steps in verify-files/README.txt).\033[0m\n'
  exit 1
else
  exit 1
fi
