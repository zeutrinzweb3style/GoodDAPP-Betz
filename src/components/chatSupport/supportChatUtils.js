/* global BigInt */
/**
 * Pure helpers for the on-chain support chat.
 *
 * Everything here is side-effect free and dependency free, so it can be unit
 * tested without a browser, a wallet or a chain. The React layer
 * (`useSupportChat.web.js`) is the only place that talks to web3.
 */

export const MAX_MESSAGE_BYTES = 1000
export const POST_COOLDOWN_SECONDS = 15

/** Blocks scanned on the first load when the deploy block is unknown. */
export const DEFAULT_SCAN_WINDOW_BLOCKS = 6000

/** `eth_getLogs` range used per request. Public Celo RPCs cap this at ~5000. */
export const SCAN_CHUNK_BLOCKS = 4000

/** Hard cap on chunks per load, so a slow RPC cannot hang the panel. */
export const MAX_SCAN_CHUNKS = 4

/** How often the open panel asks for new messages. */
export const MESSAGES_POLL_MS = 15000

/** Sample text used to show a cost estimate before the member types. */
export const ESTIMATE_SAMPLE = 'x'.repeat(200)

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** UTF-8 length of a string, without relying on TextEncoder (jsdom/old Safari). */
export const utf8ByteLength = text => {
  let bytes = 0

  for (const char of String(text || '')) {
    const code = char.codePointAt(0)

    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }

  return bytes
}

/** Cut a string so its UTF-8 length never exceeds `maxBytes`, never mid-character. */
export const truncateToBytes = (text, maxBytes) => {
  let bytes = 0
  let result = ''

  for (const char of String(text || '')) {
    const size = utf8ByteLength(char)

    if (bytes + size > maxBytes) break

    bytes += size
    result += char
  }

  return result
}

/**
 * Normalise a draft before it is signed: unify newlines, drop control
 * characters (keeping line breaks, which are legitimate), collapse runs of
 * blank lines, trim, and enforce the on-chain byte limit.
 */
