# Public HTTPS for ChatGPT MCP

ChatGPT and other web-hosted MCP clients need a public HTTPS URL for the hub MCP SSE endpoint.

The hub already supports public deployment through:
- `PUBLIC_URL` for OAuth and metadata URL generation.
- `OAUTH_USERNAME` and `OAUTH_PASSWORD` for the authorization page.
- Bearer/API-key validation on `/sse`.
- The MCP SSE endpoint at `/sse` and POST endpoint at `/messages`.

## Required environment

Set these on the process that starts `hub/dist/index.js`:

```bash
PUBLIC_URL=https://your-public-host.example
OAUTH_USERNAME=your-login-name
OAUTH_PASSWORD=your-login-password
PORT=3000
```

Leave the device WebSocket private when possible. The Windows device can keep using the private Tailscale URL:

```text
DC_HUB_URL=ws://100.76.176.119:3000
```

## Caddy example

```caddyfile
your-public-host.example {
  reverse_proxy 127.0.0.1:3000
}
```

ChatGPT MCP URL:

```text
https://your-public-host.example/sse
```

OAuth metadata:

```text
https://your-public-host.example/.well-known/oauth-authorization-server
```

## Tailscale Funnel option

If Tailscale Funnel is enabled for the tailnet, expose the hub without replacing unrelated existing serve routes:

```bash
tailscale serve --bg --set-path=/dc http://127.0.0.1:3000
tailscale funnel --bg /dc
```

Then set:

```bash
PUBLIC_URL=https://<machine-name>.<tailnet>.ts.net/dc
```

Use the MCP URL:

```text
https://<machine-name>.<tailnet>.ts.net/dc/sse
```

Do not run a broad `tailscale serve reset` on the Mac Mini unless you intend to remove the existing route currently serving another local port.
