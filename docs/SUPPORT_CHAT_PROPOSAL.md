# On-chain support chat — proposal and as-built record

Status: **implemented** (GoodDAPP-Betz). Ownerless contract + a floating widget.
No backend, no database, no bot, no server-side key.

## 1. What was asked

A support chat inside the wallet that is only visible **after a wallet is
connected**, where a member can send a message. Because the app already runs on
Celo and the owner wanted to stay "web3 style", the message itself is an
**on-chain transaction** the member signs and pays for.

Because a paid message is not always what a member wants, the widget also shows
a permanent invitation to the **free Telegram support group**. That is the whole
design: pay a few centavos to post here, or get help for free in Telegram.

## 2. Decision

Option **A** of the three considered (see the conversation record):

| Option | Verdict |
| --- | --- |
| **A. On-chain chat + Telegram link** | **Chosen.** No DB, no backend, no cursor, no bot. |
| B. Telegram bridge (widget ↔ group) | Rejected for v1: needs a server, a cursor and a database or an on-chain cursor. |
| C. Hosted widget (Crisp/Tawk) | Rejected: third-party script, data leaves the app, no wallet gate. |

## 3. Architecture

```
member's wallet ──signs──► SupportChat.post(text)  ──event──►  Celo
                                  │
                       MessagePosted(id, author, text, ts)
                                  │
              widget reads events (bounded window, public RPC)
```

- **Reads** use `getPastEvents` over a bounded block window; there is no indexer
  and no cache. The deploy block (when configured) is the floor, so a fresh
  deployment never scans empty history.
- **Writes** go through `goodWallet.sendTransaction`, which is the app's existing
  signing path (Torus, WalletConnect, injected). No second signer implementation
  exists here, so every login method keeps working.
- **Nothing is stored off-chain.** The chain is the record; Telegram is the
  free alternative for anything private.

## 4. Contract (`contracts/SupportChat.sol`)

```solidity
event MessagePosted(uint256 indexed id, address indexed author, string message, uint256 timestamp);
function post(string calldata message) external returns (uint256 id);
```

| Property | Value | Why |
| --- | --- | --- |
| `MAX_MESSAGE_BYTES` | 1000 (UTF-8 bytes) | bounds calldata and gas |
| `POST_COOLDOWN_SECONDS` | 15 per wallet | replaces moderation for the cheapest abuse |
| Storage | one `mapping(address => uint256)` + `nextId` | messages live in the event only |
| Owner / pause / delete / upgrade | **none** | nobody can rewrite or remove a message |

The absence of an owner is deliberate: it is what makes the widget's promise
("public and permanent") true, and it removes any key we would have to protect.
The cost is that spam cannot be deleted — see §7.

Measured on an in-memory EVM (solc 0.8.24, optimizer 200 runs):

| Action | Gas |
| --- | --- |
| Deploy | 254,286 (one-time) |
| `post` (short message) | **52,303** |

At the Celo gas price measured on 2026-11-22 (202.51 gwei, CELO ≈ ₱3.49):

| | CELO | ≈ PHP |
| --- | --- | --- |
| One short message | 0.0106 | ₱0.037 |
| One maximum-length message (~1000 bytes) | ~0.017 | ~₱0.06 |
| One-time deploy | 0.0515 | ₱0.18 |

## 5. Files

| File | Purpose |
| --- | --- |
| `contracts/SupportChat.sol` | the contract |
| `contracts/SupportChat.abi.json`, `contracts/SupportChat.bin` | committed artifacts (no toolchain needed to deploy) |
| `scripts/compile-support-chat.js` | recompiles with `npx solc@0.8.24` and refreshes all three artifact copies |
| `scripts/deploy-support-chat.js` | one-shot deploy, prints the env lines |
| `src/components/chatSupport/SupportChat.web.jsx` | the widget |
| `src/components/chatSupport/SupportChat.native.jsx` | no-op for native builds |
| `src/components/chatSupport/useSupportChat.web.js` | state: read window, estimate, send |
| `src/components/chatSupport/supportChatUtils.js` | pure helpers (tested) |
| `src/components/chatSupport/supportChatAbi.json` | ABI used by the app |
| `src/components/chatSupport/__tests__/supportChatUtils.test.js` | unit tests |
| `src/mainApp/App.jsx` | mounts `<SupportChat />` inside `AppContext` |
| `src/config/config.js` | `supportChatContract`, `supportChatDeployBlock`, `supportChatTelegramUrl` |

## 6. Environment variables (Vercel → Environment Variables → Redeploy)

```bash
# required for the widget to appear at all
REACT_APP_SUPPORT_CHAT_CONTRACT=0x...          # printed by the deploy script
REACT_APP_SUPPORT_CHAT_DEPLOY_BLOCK=12345678   # printed by the deploy script (optional, faster first load)
REACT_APP_SUPPORT_TG_URL=https://t.me/GoodDollarX
```

Vite bakes `REACT_APP_*` values into the bundle at **build** time, so a change
needs a **redeploy**, not a restart. Leaving `REACT_APP_SUPPORT_CHAT_CONTRACT`
empty hides the widget completely — that is the kill switch.

## 7. Privacy and risks (read before enabling)

1. **Public and permanent.** Anyone can read the chain forever; there is no
   delete. The widget warns before the first post and tells members to use
   Telegram for wallet addresses, transaction IDs and personal details.
2. **Spam cannot be removed.** The cooldown and the byte cap are the only
   defences. Adding ban/pause would require an owner and a redeploy, and would
   break the "nobody can remove your message" guarantee.
3. **The member pays.** With 0 CELO the transaction fails. The widget checks the
   native balance first and points at Telegram instead of letting the wallet
   fail.
4. **History is a window, not an archive.** The panel reads recent blocks
   (`DEFAULT_SCAN_WINDOW_BLOCKS` = 6000, four chunks max). Older messages stay on
   chain and on Celoscan, but the panel will not show them. A full archive needs
   an indexer, which would reintroduce the database this design avoids.
5. **No replies in the widget.** Support answers happen in Telegram. The widget
   is a public board, not a ticket system.

## 8. Deploying

```bash
# 1. compile (only when the contract changes)
node scripts/compile-support-chat.js

# 2. deploy once, from a wallet that holds a few centavos of CELO
SUPPORT_CHAT_DEPLOY_KEY=0x... node scripts/deploy-support-chat.js

# 3. paste the two printed lines into Vercel, then redeploy
```

## 9. Testing

```bash
npx prettier --check "src/components/chatSupport/**/*.{js,jsx}"
npx jest src/components/chatSupport     # after `yarn install`
```

Verified for this change:

- 18 unit assertions on the pure helpers (byte counting, sanitising, cost maths,
  scan windowing, event mapping, error copy).
- The compiled bytecode deployed and driven on an in-memory EVM: post emits the
  event with the right id/author/text, the cooldown reverts for the same wallet
  and not for another, empty and over-long messages revert, and unicode plus
  newlines survive.
- `prettier --check` clean, esbuild parse clean on every touched file.

## 10. Rollback

Clear `REACT_APP_SUPPORT_CHAT_CONTRACT` and redeploy. The widget disappears; the
contract stays readable on Celoscan but is no longer reachable from the app.
