# reqly 2.0.0 — architecture

![Architecture at a glance](./assets/architecture.svg)

reqly is deliberately small. There is no runtime dependency, no native addon
requirement and no module-global state: every `msg_id` counter, session and
connection lives inside a client instance. This is what makes concurrent Workers
invocations safe.

## Layers

```mermaid
flowchart LR
    A[Application / Worker] --> S[ReqlySdk]
    A --> C[Reqly core client]
    S --> C
    C --> T[TL codec]
    C --> K[Crypto: AES-IGE, RSA, DH]
    K --> W[(Embedded WASM)]
    C --> X[MTProto transport]
    X --> D[(Telegram DC)]
    S --> H[HTTP 206 streaming]
    S --> WS[WebSocket streaming]
    S --> TK[HMAC stream tokens]
```

## Cross-DC file download

`FILE_MIGRATE_X` means the file lives on another data center and its `auth_key`
cannot be reused there. reqly performs the full MTProto 2.0 handshake itself —
`req_pq_multi`, pq factorization, `req_DH_params`, RSA_PAD, DH key derivation —
then imports the bot authorization into the new session.

```mermaid
sequenceDiagram
    participant App
    participant Sdk as ReqlySdk
    participant Client as Reqly
    participant DC1 as Home DC
    participant DC2 as Target DC
    App->>Sdk: download(document)
    Sdk->>Client: getFilesParallel(...)
    Client->>DC1: upload.getFile (1 MB)
    DC1-->>Client: FILE_MIGRATE_X
    Client->>DC2: auth handshake (RSA + DH)
    Client->>DC2: upload.getFile on migrated session
    DC2-->>Client: upload.file
    Client-->>Sdk: Uint8Array blocks
    Sdk-->>App: assembled bytes
```

## HTTP streaming path

```mermaid
flowchart TD
    R[GET /file with Range header] --> P[parseByteRange]
    P -->|invalid| E[416 Content-Range: bytes */size]
    P -->|valid| B[Plan 1 MB block ranges]
    B --> Q[getFilesParallel: 2 to 4 workers]
    Q --> C{Cache API hit?}
    C -->|yes| Z[Reuse cached bytes, zero RPCs]
    C -->|no| T[Telegram upload.getFile]
    T --> Z
    Z --> A[Assemble 206 response]
    A --> H[ETag + Accept-Ranges + Content-Range]
```

## Trust boundaries

- Session strings and auth keys never leave the process; they are constructor
  inputs, not exported values.
- Stream tokens are HMAC-SHA256 signed with an application secret and carry an
  expiry (`e`). The SDK never logs them.
- `docs/showcase/index.html` is a static demo. It uses synthetic data only — it
  contains no credentials and makes no Telegram requests.

## Where to look next

| Topic | File |
| --- | --- |
| High-level API | [`SDK.md`](./SDK.md) |
| Measured performance | [`BENCHMARKS.md`](./BENCHMARKS.md) |
| Worker CPU model | [`PERFORMANCE.md`](./PERFORMANCE.md) |
| Release history | [`CHANGELOG.md`](../CHANGELOG.md) |
| Interactive demo | [`showcase/index.html`](./showcase/index.html) |
