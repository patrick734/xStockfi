# Loads launch.env (addresses and options only). Sourced by launch.sh, govern.sh, set-token.sh and verify.sh.
# Accepts KEY=value, KEY = value, export KEY=value, quotes, inline # comments, CRLF, and a last line without newline.
load_launch_env() {
  local file="$1" line k v
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d '\r')"
    line="${line#"${line%%[![:space:]]*}"}"; line="${line#export }"
    case "$line" in *=*) ;; *) continue ;; esac
    k="$(printf '%s' "${line%%=*}" | tr -d '[:space:]')"; v="${line#*=}"
    v="$(printf '%s' "$v" | tr -d '[:space:]"'"'"'')"
    case "$k" in ''|*[!A-Z0-9_]*) echo "launch.env: ignoring line with key '$k'" >&2; continue ;; esac
    [ -n "$v" ] && export "$k=$v"
  done < "$file"
  return 0
}
