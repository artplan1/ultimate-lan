Expose selected [Ultimate](https://github.com/HazAT/ultimate) projects on a trusted home LAN, with HTTPS through your existing reverse proxy and a same-tab project menu. Reuses Ultimate's PWA and push support; no additional runtime packages.

**NO AUTHENTICATION. Every admitted client can read projects and run commands with the agent's permissions. HTTPS is not a password. Do not expose this to the Internet or forward its ports from the WAN.**

## Install

Requires Node 26 and an Ultimate host with `access.allow`, `projects`, lifecycle callbacks and the web SDK. Complete the checkout outside Ultimate's watched extension directories, then link it as a user extension:

```sh
git clone https://github.com/artplan1/ultimate-lan.git /path/to/ultimate-lan
mkdir -p ~/.ultimate/extensions
ln -s /path/to/ultimate-lan ~/.ultimate/extensions/ultimate-lan
```

Linking hot-reloads the extension in running hosts. Configure the network boundary before enabling LAN settings. No model/provider changes or core restart are needed.

## Configure

Merge `lan` into **user-level** `~/.ultimate/settings.json`, preserving other keys. Copy exact project `home` values from `ultimate.projects()` in Ultimate's codemode; these are state homes, not source checkouts. Replace all example values:

```json
{
  "lan": {
    "home": "/absolute/coordinator-state-home",
    "address": "192.168.1.10",
    "port": 4751,
    "proxy": {
      "address": "192.168.1.4",
      "hostname": "lan.example.org",
      "projects": [
        { "home": "/absolute/coordinator-state-home", "gatewayPort": 4751, "httpsPort": 8443 },
        { "home": "/absolute/another-project-state-home", "gatewayPort": 4752, "httpsPort": 8444 }
      ]
    },
    "tailscale": {
      "address": "100.64.0.9",
      "peers": ["100.64.0.9", "100.64.0.10"]
    }
  }
}
```

Only mapped ordinary default homes open HTTPS gateways; custom/preview/worktree homes do not. Ports and homes must be unique. Stopped projects remain stopped. Each process forwards only to its own loopback supervisor. Labels are optional; `port` defaults to 4751. The coordinator's gateway must use that fallback port.

The coordinator also keeps plaintext `http://192.168.1.10:4751/` access from its /24. Omit `proxy` for HTTP-only mode; it cannot provide secure-context PWA/push features. Other mapped gateways admit only the designated proxy peer and exact public Host, including its port. Origin and Fetch Metadata still pass through Ultimate's core admission. Forged identity/forwarding headers are removed; a private process-local hop proof is not user authentication. Release/unload revokes admission and closes streams, including SSE.

`tailscale` adds one plaintext HTTP listener per running mapped project on this host's own Tailscale address, at the same per-project `gatewayPort` the targets already give it (the coordinator uses `port`). Each admits only the exact configured peer addresses and the exact `Host: <address>:<port>`, and refuses a repeated or empty Host/Origin outright; a peer outside the allowlist, a different authority, or a missing Tailscale address fails closed without touching the LAN or proxy routes. The list must include `address` itself: the host is a client of its own address, and its readiness probes come from it. This gives those peers a single base — the same scheme and host, one port per project — so the same-tab menu can switch between them without leaving that base or opening an installed app. It also gives them reads and agent actions in every mapped project, exactly as the HTTPS gateways already do; plaintext HTTP is not a secure context, so no PWA, service worker or push on those origins.

## Reverse-proxy contract

The extension does **not** configure DNS, certificates, a firewall or proxy software. For each public port, your existing proxy must:

- Serve the configured hostname with trusted TLS. Both browsers and the host's Node TLS client must trust it; local DNS must resolve it to the proxy.
- Admit only the intended LAN **actual TCP peers**, not `X-Forwarded-For`. Exclude the router/SNAT relay address. Enforce this on **every path**, including HTTP/redirect listeners; no WAN exposure.
- Route to the corresponding private gateway port, preserving the external `Host:port`, Origin and Fetch Metadata. Preserve streaming/SSE; do not buffer it indefinitely.

The proxy must share the gateway's /24 and appear as the configured peer. Confirm actual peers when using containers/NAT. Keep TLS keys and issuer credentials on the proxy. Its hop to the gateway is LAN HTTP, not end-to-end TLS. Publishing new proxy ports or recreating a shared proxy can interrupt other services; plan and validate those operations separately.

## Menu, PWA and push

Remote pages show ready links, the current project, and disabled Offline / Not ready / Not published rows. Links keep the page's own scheme and host and change only the port of the project they open, so a page opened on a plaintext base never jumps to HTTPS. The current row does not navigate. On the coordinator's plaintext LAN base only the current project is admitted, so the other rows read HTTPS only; the Tailscale base reaches every running mapped project. Readiness verifies the intended project's initial SSE identity on the same transport the link uses, not just a live process. This does not prove a phone's DNS/network path. Loopback UI stays unchanged.

Each HTTPS port has separate origin storage, service worker, installed app and push subscription. Switching projects can leave an installed app for the browser. Install and enable notifications separately for desired origins; verify background delivery and notification tap on the actual phone. Cookies are **not** isolated by port.

## Development

This is a host-loaded extension, not a standalone Node application. Use an existing public Ultimate checkout with its dependencies installed; this repository needs no dependency install. Tests require OpenSSL and create only temporary loopback fixtures with synthetic TLS credentials.

```sh
export ULTIMATE_ROOT=/path/to/ultimate
npm run check
npm test
node "$ULTIMATE_ROOT/scripts/check-extension.ts" "$PWD"
```

Tests use the host's real admission implementation; production code imports no clone internals. The external checker resolves host packages and SDK types against this actual folder. This is host-integration verification, not a clean-install claim. Tested with public Ultimate `c4b6f915` / Pi 1.5.2. MIT; adapted Ultimate code retains its original notice in [LICENSE](LICENSE).
