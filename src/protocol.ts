/**
 * MTProto 2.0 protocol constants.
 *
 * Centralizes all wire-format constants, constructor IDs, and obfuscation
 * parameters used across the transport, client, and handshake layers.
 * Keeping them in one place prevents drift between modules and makes the
 * protocol surface easy to audit.
 */

/** Abridged frame tag placed at offset 56 of the 64-byte obfuscation header. */
export const ABRIDGED_TAG = new Uint8Array([0xef, 0xef, 0xef, 0xef])

/** First 4 bytes that are forbidden at the start of an obfuscation header. */
export const FORBIDDEN_FIRST = new Set([0x44414548, 0x54534f50, 0x20544547, 0xeeeeeeee])

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ MTProto message constructors                                            │
// └─────────────────────────────────────────────────────────────────────────┘

export const MSG_CONTAINER = 0x73f1f8dc
export const GZIP_PACKED = 0x3072cfa1
export const RPC_RESULT = 0xf35c6d01
export const RPC_ERROR = 0x2144ca19
export const BAD_SERVER_SALT = 0xedab447b
export const BAD_MSG_NOTIFICATION = 0xa7eff811
export const NEW_SESSION_CREATED = 0x9ec20908
export const MSGS_ACK = 0x62d6b459
/** `ping#7abe77ec ping_id:long = Pong;` used as an application-level keep-alive. */
export const PING = 0x7abe77ec
/**
 * `ping_delay_disconnect#f3427b8c ping_id:long disconnect_delay:int = Pong;`
 * tells Telegram how long it should keep an otherwise idle socket open.
 */
export const PING_DELAY_DISCONNECT = 0xf3427b8c

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Client-layer constructors                                               │
// └─────────────────────────────────────────────────────────────────────────┘

export const INIT_CONNECTION = 0xc1cd5ea9
export const INVOKE_WITH_LAYER = 0xda9b0d0d
export const TL_LAYER = 233

// ┌─────────────────────────────────────────────────────────────────────────┐
// │ Transport limits                                                        │
// └─────────────────────────────────────────────────────────────────────────┘

/** Maximum abridged frame payload size in bytes (16 MB - 16). */
export const MAX_FRAME_PAYLOAD = 16778240

/** Default RPC timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 20_000

/** Default keep-alive ping interval in milliseconds. */
export const DEFAULT_PING_INTERVAL_MS = 30_000

/** Number of message ID bits to shift for monotonic msg_id generation. */
export const MSG_ID_SHIFT = 32
