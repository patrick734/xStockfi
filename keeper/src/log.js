// Structured console logging. One line per event.
//   default:    2026-09-28T16:41:23.000Z INFO  [harvest] META harvested tx=0x.. gasUsed=123
//   LOG_JSON=1: {"ts":"...","level":"info","duty":"harvest","target":"META","msg":"harvested",...}
// Never pass secrets in `fields`; values are printed as-is.

const JSON_MODE = process.env.LOG_JSON === "1";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;

function fmt(v) {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
}

function emit(level, duty, target, msg, fields = {}) {
  if (LEVELS[level] < MIN) return;
  const ts = new Date().toISOString();
  const out = console.log; // one stream keeps ordering intact under process managers
  if (JSON_MODE) {
    out(JSON.stringify({ ts, level, duty, target, msg, ...fields }, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
    return;
  }
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(" ");
  out(`${ts} ${level.toUpperCase().padEnd(5)} [${duty}]${target ? " " + target : ""} ${msg}${kv ? " " + kv : ""}`);
}

function logger(duty, target) {
  return {
    debug: (msg, f) => emit("debug", duty, target, msg, f),
    info: (msg, f) => emit("info", duty, target, msg, f),
    warn: (msg, f) => emit("warn", duty, target, msg, f),
    error: (msg, f) => emit("error", duty, target, msg, f),
  };
}

module.exports = { logger };
