# Contributing to reqly

Thank you for helping improve reqly. This project is maintained by Mellouki Jamal for Asynctric.

## Ground rules

- Keep the runtime dependency-free. Do not introduce an MTProto library at runtime.
- Preserve the author and platform identity in every source file.
- Match MTProto behaviour to the official Telegram documentation. Cite URLs in comments where useful.

## Development

```sh
npm install
npm run build
npm test
```

Live tests are skipped unless explicitly configured:

``` sh
REQLY_LIVE_TEST=1 REQLY_SESSION="<session>" npm test
```

Never commit a session string, API hash, or any secret.

## Pull requests

1. Fork and create a focused branch.
2. Add or update tests for every behaviour change.
3. Run `npm run build && npm test` before opening the PR.
4. Describe what changed and why. Include protocol references for wire-format changes.

## Reporting bugs

Use the issue template. Include the runtime (Workers/Node), `reqly` version,
a minimal reproduction, and any Telegram error code. Redact session strings.

## License

By contributing you agree that your contribution is licensed under
ASYNCTRIC-3.0 and that the identity clauses remain intact.
