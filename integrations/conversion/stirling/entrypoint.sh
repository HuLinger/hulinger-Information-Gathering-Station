#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -eq 0 ]]; then
  echo "Missing Stirling process command." >&2
  exit 64
fi
if [[ ! "${UNO_CONVERSION_TIMEOUT_SECONDS:-120}" =~ ^[1-9][0-9]{0,4}$ ]]; then
  echo "UNO_CONVERSION_TIMEOUT_SECONDS must be a positive integer below 100000." >&2
  exit 64
fi

mkdir -p /tmp/stirling-pdf/uno-profile /tmp/stirling-pdf/xdg \
  /tmp/stirling-pdf/cache /tmp/stirling-pdf/config
uno_pid=""
java_pid=""
cleanup() {
  trap - EXIT TERM INT HUP
  if [[ -n "$java_pid" ]]; then kill -TERM "$java_pid" 2>/dev/null || true; fi
  if [[ -n "$uno_pid" ]]; then kill -TERM "$uno_pid" 2>/dev/null || true; fi
  if [[ -n "$java_pid" ]]; then wait "$java_pid" 2>/dev/null || true; fi
  if [[ -n "$uno_pid" ]]; then wait "$uno_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT

# LibreOffice cannot unlink its IPC sockets inside the sandbox. Only remove a
# socket when the kernel confirms it has no listener in this container.
clear_stale_pipes() {
  local socket_path
  [[ -r /proc/net/unix ]] || return 1
  for socket_path in /tmp/OSL_PIPE_*; do
    [[ -S "$socket_path" ]] || continue
    if ! grep -qF " $socket_path" /proc/net/unix; then
      rm -f -- "$socket_path"
    fi
  done
}
/usr/local/lib/stirling/lo-sandbox --stirling-sandbox-check
clear_stale_pipes

# Initialize an empty profile before accepting documents. The first startup can
# exit after creating it because of LibreOffice's sandboxed IPC relaunch.
if [[ ! -d /tmp/stirling-pdf/uno-profile/user ]]; then
  timeout 60 /usr/bin/soffice --headless --norestore --terminate_after_init \
    -env:UserInstallation=file:///tmp/stirling-pdf/uno-profile || true
  if [[ ! -d /tmp/stirling-pdf/uno-profile/user ]]; then
    echo "LibreOffice could not initialize its isolated profile." >&2
    exit 1
  fi
  clear_stale_pipes
fi

# Both listeners stay on container loopback. The base image retains upstream's
# LibreOffice sandbox and patched pipe transport; no upstream app init is run.
/opt/venv/bin/unoserver \
  --interface 127.0.0.1 --port 2003 \
  --uno-interface 127.0.0.1 --uno-port 2002 \
  --executable /usr/bin/soffice \
  --user-installation /tmp/stirling-pdf/uno-profile \
  --temp-dir /tmp/stirling-pdf \
  --conversion-timeout "${UNO_CONVERSION_TIMEOUT_SECONDS:-120}" \
  --quiet &
uno_pid=$!

ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if ! kill -0 "$uno_pid" 2>/dev/null; then
    echo "LibreOffice conversion process exited during startup." >&2
    exit 1
  fi
  if timeout 2 /opt/venv/bin/unoping --host 127.0.0.1 --port 2003 --quiet >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "LibreOffice conversion process did not become ready." >&2
  exit 1
fi

"$@" &
java_pid=$!

# A failed UNO server must not leave a superficially healthy PDF-only container.
# The Compose restart policy can recreate both processes together.
set +e
wait -n "$java_pid" "$uno_pid"
result=$?
set -e
echo "A conversion process exited; stopping the engine." >&2
if [[ "$result" -eq 0 ]]; then result=1; fi
exit "$result"