export const sanitizeMessage = (text, maxBytes = MAX_MESSAGE_BYTES) => {
  const cleaned = String(text || '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return truncateToBytes(cleaned, maxBytes)
}

/** @returns {{ ok: boolean, error?: 'empty' | 'too_long', message?: string }} */
export const validateMessage = (text, maxBytes = MAX_MESSAGE_BYTES) => {
  const bytes = utf8ByteLength(sanitizeMessage(text, maxBytes * 2))

  if (bytes === 0) return { ok: false, error: 'empty', message: 'Write a message first.' }
  if (bytes > maxBytes) {
    return { ok: false, error: 'too_long', message: `Keep it under ${maxBytes} bytes.` }
  }

  return { ok: true }
}

/** A contract address that is worth trying to talk to. */
export const isContractAddress = value => {
  const address = String(value || '').trim()

  return /^0x[0-9a-fA-F]{40}$/.test(address) && address.toLowerCase() !== ZERO_ADDRESS
}

/** `0x1234…cdef` — enough to recognise, not enough to copy-paste by mistake. */
export const shortenAddress = (address, head = 6, tail = 4) => {
  const value = String(address || '')

  if (value.length <= head + tail + 1) return value

  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

const toBigInt = value => {
  if (typeof value === 'bigint') return value

  const text = String(value == null ? '0' : value).trim()

  if (!/^-?\d+$/.test(text)) return BigInt(0)

  return BigInt(text)
}

/** Exact decimal string from a wei value, trailing zeros trimmed. */
export const formatCeloFromWei = (wei, maxFractionDigits = 6) => {
  const value = toBigInt(wei)
  const negative = value < BigInt(0)
  const digits = String(negative ? -value : value).padStart(19, '0')
  const whole = digits.slice(0, -18)
  const fraction = digits.slice(-18).slice(0, Math.max(0, maxFractionDigits)).replace(/0+$/, '')
  const sign = negative ? '-' : ''

  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
}

/** gas units * gas price, both as wei-compatible integers. */
export const estimateCostWei = (gasUnits, gasPriceWei) => toBigInt(gasUnits) * toBigInt(gasPriceWei)

/** True when the wallet cannot pay the estimate plus a small buffer. */
export const isBalanceTooLow = (balanceWei, costWei, bufferPercent = 20) => {
  const cost = toBigInt(costWei)
  const buffer = (cost * BigInt(bufferPercent)) / BigInt(100)

  return toBigInt(balanceWei) < cost + buffer
}

/** Ascending `[from, to]` ranges that cover the window without exceeding the RPC cap. */
export const buildScanRanges = (fromBlock, toBlock, chunkSize = SCAN_CHUNK_BLOCKS) => {
  const start = Math.max(0, Math.floor(Number(fromBlock) || 0))
  const end = Math.max(start, Math.floor(Number(toBlock) || 0))
  const step = Math.max(1, Math.floor(Number(chunkSize) || SCAN_CHUNK_BLOCKS))
  const ranges = []

  for (let from = start; from <= end; from += step) {
    ranges.push([from, Math.min(from + step - 1, end)])
  }

  return ranges
}

/**
 * First load scans backwards from the head. When the deploy block is known we
 * never scan before it (no logs can exist there) and we never look further back
 * than the window, so the first paint stays fast.
 */
export const resolveScanWindow = ({
  latestBlock,
  deployBlock = 0,
  windowBlocks = DEFAULT_SCAN_WINDOW_BLOCKS,
  chunkSize = SCAN_CHUNK_BLOCKS,
  maxChunks = MAX_SCAN_CHUNKS,
}) => {
  const head = Math.max(0, Math.floor(Number(latestBlock) || 0))
  const deploy = Math.max(0, Math.floor(Number(deployBlock) || 0))
  const window = Math.max(1, Math.floor(Number(windowBlocks) || DEFAULT_SCAN_WINDOW_BLOCKS))
  const fromBlock = Math.max(deploy, head - window + 1, 0)
  const ranges = buildScanRanges(fromBlock, head, chunkSize)

  return {
    fromBlock,
    toBlock: head,
    truncated: ranges.length > maxChunks,
    ranges: ranges.slice(Math.max(0, ranges.length - maxChunks)),
  }
}

/** Event -> plain message, tolerant of both web3 `returnValues` and raw logs. */
export const mapEventToMessage = event => {
  const values = (event && event.returnValues) || {}
  const id = Number(values.id || 0)
  const timestamp = Number(values.timestamp || 0)

  return {
    id: Number.isFinite(id) ? id : 0,
    author: String(values.author || ''),
    message: String(values.message || ''),
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    txHash: String((event && (event.transactionHash || event.txHash)) || ''),
  }
}

/** Newest last, one row per id (a re-scan or an RPC retry must not duplicate). */
export const dedupeAndSortMessages = messages => {
  const byId = new Map()

  ;(messages || []).forEach(message => {
    if (!message) return

    const key = message.id || message.txHash

    if (!key) return

    byId.set(key, message)
  })

  return [...byId.values()].sort((a, b) => a.id - b.id)
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / a date. */
export const formatRelativeTime = (timestampSeconds, nowMs = Date.now()) => {
  const seconds = Math.floor(Number(timestampSeconds) || 0)

  if (!seconds) return ''

  const diff = Math.max(0, Math.floor(nowMs / 1000) - seconds)

  if (diff < 45) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`

  return new Date(seconds * 1000).toLocaleDateString()
}

const ERROR_MESSAGES = {
  user_rejected: 'Signature cancelled — nothing was sent.',
  insufficient_gas: 'Not enough CELO for the network fee. Join the Telegram group instead — it is free.',
  cooldown: 'Please wait a few seconds before posting again.',
  too_long: `Keep it under ${MAX_MESSAGE_BYTES} bytes.`,
  empty: 'Write a message first.',
  network: 'The network did not answer. Please try again.',
  unknown: 'Could not send the message. Please try again.',
}

/** Turn a wallet/web3 failure into one sentence a member can act on. */
export const describeSendError = error => {
  const message = String((error && (error.message || error.reason)) || '').toLowerCase()

  if (!message) return ERROR_MESSAGES.unknown
  if (message.includes('user denied') || message.includes('rejected') || message.includes('4001')) {
    return ERROR_MESSAGES.user_rejected
  }
  if (
    message.includes('insufficient funds') ||
    message.includes('gas required exceeds') ||
    message.includes('reached daily transactions limit') ||
    message.includes('not a citizen')
  ) {
    return ERROR_MESSAGES.insufficient_gas
  }
  if (message.includes('postingtoosoon') || message.includes('too soon')) return ERROR_MESSAGES.cooldown
  if (message.includes('messagetoolong')) return ERROR_MESSAGES.too_long
  if (message.includes('emptymessage')) return ERROR_MESSAGES.empty
  if (message.includes('network') || message.includes('timeout') || message.includes('failed to fetch')) {
    return ERROR_MESSAGES.network
  }

  return ERROR_MESSAGES.unknown
}

export { ERROR_MESSAGES }
