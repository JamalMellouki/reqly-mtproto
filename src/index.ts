/**
 * reqly — a small MTProto 2.0 request/reply client.
 *
 * Copyright (c) 2026 Mellouki Jamal, Asynctric.
 * Licensed under ASYNCTRIC-3.0. Author and platform identity must be preserved.
 */

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Client                                                                 │
// └─────────────────────────────────────────────────────────────────────────┘
export { Reqly, type ReqlyOptions, type ParallelOptions } from "./client"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Errors                                                                 │
// └─────────────────────────────────────────────────────────────────────────┘
export { RpcError, FileReferenceExpiredError, FileMigrateError, FloodWaitError, CdnRedirectError, rpcError } from "./errors"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Protocol                                                               │
// └─────────────────────────────────────────────────────────────────────────┘
export type {
  ABRIDGED_TAG,
  FORBIDDEN_FIRST,
  MSG_CONTAINER,
  GZIP_PACKED,
  RPC_RESULT,
  BAD_SERVER_SALT,
  BAD_MSG_NOTIFICATION,
  NEW_SESSION_CREATED,
  MSGS_ACK,
  RPC_ERROR,
  INIT_CONNECTION,
  INVOKE_WITH_LAYER,
  TL_LAYER,
  MAX_FRAME_PAYLOAD,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  MSG_ID_SHIFT,
} from "./protocol"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Session                                                                │
// └─────────────────────────────────────────────────────────────────────────┘
export { parseSession, type Session } from "./session"
export { SessionStore } from "./sessions"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Streaming                                                              │
// └─────────────────────────────────────────────────────────────────────────┘
export { ChunkReader, createChunkReader, STREAM_MB, type StreamOptions } from "./stream"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Type Language (TL) codec                                               │
// └─────────────────────────────────────────────────────────────────────────┘
export { TlReader, TlWriter, IDs, decodeFile, decodeFileOrRedirect, extractDocuments, type RemoteDocument, type CdnRedirect } from "./tl"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Cryptography                                                           │
// └─────────────────────────────────────────────────────────────────────────┘
export {
  deriveKeys,
  messageKeyOf,
  sha1,
  igeEncrypt,
  igeDecrypt,
  ctrTransform,
  setIgeProvider,
  type IgeProvider,
  type DerivedKeys,
} from "./crypto"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Transport                                                              │
// └─────────────────────────────────────────────────────────────────────────┘
export { call, Connection, MessageIds, type Envelope, type CallOptions } from "./transport"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ WASM (optional)                                                        │
// └─────────────────────────────────────────────────────────────────────────┘
export { enableWasmCrypto } from "./wasm"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Diffie-Hellman key exchange                                            │
// └─────────────────────────────────────────────────────────────────────────┘
export {
  DH_CONST,
  reqPqEnvelope,
  parseResPq,
  factorPq,
  modPow,
  bigIntBytes,
  plainEnvelope,
  pqInnerDataDc,
  parseServerDhParamsOk,
  parseServerDhInnerData,
  clientDhInnerData,
  setClientDhParamsEnvelope,
  parseDhGenResult,
  type ResPq,
  type ServerDhParamsOk,
  type ServerDhInnerData,
  type DhGenOk,
} from "./dh"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ RSA handshake                                                          │
// └─────────────────────────────────────────────────────────────────────────┘
export {
  rsaKeyFromBytes,
  rsaPad,
  temporaryAes,
  decryptServerDh,
  encryptClientDh,
  computeAuthKey,
  bytesToBigInt,
  type RsaPublicKey,
} from "./handshake"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Telegram RSA keys                                                      │
// └─────────────────────────────────────────────────────────────────────────┘
export { TELEGRAM_RSA_KEYS, findTelegramKey, type RsaKeyMaterial } from "./rsa"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ File hashes                                                            │
// └─────────────────────────────────────────────────────────────────────────┘
export { decodeFileHashes, getFileHashes, sha256, verifyChunk, type FileHashEntry } from "./hashes"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Cloudflare Workers integration                                          │
// └─────────────────────────────────────────────────────────────────────────┘
export {
  streamFileRange,
  createFileResponse,
  createFileRequestHandler,
  createWorkerHandler,
  parseByteRange,
  documentETag,
  type WorkerRangeOptions,
  type WorkerHandlerOptions,
  type ParsedRange,
} from "./worker"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Interactive WebSocket streaming (one Worker request per stream)         │
// └─────────────────────────────────────────────────────────────────────────┘
export {
  createBotPool,
  attachStreamSocket,
  createWorkerWebSocketHandler,
  type D1Like,
  type BotPoolOptions,
  type StreamPool,
  type WsControl,
  type WsHandlerOptions,
} from "./ws"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Short-lived stream tokens                                               │
// └─────────────────────────────────────────────────────────────────────────┘
export { createStreamToken, verifyStreamToken, type StreamTokenPayload } from "./token"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ High-level SDK                                                         │
// └─────────────────────────────────────────────────────────────────────────┘
export {
  ReqlySdk,
  createReqlySdk,
  SDK_BLOCK_BYTES,
  type ReqlySdkOptions,
  type SdkDownloadOptions,
  type SdkStreamOptions,
  type SdkCache,
} from "./sdk"

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Package metadata                                                       │
// └─────────────────────────────────────────────────────────────────────────┘
export const version = "2.0.0"
export const author = "Mellouki Jamal"
export const platform = "Asynctric"
