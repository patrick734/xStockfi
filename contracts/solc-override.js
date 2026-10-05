// Optional: use a local solc binary (LOCAL_SOLC=/path/to/solc-0.8.26) instead of downloading one.
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  if (process.env.LOCAL_SOLC && args.solcVersion === "0.8.26")
    return { compilerPath: process.env.LOCAL_SOLC, isSolcJs: false, version: args.solcVersion, longVersion: "0.8.26+commit.8a97fa7a" };
  return runSuper();
});
