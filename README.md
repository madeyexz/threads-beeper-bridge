# threads-beeper-bridge

Bring your **Threads (threads.com) DMs into [Beeper](https://www.beeper.com)**. A small, dependency-free
Node.js bridge that mirrors each Threads conversation into a Beeper chat and sends your Beeper replies
back to Threads.

> Unofficial. It uses the private GraphQL API that the threads.com web app uses, with your own logged-in
> session. Meta can change or block it at any time, and automated use may be against Threads' terms.
> Use it on your own account, at your own risk.

## How it works

```
 Threads (Meta cloud)                                    Beeper (cloud)
 threads.com /api/graphql                                your hungryserv homeserver
        ▲                                                        ▲
        │ HTTPS (your session cookies)        appservice websocket│
 ───────┼──────────────────── your Mac ───────────────────────────┼──────
        │                                                        │
   bridge.mjs  ◀──── localhost HTTP (Matrix appservice API) ────▶ bbctl proxy
   (Threads ⇄ Matrix)
```

- `src/threads.mjs` reads your Threads login from a Chromium-based browser profile on macOS (it decrypts
  the cookie store with the browser's Keychain key), scrapes the request tokens from threads.com, and
  calls the Threads DM GraphQL queries (inbox, messages, send).
- `bridge.mjs` is a minimal Matrix application service. Each Threads conversation becomes a 1:1 Beeper
  room; contacts are ghost users `@sh-threads_<id>:beeper.local`; your own Threads messages are
  double-puppeted as you. Shared Threads posts show as link preview cards.
- [`bbctl proxy`](https://github.com/beeper/bridge-manager) connects the bridge to your Beeper account
  over a websocket, so no port forwarding or TLS is needed.

The bridge only runs while your Mac is awake. Chats already synced stay readable in Beeper on any device.

## Requirements

- macOS, Node.js 20+, `sqlite3` (preinstalled on macOS)
- A browser profile logged in to threads.com. The code defaults to [Dia](https://www.diabrowser.com)
  (`~/Library/Application Support/Dia/User Data/<profile>/Cookies`, Keychain item `Dia Safe Storage`);
  edit `diaCookieDb()` and `safeStorageKey()` in `src/threads.mjs` for another Chromium browser.
- A Beeper account and Beeper Bridge Manager: `brew install beeper/tap/bbctl`

## Setup

```bash
# 1. Log bbctl in to Beeper (can reuse your Beeper Desktop login)
bbctl login

# 2. Register the bridge with your Beeper account (creates the appservice and its tokens)
bbctl register --json sh-threads > registration.json

# 3. Make the registration file bbctl proxy reads, pointing at the local bridge
node -e '
const r = require("./registration.json").registration;
require("fs").writeFileSync("registration.yaml", `id: ${r.id}
url: http://localhost:29337
as_token: ${r.as_token}
hs_token: ${r.hs_token}
sender_localpart: ${r.sender_localpart}
rate_limited: false
namespaces:
  users:
  - regex: ${JSON.stringify(r.namespaces.users[0].regex)}
    exclusive: true
`)'

# 4. Run both (keep them running, e.g. in tmux or as launchd services)
bbctl proxy -r registration.yaml
node bridge.mjs --port 29337 --sync 60000
```

macOS asks once for permission to read the browser's Keychain key. The first sync creates one Beeper chat
per Threads conversation.

Options for `bridge.mjs`:

| Flag | Default | Meaning |
|---|---|---|
| `--profile` | `Default` | Browser profile folder that holds your Threads login |
| `--port` | `29337` | Local port; must match `url` in `registration.yaml` |
| `--sync` | `4000` | Inbox poll interval in ms. Use `60000`; Threads rate-limits aggressively |
| `--only` | | Bridge a single Threads conversation ID (for testing) |

To remove everything from Beeper: `bbctl delete sh-threads`.

## Files that stay local

These hold secrets or personal state and are git-ignored. Never commit them:

- `registration.json`, `registration.yaml`: appservice tokens that can act on your Beeper account
- `bridge-state.json`: your conversation and room IDs

The bridge also reads your bbctl access token from
`~/Library/Application Support/bbctl/config.json`.

## Limitations

- Polling, not push: new messages arrive on the next inbox poll.
- Text and shared posts only; photos, videos and voice notes show a placeholder.
- Threads rate-limits the message query (error `1675004`). The bridge only fetches a conversation when
  the inbox shows new activity, and backs off up to 1 hour when limited.
- Matrix message timestamps can't be edited. Setting `"rebuild": true` on a room in `bridge-state.json`
  makes the bridge copy that conversation into a fresh room and remove the old one.

## License

[MIT](LICENSE)
