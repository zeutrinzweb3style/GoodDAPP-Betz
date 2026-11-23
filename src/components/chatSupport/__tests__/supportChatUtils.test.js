import {
  MAX_MESSAGE_BYTES,
  POST_COOLDOWN_SECONDS,
  buildScanRanges,
  dedupeAndSortMessages,
  describeSendError,
  estimateCostWei,
  formatCeloFromWei,
  formatRelativeTime,
  isBalanceTooLow,
  isContractAddress,
  mapEventToMessage,
  resolveScanWindow,
  sanitizeMessage,
  shortenAddress,
  truncateToBytes,
  utf8ByteLength,
  validateMessage,
} from '../supportChatUtils'

describe('supportChatUtils', () => {
  describe('utf8ByteLength', () => {
    it('counts ascii, accented and emoji correctly', () => {
      expect(utf8ByteLength('hello')).toBe(5)
      expect(utf8ByteLength('ñ')).toBe(2)
      expect(utf8ByteLength('₱')).toBe(3)
      expect(utf8ByteLength('💬')).toBe(4)
      expect(utf8ByteLength('')).toBe(0)
      expect(utf8ByteLength(null)).toBe(0)
    })
  })

  describe('truncateToBytes', () => {
    it('never splits a multi-byte character', () => {
      expect(truncateToBytes('a💬b', 1)).toBe('a')
      expect(truncateToBytes('a💬b', 5)).toBe('a💬')
      expect(truncateToBytes('abc', 10)).toBe('abc')
    })
  })

  describe('sanitizeMessage', () => {
    it('normalises newlines, strips control characters and trims', () => {
      expect(sanitizeMessage('  hi\r\nthere  ')).toBe('hi\nthere')
      expect(sanitizeMessage('a\u0000b\u0007c')).toBe('abc')
      expect(sanitizeMessage('line \n\n\n\nnext')).toBe('line\n\nnext')
    })

    it('enforces the byte cap', () => {
      const long = 'x'.repeat(MAX_MESSAGE_BYTES + 50)

      expect(utf8ByteLength(sanitizeMessage(long))).toBe(MAX_MESSAGE_BYTES)
    })
  })

  describe('validateMessage', () => {
    it('rejects empty and oversized drafts', () => {
      expect(validateMessage('   ')).toMatchObject({ ok: false, error: 'empty' })
      expect(validateMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toMatchObject({ ok: false, error: 'too_long' })
      expect(validateMessage('hello')).toEqual({ ok: true })
    })
  })

  describe('addresses', () => {
    it('accepts a real address and refuses the zero address', () => {
      expect(isContractAddress('0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A')).toBe(true)
      expect(isContractAddress('0x0000000000000000000000000000000000000000')).toBe(false)
      expect(isContractAddress('0x123')).toBe(false)
      expect(isContractAddress('')).toBe(false)
      expect(isContractAddress(undefined)).toBe(false)
    })

    it('shortens for display', () => {
      expect(shortenAddress('0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A')).toBe('0x62B8…9c7A')
      expect(shortenAddress('0xabc')).toBe('0xabc')
    })
  })

  describe('cost maths', () => {
    it('formats wei as CELO without floating point', () => {
      expect(formatCeloFromWei('16200000000000000')).toBe('0.0162')
      expect(formatCeloFromWei('1000000000000000000')).toBe('1')
      expect(formatCeloFromWei('1234500000000000000000')).toBe('1234.5')
      expect(formatCeloFromWei('0')).toBe('0')
      expect(formatCeloFromWei(1)).toBe('0')
      expect(formatCeloFromWei('1', 18)).toBe('0.000000000000000001')
    })

    it('multiplies gas units by gas price exactly', () => {
      const wei = estimateCostWei(80000, '202510779416')

      expect(String(wei)).toBe('16200862353280000')
      expect(formatCeloFromWei(wei)).toBe('0.0162')
    })

    it('flags a wallet that cannot cover the fee plus buffer', () => {
      const cost = '16200862353280000'

      expect(isBalanceTooLow('0', cost)).toBe(true)
      expect(isBalanceTooLow('16200862353280000', cost)).toBe(true)
      expect(isBalanceTooLow('40000000000000000', cost)).toBe(false)
    })
  })

  describe('log scanning', () => {
    it('builds contiguous ranges that respect the RPC cap', () => {
      expect(buildScanRanges(0, 10, 5)).toEqual([
        [0, 4],
        [5, 9],
        [10, 10],
      ])
    })

    it('never scans before the deploy block and keeps the newest chunks', () => {
      const fresh = resolveScanWindow({ latestBlock: 100000, windowBlocks: 6000, chunkSize: 4000 })

      expect(fresh.fromBlock).toBe(94001)
      expect(fresh.truncated).toBe(false)
      expect(fresh.ranges).toEqual([
        [94001, 98000],
        [98001, 100000],
      ])

      const anchored = resolveScanWindow({ latestBlock: 100000, deployBlock: 99500, windowBlocks: 6000 })

      expect(anchored.fromBlock).toBe(99500)
      expect(anchored.ranges).toEqual([[99500, 100000]])
    })

    it('caps the work on a very wide window', () => {
      const window = resolveScanWindow({ latestBlock: 100000, windowBlocks: 100000, chunkSize: 1000, maxChunks: 3 })

      expect(window.truncated).toBe(true)
      expect(window.ranges).toHaveLength(3)
      expect(window.ranges[2]).toEqual([99001, 100000])
    })
  })

  describe('events', () => {
    const event = {
      returnValues: { id: '7', author: '0xabc', message: 'hello', timestamp: '1700000000' },
      transactionHash: '0xdead',
    }

    it('maps an event to a message', () => {
      expect(mapEventToMessage(event)).toEqual({
        id: 7,
        author: '0xabc',
        message: 'hello',
        timestamp: 1700000000,
        txHash: '0xdead',
      })
    })

    it('de-duplicates a re-scan and sorts by id', () => {
      const first = mapEventToMessage(event)
      const second = { ...first, id: 3, message: 'first' }

      expect(dedupeAndSortMessages([first, second, first]).map(m => m.id)).toEqual([3, 7])
    })
  })

  describe('formatRelativeTime', () => {
    const now = 1700000000000

    it('reads like a chat timestamp', () => {
      expect(formatRelativeTime(0, now)).toBe('')
      expect(formatRelativeTime(now / 1000 - 5, now)).toBe('just now')
      expect(formatRelativeTime(now / 1000 - 120, now)).toBe('2m ago')
      expect(formatRelativeTime(now / 1000 - 7200, now)).toBe('2h ago')
      expect(formatRelativeTime(now / 1000 - 2 * 86400, now)).toBe('2d ago')
      expect(formatRelativeTime(now / 1000 - 30 * 86400, now)).not.toMatch(/ago/)
    })
  })

  describe('describeSendError', () => {
    it('turns wallet failures into actionable copy', () => {
      expect(describeSendError(new Error('User denied transaction signature'))).toMatch(/cancelled/i)
      expect(describeSendError(new Error('4001'))).toMatch(/cancelled/i)
      expect(describeSendError(new Error('insufficient funds for gas * price + value'))).toMatch(/telegram/i)
      expect(describeSendError(new Error('Reached daily transactions limit or not a citizen'))).toMatch(/telegram/i)
      expect(describeSendError(new Error('PostingTooSoon(5)'))).toMatch(/wait a few seconds/i)
      expect(describeSendError(new Error('MessageTooLong(1200, 1000)'))).toMatch(/under 1000 bytes/i)
      expect(describeSendError(new Error('EmptyMessage()'))).toMatch(/write a message/i)
      expect(describeSendError(new Error('Failed to fetch'))).toMatch(/network/i)
      expect(describeSendError(null)).toMatch(/try again/i)
    })
  })

  it('keeps the on-chain guards in sync with the contract constants', () => {
    // contracts/SupportChat.sol: MAX_MESSAGE_BYTES = 1000, POST_COOLDOWN_SECONDS = 15
    expect(MAX_MESSAGE_BYTES).toBe(1000)
    expect(POST_COOLDOWN_SECONDS).toBe(15)
  })
})
