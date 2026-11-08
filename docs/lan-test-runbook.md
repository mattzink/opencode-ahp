# LAN two-machine test runbook (Phase 0)

Goal: VS Code Agents window on **PC B** → `opencode-ahp` host on **PC A** over
plain `ws://` on the LAN. Verifies the last Phase 0 box (plan §11) and E2E
item 10 (plan §9.4): token + Origin handling end-to-end with a real
browser-class client.

Nothing is installed on PC B — VS Code ships the AHP client.

## Preconditions

- PC A (this machine): opencode v2.2.6, repo at `/home/mattzink/opencode-ahp`.
- PC B: VS Code 1.145.2, same LAN, reachable from PC A.
- The daily `:80` service is **not touched** — the test runs a separate
  isolated server.

## PC A — host side

### 1. Start the test server

Isolated XDG homes (so the user's real opencode state and the `:80` service
registration are untouched), bound to all interfaces:

```sh
mkdir -p /tmp/opencode/ahp-lan/{data,state,cache}
cd /tmp/opencode/ahp-scratch/project-lan
env XDG_DATA_HOME=/tmp/opencode/ahp-lan/data \
    XDG_STATE_HOME=/tmp/opencode/ahp-lan/state \
    XDG_CACHE_HOME=/tmp/opencode/ahp-lan/cache \
    opencode serve --hostname 0.0.0.0 --port 4098
```

Keep this terminal open. Expected stdout:

```
server listening on http://0.0.0.0:4098
server password <PASSWORD>          ← only when OPENCODE_SERVER_PASSWORD is NOT set
[opencode-ahp] AHP 1.0.0 host listening on ws://0.0.0.0:8767/ahp (token from options; health /healthz)
```

Notes:

- `<PASSWORD>` is the Basic-auth password for the opencode HTTP API. It is
  printed once when `OPENCODE_SERVER_PASSWORD` is not in the environment; if
  it *is* set, that value is used silently instead.
- The AHP token is fixed in
  `/tmp/opencode/ahp-scratch/project-lan/.opencode/opencode.jsonc`
  (`options.token`), so no token line is printed for it. R4 requires an
  explicit token for a non-loopback bind.
- `allowedOrigins: "*"` in the same file — test mode; production setups should
  list exact VS Code Origins.
- **No `experimental.location_idle_timeout` entry** — not needed. The plugin's
  keep-alive (on by default; plan §15) periodically touches an internal
  anchor session, which opencode counts as location activity, so the idle
  eviction (60-minute default) never fires. (Before keep-alive, the flag was
  required — AHP WebSocket connections do not count as location activity;
  plan §14.8.)

### 2. Boot the location

A location (and its plugins) only boots when a client opens it or the API is
asked for it:

```sh
curl -g -u "opencode:<PASSWORD>" \
  'http://127.0.0.1:4098/api/location?location[directory]=/tmp/opencode/ahp-scratch/project-lan'
```

Returns the location JSON; the AHP listener starts at the same moment.

### 3. Verify host side

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/healthz   # 200
curl -s -o /dev/null -w '%{http_code}\n' 'http://10.0.1.107:8767/ahp'    # 401 (no token, LAN-reachable)
curl -s -o /dev/null -w '%{http_code}\n' 'http://10.0.1.107:8767/ahp?token=wrong'  # 401
```

If the LAN IP is not `10.0.1.107`: `hostname -I | awk '{print $1}'`.
(If the firewall blocks the port: `sudo ufw allow 8767/tcp` or equivalent.)

**Troubleshooting — AHP port dead but the server is up** (`healthz` →
connection refused, :4098 still 200): with keep-alive active (check the
server log for `keep-alive active`) this should not happen; if it does,
the location was evicted or the plugin failed to start, and the same
re-boot fixes it — the plugin setup re-runs and the listener comes
back:

```sh
curl -g -u "opencode:<PASSWORD>" \
  'http://127.0.0.1:4098/api/location?location[directory]=/tmp/opencode/ahp-scratch/project-lan'
```

VS Code reconnects on its own (the host's clientId registry resets, so the
client re-initializes from a fresh snapshot). A clean location teardown now
also logs `location teardown — stopping the AHP host` in the server log.

### 4. Hand over to PC B

```
ws://10.0.1.107:8767/ahp?token=xsnilxgywpthjZuhdRbjpf5O5mNATD3BaGXhdcw5ui0
```

(Replace the IP if step 3 says otherwise. The token in the URL is the one
from the project config — regenerate it if you changed it.)

## PC B — client side (VS Code 1.145.2)

1. Open the Agents window: `code --agents`, or Command Palette →
   **`Chat: Open Agents Window`**.
2. Command Palette → **`Agents: Add Remote Agent Host...`** → paste the
   `ws://` URL → save.
   (Equivalent persistent form, `settings.json`:
   `"chat.remoteAgentHosts": [{ "name": "opencode", "address": "ws://…" }]` —
   with Settings Sync on, that one line propagates to every PC.)
3. The host appears in the Agents window picker → select it → start a new
   session.
4. Check:
   - Agent picker lists the opencode providers (free `opencode` models and
     `gpuz`).
   - Model picker shows the real catalog (~16 models); pick
     `gpuz/qwen3.8-27b-q5xl`.
   - Prompt: *Use your bash tool to run exactly: `echo hello-lan` — then
     reply with the command output.*
     → text streams in, the tool runs on PC A (watch the server terminal),
     the output comes back.
5. Reconnect check (optional): close the Agents window, reopen → the host
   re-appears in the picker (VS Code reconnects). *Session history across
   reconnects is a Phase 1 feature (createSession), not testable yet.*

## PC A — teardown

- Ctrl-C in the serve terminal.
- `rm -rf /tmp/opencode/ahp-lan` (isolated state).
- The `project-lan/` directory and its config can stay; they are inert until
  a server loads them.
