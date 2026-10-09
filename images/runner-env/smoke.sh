#!/usr/bin/env bash
# Smoke test of one runner-env image, run the way the hosted pod runs it:
# uid 1000, read-only root, no capabilities, no privilege escalation, /tmp
# and /workspace the only writable places, HOME=/workspace/.home.
#
#   images/runner-env/smoke.sh <image> <flavour>
#
# CI (.github/workflows/runner-env-images.yml) runs it after each build;
# run it locally after `docker build` the same way.

# The single-quoted scripts below are meant to expand inside the container.
# shellcheck disable=SC2016
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image> <flavour>}"
FLAVOUR="${2:?usage: smoke.sh <image> <flavour>}"

pod() {
  docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /tmp --tmpfs /workspace:uid=1000,gid=1000 \
    -e HOME=/workspace/.home "$@"
}

echo "== $IMAGE ($FLAVOUR)"
test "$(docker run --rm "$IMAGE" id -u)" = 1000
docker run --rm "$IMAGE" almyty-runner --help | grep -q -- '--enroll'

# Without an API it must fail enrollment and exit 1, which is what makes
# Kubernetes restart it.
set +e
pod -e ALMYTY_API_URL=http://localhost:9 -e ALMYTY_ENROLLMENT_TOKEN=not-a-real-token "$IMAGE"
code=$?
set -e
if [ "$code" -ne 1 ]; then
  echo "expected enrollment to fail with exit 1, got $code"
  exit 1
fi

case "$FLAVOUR" in
  standard|standard-browser)
    # Every coding CLI starts as uid 1000 on a read-only root, and the
    # entrypoint points them at the runner's loopback model proxy, with a
    # placeholder key, when the pod carries a model token and a proxy port.
    pod -e ALMYTY_API_URL=https://api.example.test -e ALMYTY_MODEL_TOKEN=not-a-real-model-token -e ALMYTY_MODEL_PROXY_PORT=4319 \
      "$IMAGE" bash -euo pipefail -c '
        claude --version
        codex --version
        gemini --version
        aider --version
        test "$ANTHROPIC_BASE_URL" = http://127.0.0.1:4319
        test "$ANTHROPIC_AUTH_TOKEN" = almyty-pod-local
        test -z "${ANTHROPIC_API_KEY:-}"
        test "$OPENAI_BASE_URL" = http://127.0.0.1:4319/v1
        test "$OPENAI_API_KEY" = almyty-pod-local
        test "$AIDER_OPENAI_API_BASE" = http://127.0.0.1:4319/v1
        test "$AIDER_ANTHROPIC_API_KEY" = almyty-pod-local
        grep -qxF "base_url = \"http://127.0.0.1:4319/v1\"" "$HOME/.codex/config.toml"
        test -f "$HOME/.claude.json"
      '
    # Without a proxy port (an older backend) they get the token directly.
    pod -e ALMYTY_API_URL=https://api.example.test -e ALMYTY_MODEL_TOKEN=not-a-real-model-token \
      "$IMAGE" bash -euo pipefail -c '
        test "$ANTHROPIC_BASE_URL" = https://api.example.test
        test "$ANTHROPIC_AUTH_TOKEN" = not-a-real-model-token
        test "$OPENAI_BASE_URL" = https://api.example.test/v1
        test "$OPENAI_API_KEY" = not-a-real-model-token
        grep -qxF "base_url = \"https://api.example.test/v1\"" "$HOME/.codex/config.toml"
      '
    # Without a model token nothing is set for them, and a family the pod
    # configured itself is left alone.
    pod "$IMAGE" bash -euo pipefail -c 'test -z "${ANTHROPIC_BASE_URL:-}${OPENAI_BASE_URL:-}${OPENAI_API_KEY:-}"'
    pod -e ALMYTY_API_URL=https://api.example.test -e ALMYTY_MODEL_TOKEN=not-a-real-model-token \
      -e OPENAI_API_KEY=not-a-real-vendor-key "$IMAGE" bash -euo pipefail -c '
        test -z "${OPENAI_BASE_URL:-}"
        test "$OPENAI_API_KEY" = not-a-real-vendor-key
        test ! -e "$HOME/.codex/config.toml"
        test "$ANTHROPIC_BASE_URL" = https://api.example.test
      '
    # The runner itself finds all four, inside its probe timeout.
    pod "$IMAGE" node --input-type=module -e '
      const { detectRuntimeInfo } = await import("/usr/local/lib/node_modules/@almyty/runner/dist/runtime-info.js");
      const { DEFAULT_BINARY_PROBE_LIST } = await import("/usr/local/lib/node_modules/@almyty/runner/dist/config.js");
      const info = await detectRuntimeInfo({ binaries: DEFAULT_BINARY_PROBE_LIST });
      const found = info.codingAgents.map((a) => a.id);
      const missing = ["claude", "codex", "gemini", "aider"].filter((id) => !found.includes(id));
      if (missing.length) { console.error("runner does not detect: " + missing.join(", ")); process.exit(1); }
      console.log("runner detects: " + found.join(", "));
    '
    ;;
esac

if [ "$FLAVOUR" = standard-browser ]; then
  # Headless Chromium through the global Playwright, with no project
  # install, under the same restrictions.
  pod "$IMAGE" node -e '
    const { chromium } = require("playwright");
    (async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>runner-env</title>");
      const title = await page.title();
      await browser.close();
      if (title !== "runner-env") throw new Error("unexpected title " + title);
      console.log("chromium ok");
    })().catch((e) => { console.error(e); process.exit(1); });
  '
fi

echo "== $IMAGE ($FLAVOUR) ok"
