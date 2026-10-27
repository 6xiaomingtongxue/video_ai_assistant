# VideoLens Bridge

VideoLens Bridge is the local Native Messaging host for automatic video text
processing and account authorization. It embeds the provider routing SDK and
starts the managed video text worker on demand. Users do not configure service
URLs, credentials, Python, Node.js, Docker, or CLIProxyAPI.

The bridge binds only to `127.0.0.1:18317`. Per-install client and management
keys, provider credentials, and generated configuration are stored under:

```text
%LOCALAPPDATA%\VideoLens\Bridge
```

The authenticated video text worker listens on `127.0.0.1:18318`. The extension
discovers its configuration through `text.config`; credentials never enter the
settings form or video page. The first request without complete subtitles
downloads isolated Python and Node.js runtimes plus speech dependencies. Later
requests reuse them. Release archives are SHA-256 checked. The worker and its
models, completed text, and setup/service logs live in `text-service/`.

Runtime preparation returns a pending state immediately so OAuth and other
Native Messaging requests remain responsive. A failed setup can retry, and
completed text works from the extension cache without starting the worker.

Only one provider account is retained. The extension clears this credential
directory before switching providers and when the user signs out.

Codex models are fetched from the signed-in account's upstream catalog through
`models.list`, using the existing CPA Codex authorization route and catalog
protocol `0.164.0`. The UI receives only model identifiers, names, and capabilities.
Hidden models, image generators, and models without text support are excluded.
Successful catalogs cache for five minutes; explicit refresh bypasses that cache.
Live models replace CPA's bundled model registrations and survive token-refresh
registration events. Fetch failures never fall back to the bundled snapshot.

## Local development

```powershell
npm run bridge:build
npm run bridge:install
```

Reload the unpacked extension after installation. The development extension ID
is fixed by the public key in `extension/manifest.json`; a store release should
run the installer with the published extension ID.
