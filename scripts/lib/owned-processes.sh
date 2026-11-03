# Stop only the processes a local stack started. Sourced, not run.
#
# A pid file holds the pid, its start time and its working directory
# (`record`). `owned` says a pid is still that process: alive, the same
# start time (a reused pid has another), and the same directory. Anything
# else is somebody else's process and is left alone.
#
#   record NAME PID DIR     write $LOG_DIR/NAME.pid
#   stop_recorded NAME DIR  stop it if it is still ours, drop the pid file
#   sweep_port PORT DIR     stop listeners on PORT that run from DIR
#
# LOG_DIR must be set. PORT_SWEEP=0 skips sweep_port; each lsof gets
# LSOF_TIMEOUT seconds (default 20), since lsof reads every process.

LSOF_TIMEOUT="${LSOF_TIMEOUT:-20}"
PORT_SWEEP="${PORT_SWEEP:-1}"

# Run a command for at most LSOF_TIMEOUT seconds.
bounded() {
  "$@" 2>/dev/null &
  local pid=$! watchdog rc
  (sleep "$LSOF_TIMEOUT"; kill "$pid" 2>/dev/null) >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$watchdog" 2>/dev/null || true
  return "$rc"
}

# When a process started; a reused pid has another start time.
proc_started() {
  { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; } || true
}

# A process's working directory, or nothing when it cannot be read.
proc_cwd() {
  if [ -e "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    { bounded lsof -b -w -a -p "$1" -d cwd -Fn | sed -n 's/^n//p' | head -n 1; } || true
  fi
}

# Physical path, so /tmp and /private/tmp (macOS) compare equal.
real_dir() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
}

record() {
  printf '%s\t%s\t%s\n' "$2" "$(proc_started "$2")" "$(real_dir "$3")" >"$LOG_DIR/$1.pid"
}

owned() {
  local pid="$1" started="$2" dir="$3" cwd
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ -n "$started" ] && [ "$(proc_started "$pid")" = "$started" ] || return 1
  cwd="$(proc_cwd "$pid")"
  [ -z "$cwd" ] || [ "$(real_dir "$cwd")" = "$dir" ]
}

descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    descendants "$child"
    echo "$child"
  done
}

kill_tree() {
  local pids
  pids="$(descendants "$1") $1"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}

stop_recorded() {
  local name="$1" want pid started dir
  want="$(real_dir "$2")"
  [ -f "$LOG_DIR/$name.pid" ] || return 0
  IFS=$'\t' read -r pid started dir <"$LOG_DIR/$name.pid" || true
  if [ "$dir" = "$want" ] && owned "$pid" "$started" "$dir"; then
    kill_tree "$pid"
  elif [ -n "$pid" ]; then
    echo "$name: pid $pid is not the process this stack started; left alone" >&2
  fi
  rm -f "$LOG_DIR/$name.pid"
}

sweep_port() {
  local port="$1" want listener cwd
  want="$(real_dir "$2")"
  [ "$PORT_SWEEP" = "1" ] && command -v lsof >/dev/null 2>&1 || return 0
  for listener in $(bounded lsof -b -w -nP -tiTCP:"$port" -sTCP:LISTEN || true); do
    cwd="$(proc_cwd "$listener")"
    if [ -n "$cwd" ] && [ "$(real_dir "$cwd")" = "$want" ]; then
      kill_tree "$listener"
    else
      echo "port $port: pid $listener is not from this stack; left alone" >&2
    fi
  done
}
