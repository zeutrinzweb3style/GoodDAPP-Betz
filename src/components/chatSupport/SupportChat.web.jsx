/**
 * On-chain support chat widget (web only — see SupportChat.native.jsx).
 *
 * Deliberately small and dependency free: plain DOM elements with inline
 * styles, because the widget floats above the app shell and must not depend on
 * the react-native-web layout engine for `position: fixed`.
 *
 * The panel is only rendered once a wallet is connected AND the contract
 * address is configured, which is the product rule: the chat is a wallet
 * feature, not a landing page.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import Config from '../../config/config'
import { theme } from '../theme/styles'

import useSupportChat from './useSupportChat'
import {
  MAX_MESSAGE_BYTES,
  formatRelativeTime,
  shortenAddress,
  utf8ByteLength,
  sanitizeMessage,
} from './supportChatUtils'

const COLORS = {
  primary: theme.colors.primary,
  ink: theme.colors.text,
  dim: theme.colors.gray,
  line: theme.colors.lightGray,
  surface: theme.colors.white,
  soft: theme.colors.secondaryGray,
  warning: theme.colors.orange,
  danger: theme.colors.red,
  success: theme.colors.green,
}

const styles = {
  launcher: {
    position: 'fixed',
    right: 20,
    bottom: 20,
    zIndex: 1200,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    height: 48,
    padding: '0 18px',
    border: 0,
    borderRadius: 24,
    background: COLORS.primary,
    color: COLORS.surface,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(12, 38, 61, 0.28)',
  },
  panel: {
    position: 'fixed',
    right: 20,
    bottom: 20,
    zIndex: 1200,
    display: 'flex',
    flexDirection: 'column',
    width: 'min(380px, calc(100vw - 32px))',
    maxHeight: 'min(620px, calc(100vh - 40px))',
    borderRadius: 16,
    background: COLORS.surface,
    color: COLORS.ink,
    boxShadow: '0 12px 40px rgba(12, 38, 61, 0.32)',
    overflow: 'hidden',
    fontFamily: theme.fonts.default,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 16px',
    borderBottom: `1px solid ${COLORS.line}`,
  },
  title: { margin: 0, fontSize: 16, fontWeight: 700 },
  close: {
    border: 0,
    background: 'transparent',
    color: COLORS.dim,
    fontSize: 20,
    lineHeight: 1,
    cursor: 'pointer',
    padding: 4,
  },
  body: { padding: '12px 16px', overflowY: 'auto', flex: 1, minHeight: 120 },
  notice: {
    padding: '10px 12px',
    marginBottom: 12,
    borderRadius: 10,
    background: COLORS.soft,
    fontSize: 13,
    lineHeight: 1.45,
  },
  link: { color: COLORS.primary, fontWeight: 600, textDecoration: 'none' },
  cost: { marginBottom: 12, fontSize: 12, color: COLORS.dim, lineHeight: 1.45 },
  warning: {
    padding: '8px 10px',
    marginBottom: 12,
    borderRadius: 8,
    background: '#FFF6E5',
    color: '#8A5B00',
    fontSize: 12,
    lineHeight: 1.45,
  },
  message: { marginBottom: 12 },
  meta: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 2 },
  author: { fontSize: 12, fontWeight: 700, color: COLORS.dim },
  time: { fontSize: 11, color: COLORS.dim },
  text: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  empty: { fontSize: 13, color: COLORS.dim, textAlign: 'center', padding: '24px 0' },
  footer: {
    borderTop: `1px solid ${COLORS.line}`,
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  input: {
    width: '100%',
    minHeight: 64,
    maxHeight: 140,
    padding: '10px 12px',
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    fontSize: 14,
    fontFamily: 'inherit',
    color: COLORS.ink,
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  actions: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  counter: { fontSize: 11, color: COLORS.dim },
  send: {
    border: 0,
    borderRadius: 10,
    padding: '10px 18px',
    background: COLORS.primary,
    color: COLORS.surface,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  sendDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  status: { fontSize: 12, lineHeight: 1.45, margin: 0 },
  disclaimer: { fontSize: 11, color: COLORS.dim, lineHeight: 1.4, margin: 0 },
}

const explorerUrl = () => {
  const network = Config.ethereum && Config.ethereum[String(Config.networkId)]

  return (network && network.explorer) || 'https://celoscan.io'
}

export const SupportChat = () => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const listRef = useRef(null)

  const { enabled, account, messages, loading, sending, error, lastTxHash, cost, balanceTooLow, send } = useSupportChat(
    { open },
  )

  const bytes = useMemo(() => utf8ByteLength(sanitizeMessage(draft)), [draft])
  const canSend = enabled && !sending && bytes > 0 && bytes <= MAX_MESSAGE_BYTES

  const close = useCallback(() => setOpen(false), [])

  const submit = useCallback(async () => {
    if (!canSend) return

    const receipt = await send(draft)

    if (receipt) setDraft('')
  }, [canSend, draft, send])

  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = event => {
      if (event.key === 'Escape') close()
    }

    document.addEventListener('keydown', onKeyDown)

    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  // Keep the newest message in view without yanking the panel while reading.
  useEffect(() => {
    const node = listRef.current

    if (node && open) node.scrollTop = node.scrollHeight
  }, [messages.length, open])

  if (!enabled) return null

  const telegramUrl = Config.supportChatTelegramUrl

  if (!open) {
    return (
      <button
        type="button"
        style={styles.launcher}
        aria-label="Open support chat"
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">💬</span>
        Support
      </button>
    )
  }

  return (
    <section style={styles.panel} role="dialog" aria-label="Support chat" aria-modal="false">
      <header style={styles.header}>
        <h2 style={styles.title}>Support chat</h2>
        <button type="button" style={styles.close} aria-label="Close support chat" onClick={close}>
          ✕
        </button>
      </header>

      <div style={styles.body} ref={listRef}>
        <div style={styles.notice}>
          Need a quick answer? Live support is free in Telegram:{' '}
          <a style={styles.link} href={telegramUrl} target="_blank" rel="noopener noreferrer">
            {telegramUrl.replace(/^https?:\/\//, '')}
          </a>
        </div>

        <p style={styles.cost}>
          Messages here are on-chain transactions: about <strong>{cost.celo} CELO</strong> in network fees each, paid by
          your wallet. Nothing is charged by us.
        </p>

        {balanceTooLow && (
          <div style={styles.warning} role="status">
            Your wallet is low on CELO for the network fee. Use Telegram instead — it costs nothing.
          </div>
        )}

        {loading && messages.length === 0 && <div style={styles.empty}>Loading messages…</div>}
        {!loading && messages.length === 0 && <div style={styles.empty}>No messages yet. Ask away.</div>}

        {messages.map(message => (
          <article key={`${message.id}-${message.txHash}`} style={styles.message}>
            <div style={styles.meta}>
              <span style={styles.author}>{shortenAddress(message.author)}</span>
              <span style={styles.time}>{formatRelativeTime(message.timestamp)}</span>
            </div>
            <p style={styles.text}>{message.message}</p>
          </article>
        ))}
      </div>

      <footer style={styles.footer}>
        <textarea
          style={styles.input}
          value={draft}
          placeholder="Describe your issue…"
          aria-label="Your message"
          onChange={event => setDraft(event.target.value)}
        />

        <div style={styles.actions}>
          <span style={styles.counter}>
            {bytes} / {MAX_MESSAGE_BYTES}
          </span>
          <button
            type="button"
            style={{ ...styles.send, ...(canSend ? null : styles.sendDisabled) }}
            disabled={!canSend}
            onClick={submit}
          >
            {sending ? 'Signing…' : 'Send on-chain'}
          </button>
        </div>

        {error && (
          <p style={{ ...styles.status, color: COLORS.danger }} role="alert">
            {error}
          </p>
        )}

        {!error && lastTxHash && (
          <p style={{ ...styles.status, color: COLORS.success }} role="status">
            Sent.{' '}
            <a style={styles.link} href={`${explorerUrl()}/tx/${lastTxHash}`} target="_blank" rel="noopener noreferrer">
              View on Celoscan
            </a>
          </p>
        )}

        <p style={styles.disclaimer}>
          Public and permanent. Never post wallet addresses, transaction IDs or personal details here — use Telegram for
          anything private.
        </p>
      </footer>
    </section>
  )
}

export default SupportChat
