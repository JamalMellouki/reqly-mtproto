# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 2.1.x | yes |
| 2.0.x | security fixes only |
| 1.0.x | no |

## Reporting a vulnerability

Please use **GitHub private vulnerability reporting** on
[`JamalMellouki/reqly-mtproto`](https://github.com/JamalMellouki/reqly-mtproto/security/advisories/new).

Do not open a public issue for:

- a leaked session string, bot token or API hash,
- a way to bypass range authorization,
- a signature or token verification flaw,
- a memory-safety or denial-of-service issue.

Include the version, runtime, a minimal reproduction and the impact. Never paste
a real session string or auth key into a report; use a throwaway account and
redact secrets.

## What counts as a secret

| Secret | Where it lives |
| --- | --- |
| gramJS `StringSession` | Worker secret or local git-ignored `.env` |
| 2048-bit `auth_key` (inside the session) | same as above |
| `tokenSecret` for stream tokens | Worker secret |
| Bot token / `api_hash` | Worker secret |
| Per-DC sessions | Worker secret |

Treat all of them as passwords. A session string is enough to act as the
account or bot; rotating it means revoking the authorization in Telegram.

## Handling checklist

- [ ] Secrets come from `env`/secret bindings, never from source files.
- [ ] `.env`, `.dev.vars` and local session notes are git-ignored.
- [ ] Logs never print a session, token, auth key or full request URL with a token.
- [ ] Stream tokens are short-lived and scoped with `k: "stream" | "download"`.
- [ ] Worker routes validate the caller before creating a Telegram client.
- [ ] `If-None-Match` responses never include a body.
- [ ] Error responses do not echo internal stack traces or secrets.
- [ ] Dependencies are reviewed: the package has **zero** runtime dependencies.

## Transport and cryptography

- MTProto 2.0 message encryption and key derivation are implemented in
  `src/crypto.ts`; AES-256-IGE is the default backend.
- An optional prebuilt WebAssembly backend ships as `dist/aes-ige.wasm`; a
  custom provider can be registered with `setIgeProvider()`.
- The RSA/DH handshake in `src/dh.ts`, `src/handshake.ts` and `src/rsa.ts` uses
  Telegram's production public keys, verified by fingerprint in tests.
- Stream tokens use HMAC-SHA256 over a base64url payload with an expiry.
- Session parsing rejects malformed DC ids, empty addresses and port zero before
  opening a socket.

## Disclosure

We aim to acknowledge a report within 72 hours, agree on a disclosure timeline,
and credit the reporter unless they prefer otherwise. Please give us a chance to
ship a fix before publishing details.
