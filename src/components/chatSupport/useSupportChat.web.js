/**
 * State for the on-chain support chat: reads `MessagePosted` events straight
 * from Celo and sends new messages through the app's own wallet, so every
 * signing path the app supports (Torus, WalletConnect, injected) keeps working
 * without a second signer implementation here.
 *
 * There is no backend and no database: the chain is the source of truth and the
 * panel only ever reads a bounded window of recent blocks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import Config from '../../config/config'
import logger from '../../lib/logger/js-logger'
import { useWallet } from '../../lib/wallet/GoodWalletProvider'

import SUPPORT_CHAT_ABI from './supportChatAbi.json'
import {
  ERROR_MESSAGES,
  ESTIMATE_SAMPLE,
  MESSAGES_POLL_MS,
  POST_COOLDOWN_SECONDS,
  dedupeAndSortMessages,
  describeSendError,
  estimateCostWei,
  formatCeloFromWei,
  isBalanceTooLow,
  isContractAddress,
  mapEventToMessage,
  resolveScanWindow,
  sanitizeMessage,
  validateMessage,
} from './supportChatUtils'

const log = logger.child({ from: 'useSupportChat' })

const EMPTY_COST = { gasUnits: 0, gasPriceWei: '0', wei: '0', celo: '0' }

export const useSupportChat = ({ open = false } = {}) => {
  const wallet = useWallet()
  const account = (wallet && wallet.account) || ''
  const contractAddress = Config.supportChatContract
  const deployBlock = Config.supportChatDeployBlock

  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [lastTxHash, setLastTxHash] = useState('')
  const [cost, setCost] = useState(EMPTY_COST)
  const [balanceWei, setBalanceWei] = useState('0')
  const [cooldownUntil, setCooldownUntil] = useState(0)

  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const configured = isContractAddress(contractAddress)
  const enabled = configured && Boolean(account) && Boolean(wallet && wallet.wallet)

  const contract = useMemo(() => {
    if (!enabled) return null

    try {
      return new wallet.wallet.eth.Contract(SUPPORT_CHAT_ABI, contractAddress)
    } catch (exception) {
      log.warn('could not create the contract instance', exception.message, exception)

      return null
    }
  }, [enabled, wallet, contractAddress])

  const refresh = useCallback(async () => {
    if (!contract) return

    setLoading(true)

    try {
      const latestBlock = await wallet.wallet.eth.getBlockNumber()
      const { ranges } = resolveScanWindow({ latestBlock, deployBlock })
      const events = []

      for (const [fromBlock, toBlock] of ranges) {
        // eslint-disable-next-line no-await-in-loop
        const chunk = await contract.getPastEvents('MessagePosted', { fromBlock, toBlock })

        events.push(...chunk)
      }

      if (!mounted.current) return

      setMessages(dedupeAndSortMessages(events.map(mapEventToMessage)))
      setError('')
    } catch (exception) {
      log.warn('could not load support messages', exception.message, exception)

      if (mounted.current) setError(describeSendError(exception))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [contract, wallet, deployBlock])

  const refreshCost = useCallback(async () => {
    if (!contract || !account) return

    try {
      const [gasUnits, gasPriceWei, nativeBalance] = await Promise.all([
        contract.methods.post(ESTIMATE_SAMPLE).estimateGas({ from: account }),
        wallet.wallet.eth.getGasPrice(),
        wallet.balanceOfNative(),
      ])
      const wei = estimateCostWei(gasUnits, gasPriceWei)

      if (!mounted.current) return

      setCost({
        gasUnits: Number(gasUnits),
        gasPriceWei: String(gasPriceWei),
        wei: String(wei),
        celo: formatCeloFromWei(wei),
      })
      setBalanceWei(String(nativeBalance))
    } catch (exception) {
      // A failed estimate is not an error the member can act on: the panel
      // simply keeps the last known cost.
      log.debug('could not estimate the support message cost', exception.message)
    }
  }, [contract, account, wallet])

  const send = useCallback(
    async draft => {
      const message = sanitizeMessage(draft)
      const validation = validateMessage(message)

      if (!validation.ok) {
        setError(validation.message)

        return null
      }

      if (!contract || !account) {
        setError(ERROR_MESSAGES.unknown)

        return null
      }

      if (Date.now() < cooldownUntil) {
        setError(ERROR_MESSAGES.cooldown)

        return null
      }

      setSending(true)
      setError('')

      try {
        const method = contract.methods.post(message)
        const receipt = await wallet.sendTransaction(method, {
          onTransactionHash: hash => {
            if (mounted.current) setLastTxHash(hash)
          },
        })

        if (mounted.current) {
          setCooldownUntil(Date.now() + POST_COOLDOWN_SECONDS * 1000)
          setLastTxHash((receipt && receipt.transactionHash) || '')
        }

        await refresh()

        return receipt || true
      } catch (exception) {
        log.warn('support message failed', exception.message, exception)

        if (mounted.current) setError(describeSendError(exception))

        return null
      } finally {
        if (mounted.current) setSending(false)
      }
    },
    [contract, account, wallet, cooldownUntil, refresh],
  )

  // First paint + every time the panel is opened.
  useEffect(() => {
    if (!open || !enabled) return

    refresh()
    refreshCost()
  }, [open, enabled, refresh, refreshCost])

  // Light polling while the panel is visible; never while the tab is hidden.
  useEffect(() => {
    if (!open || !enabled) return undefined

    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

      refresh()
    }, MESSAGES_POLL_MS)

    return () => clearInterval(timer)
  }, [open, enabled, refresh])

  return {
    enabled,
    configured,
    account,
    messages,
    loading,
    sending,
    error,
    lastTxHash,
    cost,
    balanceWei,
    cooldownUntil,
    balanceTooLow: isBalanceTooLow(balanceWei, cost.wei),
    refresh,
    refreshCost,
    send,
  }
}

export default useSupportChat
