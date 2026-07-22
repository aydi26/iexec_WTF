import { useState } from "react";
import { Link } from "react-router-dom";
import "./ResourcesPage.css";

const ChevronIcon = ({ open }) => (
  <svg
    viewBox="0 0 24 24"
    stroke="currentColor"
    fill="none"
    strokeWidth="2"
    className={`docs-chevron ${open ? "open" : ""}`}
  >
    <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ===== DOCS DATA ===== */
const docsTree = [
  {
    id: "getting-started",
    label: "Getting Started",
    category: "Protocol",
    content: {
      title: "Getting Started",
      body: "Noxus is a confidential cross-chain USDC settlement layer over Circle CCTP V2, using iExec Nox (encrypted ERC-7984 handles + TEE) as the privacy layer. The app is a single bridge widget: you enter an amount and a destination — your own address or ANY other address — and everything (wrapping USDC into confidential cUSDC, batching, the CCTP bridge, the TEE integrity check and the confidential distribution) runs in the background: you sign only your own deposit steps, the operator's serverless keeper drives the rest, and your browser can run every step itself if the keeper is ever unreachable. The bridge is bidirectional: the swap arrow flips the route between Ethereum Sepolia and Arbitrum Sepolia. Individual amounts never touch the blockchain; only the batch aggregate is ever public. Positioning: confidentiality, not anonymity — participants are visible, amounts are not.",
      subsections: [
        {
          title: "Prerequisites",
          items: [
            "A wallet (e.g. MetaMask) — the header Faucet button links to every faucet you need",
            "Testnet USDC on the source chain (Circle faucet) — the widget wraps it into cUSDC for you",
            "A little ETH for gas on BOTH Ethereum Sepolia and Arbitrum Sepolia",
            "Per-bridge cap on testnet: max 1 USDC per transfer",
            "Network switching is automatic — the app moves your wallet to the right chain when needed; just approve the switch prompts",
          ],
        },
        {
          title: "The k=3 batch (why a little extra)",
          items: [
            "Privacy needs a crowd: a batch must have at least 3 deposits to hide any single amount",
            "The operator's keeper contributes the 2 filler transfers (0.5 cUSD each, from its own pre-wrapped liquidity, cycling back to the operator on the destination) within ~5 seconds of you starting a bridge — so you only sign YOUR OWN transfer",
            "If the keeper is offline or out of filler liquidity, the app falls back to self-filler mode: you provide all 3 transfers yourself — the 2 fillers cross with the batch and land back in your own wallet on the destination chain (the proven original flow)",
            "You only enter your amount + destination — the batch mechanics are handled in the background",
          ],
        },
        {
          title: "Fewer signatures",
          items: [
            "A recurring bridge is ~2 signatures: one preRegisterMany tx on the destination (all claims batched) and one depositMany tx on the source (all deposits batched) — the contracts' one-tx batch entry points collapse what used to be 6 data transactions into 2",
            "The serverless keeper contributes the 2 batch fillers AND runs the 5 permissionless back-half steps server-side — close, settle + CCTP burn, Iris attestation, relay + integrity check, finalize — so this works on ANY wallet, incl. a plain MetaMask / Rabby EOA",
            "Your first bridge adds one-time funding (max USDC approval, wrap with headroom, setOperator) for ~5 signatures total; the headroom means later bridges skip funding entirely",
            "Safe by design: the keeper's steps are gated by epoch state, the Circle attestation and the on-chain KMS proof — never by caller identity — so it can never steal funds or alter amounts; the worst it can do is not advance an epoch (you can still self-serve)",
            "On wallets that support EIP-5792 atomic batching (smart accounts), the steps you DO sign collapse further — a whole phase becomes one confirmation",
            "If the keeper is ever unreachable, the app falls back to you signing everything client-side (the proven path, ~7 confirmations thanks to the same batch entry points) — the bridge is never blocked",
          ],
        },
      ],
    },
  },
  {
    id: "how-it-works",
    label: "How It Works",
    category: "Protocol",
    children: [
      {
        id: "deposit",
        label: "1. Confidential Deposit",
        content: {
          title: "1. Confidential Deposit",
          body: "On the source chain, the widget wraps your USDC into confidential cUSDC (ERC-7984), then deposits an amount that is encrypted client-side before it ever touches the chain. On-chain, observers see that you deposited — but never how much.",
          subsections: [
            {
              title: "What happens",
              items: [
                "one-time max USDC approval to the wrapper, then wrap into cUSDC (with headroom so later bridges skip this)",
                "setOperator authorizes the Batcher to pull your encrypted balance",
                "Your amount is encrypted in the browser via the Nox handle SDK",
                "depositMany() adds your encrypted amount(s) to the epoch's encrypted sum in a single transaction",
                "The contract itself never learns your individual amount",
              ],
            },
          ],
        },
      },
      {
        id: "batch-settle",
        label: "2. Batch & Settle",
        content: {
          title: "2. Batch & Settle",
          body: "Deposits accumulate into a single encrypted sum for the epoch. When the epoch closes, only the aggregate A is revealed — one number for the whole batch — and that exact amount is bridged with a single CCTP V2 burn.",
          subsections: [
            {
              title: "Details",
              items: [
                "Your transfer + 2 automatic fillers make the batch reach the k=3 floor",
                "closeEpoch() reveals only the encrypted sum (requires >= minDepositors, default 3)",
                "settleEpoch() verifies A on-chain, unwraps exactly A, and burns via CCTP V2",
                "A (the aggregate) is the only public number — it is unavoidable, since CCTP burns a plaintext amount",
                "The burn carries the destination claim list in the CCTP hookData",
              ],
            },
          ],
        },
      },
      {
        id: "bridge-check",
        label: "3. Bridge & Integrity Check",
        content: {
          title: "3. Bridge & Integrity Check",
          body: "CCTP V2 Fast Transfer mints A on the destination chain (~8-20s). Before any money moves, an on-chain, TEE-verified integrity check confirms that the sum of the (still-encrypted) destination claims equals the bridged aggregate A. This is what makes cheating detectable.",
          subsections: [
            {
              title: "The check",
              items: [
                "The sender pre-registers every recipient's confidential destination claim in one preRegisterMany tx on the destination chain — for itself or for a third-party address",
                "Anti-squatting comes from the Nox input proof (owner-bound), not caller identity; the recipient alone can reveal or spend its claim",
                "relayReceive mints A and binds it to the source-committed claim set",
                "checkEpoch computes, in the TEE, whether Sum(claims) == A and reveals only a boolean",
                "The comparison is overflow-safe: a cheater cannot make claims wrap around to A",
              ],
            },
          ],
        },
      },
      {
        id: "distribute",
        label: "4. Distribute or Refund",
        content: {
          title: "4. Confidential Distribution (or Fallback)",
          body: "If the check passes, each recipient is confidentially credited their share — amounts stay hidden. If a depositor inflated their claim (Sum != A), the check fails, the epoch flags itself, the inconsistency is exposed by opt-in reveal, and the aggregate is bridged back so every depositor is refunded their attested source amount.",
          subsections: [
            {
              title: "Honest vs cheating",
              items: [
                "check == true: confidential cUSDC credit per recipient, amounts never revealed",
                "check == false: opt-in attribution reveal exposes Sum != A, cheater is identified",
                "Refund-to-source: A is bridged back and each depositor re-credited their attested amount",
                "The cheater cannot claim more than they deposited; cheating is detectable and unprofitable",
              ],
            },
          ],
        },
      },
    ],
  },
  {
    id: "architecture",
    label: "Architecture",
    category: "Technical",
    content: {
      title: "Architecture",
      body: "Noxus spans two chains, calls two unmodified official protocols, and runs in BOTH directions: every chain hosts a NoxusBatcher (source role) and a NoxusDistributor (destination role), so the widget's swap arrow flips the route ETH<->Arb. The source-side Batcher collects confidential deposits; the destination-side Distributor verifies and distributes. Circle CCTP V2 does the actual bridging; iExec Nox provides the encrypted handles, the TEE compute, and the on-chain ACL. Neither protocol is modified — Noxus only calls them.",
      table: [
        { label: "Source leg", value: "NoxusBatcher.sol (one per chain)" },
        { label: "Destination leg", value: "NoxusDistributor.sol (one per chain)" },
        { label: "Confidential token", value: "NoxusCUSDC (iExec ERC20ToERC7984Wrapper) on both chains" },
        { label: "Bridge", value: "Circle CCTP V2 Fast Transfer + Hooks (unmodified)" },
        { label: "Privacy layer", value: "iExec Nox: ERC-7984 handles, TEE compute, threshold-KMS reveals" },
        { label: "Frontend", value: "React 19, Vite, wagmi, viem, @iexec-nox/handle" },
      ],
    },
  },
  {
    id: "contracts",
    label: "Contracts",
    category: "Technical",
    content: {
      title: "Contracts",
      body: "Three authored contracts, plus the unmodified CCTP V2 and NoxCompute deployments. Every function is permissionless (guarded by state + on-chain proof verification, not caller identity); the keeper is just whoever bothers to advance the epoch. The one-tx batch entry points depositMany / preRegisterMany collapse the user's data transactions from 6 to 2.",
      table: [
        { label: "NoxusBatcher", value: "deposit / depositMany / withdrawDeposit / closeEpoch / settleEpoch / relayRefund / grantAuditor" },
        { label: "NoxusDistributor", value: "preRegister / preRegisterMany / relayReceive / checkEpoch / finalizeEpoch / fallback + refund" },
        { label: "NoxusCUSDC", value: "Confidential USDC wrapper: wrap / unwrap / confidentialTransfer" },
        { label: "Integrity", value: "3 reveal sites only; no plaintext amount in events; no branching on encrypted data" },
      ],
    },
  },
  {
    id: "keeper",
    label: "Keeper",
    category: "Technical",
    content: {
      title: "Keeper",
      body: "A serverless keeper (the /api/keeper endpoint on the app's own domain) runs the operator side of every bridge: it contributes the 2 batch fillers from its own pre-wrapped cUSDC within ~5 seconds of a bridge starting (they cycle back to the operator on the destination), then drives the whole permissionless back half server-side — close, settle + CCTP burn, Iris attestation, relay + integrity check, finalize.",
      subsections: [
        {
          title: "Why it cannot steal",
          items: [
            "Every step it calls is permissionless and gated by epoch state, the Circle attestation and the on-chain Nox KMS proof — never by caller identity; the keeper has no special rights on any contract",
            "It cannot redirect funds or alter amounts: recipients and encrypted claims are committed by YOUR signed pre-registration and deposit before the keeper advances anything",
            "Its dedicated key holds only gas (plus the filler cUSDC liquidity, which returns to the operator each epoch)",
            "Worst case: the keeper is down and the epoch stalls — the app falls back to client-side signing and self-filler mode, so you can always finish the bridge (or withdraw an open deposit) yourself",
          ],
        },
      ],
    },
  },
  {
    id: "privacy-model",
    label: "Privacy Model",
    category: "Technical",
    content: {
      title: "Privacy Model",
      body: "Confidentiality, not anonymity. What is hidden is amounts; what is visible is participation.",
      subsections: [
        {
          title: "Guaranteed by construction",
          items: [
            "Individual amounts are never emitted, stored, or derivable on-chain",
            "The link between source depositor and destination recipient is broken (no amount on either leg)",
            "Any single amount can be disclosed to an auditor on demand, via an on-chain ACL grant",
          ],
        },
        {
          title: "Documented, not hidden",
          items: [
            "The aggregate A is public (it is the CCTP burn amount) — privacy needs >= 2 depositors/epoch",
            "Participant sets and timing are visible — this is confidentiality, not a mixer",
            "Auditor grants are add-only on-chain (iExec Nox has no removeViewer) — see Security",
            "Confidentiality rests on the iExec Nox TEE + threshold-KMS + gateway trust model",
          ],
        },
      ],
    },
  },
  {
    id: "deployments",
    label: "Deployments",
    category: "Reference",
    content: {
      title: "Live Deployments (Sourcify-verified, bidirectional)",
      body: "Every chain hosts both roles, so the bridge runs ETH->Arb and Arb->ETH. All six Noxus contracts are Sourcify exact_match; each address below links to its explorer page.",
      table: [
        { label: "Ethereum Sepolia", value: "Chain ID 11155111 · CCTP domain 0" },
        { label: "NoxusCUSDC (ETH)", value: "0x47d150572dFCEB75C27b6dDf5EADc4D6fa33e41C", href: "https://sepolia.etherscan.io/address/0x47d150572dFCEB75C27b6dDf5EADc4D6fa33e41C" },
        { label: "NoxusBatcher (ETH, source of ETH->Arb)", value: "0x4eDbe88f04A547c20a3dfD3A7c7452479f3c7E77", href: "https://sepolia.etherscan.io/address/0x4eDbe88f04A547c20a3dfD3A7c7452479f3c7E77" },
        { label: "NoxusDistributor (ETH, dest of Arb->ETH)", value: "0xbd259Aa982aBE9E8f3f5CD28d783AB452264A539", href: "https://sepolia.etherscan.io/address/0xbd259Aa982aBE9E8f3f5CD28d783AB452264A539" },
        { label: "Arbitrum Sepolia", value: "Chain ID 421614 · CCTP domain 3" },
        { label: "NoxusCUSDC (Arb)", value: "0xD74A1F2bF0285Dc64F7855D0233E774772Ab0209", href: "https://sepolia.arbiscan.io/address/0xD74A1F2bF0285Dc64F7855D0233E774772Ab0209" },
        { label: "NoxusBatcher (Arb, source of Arb->ETH)", value: "0xAFF3778e41Df36c4895154196f7880969A1B482a", href: "https://sepolia.arbiscan.io/address/0xAFF3778e41Df36c4895154196f7880969A1B482a" },
        { label: "NoxusDistributor (Arb, dest of ETH->Arb)", value: "0xc5097a40C5Fd58E2Db5cb7989C9cBD85251583B2", href: "https://sepolia.arbiscan.io/address/0xc5097a40C5Fd58E2Db5cb7989C9cBD85251583B2" },
        { label: "CCTP TokenMessengerV2", value: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA (both chains)", href: "https://sepolia.etherscan.io/address/0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
        { label: "CCTP MessageTransmitterV2", value: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 (both chains)", href: "https://sepolia.etherscan.io/address/0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" },
        { label: "Sourcify verification", value: "Look up any of the six addresses — all exact_match", href: "https://sourcify.dev/#/lookup" },
      ],
    },
  },
  {
    id: "security",
    label: "Security",
    category: "Reference",
    content: {
      title: "Security & Trust",
      body: "Testnet-only, unaudited, hackathon software. An independent review found no way to steal funds with an honest deployer, and confirmed the encrypted integrity check cannot be passed with Sum != A.",
      subsections: [
        {
          title: "Sound by design",
          items: [
            "No fund theft possible given an honest deployer",
            "The integrity check cannot be passed with Sum != A (overflow-safe encrypted comparison)",
            "Individual amounts never appear on-chain; exactly 3 controlled reveal sites",
          ],
        },
        {
          title: "Accepted limitations (v1)",
          items: [
            "Fee buffers are an operational subsidy that must be monitored and topped up",
            "A single active epoch per Batcher; a stuck epoch has a timeout-based fallback rescue",
            "Auditor grants are irrevocable on-chain (no removeViewer in Nox) — revocation is future work",
            "Not for mainnet without a professional audit and anti-griefing economics",
          ],
        },
      ],
    },
  },
  {
    id: "important-notes",
    label: "Important Notes",
    category: "Reference",
    content: {
      title: "Important Notes",
      subsections: [
        {
          title: "Good to know",
          items: [
            "USDC uses 6 decimals — 1 USDC = 1,000,000 raw units; testnet cap: max 1 USDC per bridge",
            "closeEpoch requires at least minDepositors (default 3) to preserve k-anonymity",
            "The bridge is bidirectional — use the swap arrow to flip ETH -> Arb into Arb -> ETH",
            "The whole bridge runs from the single widget: you sign ~2 transactions (plus one-time funding on your first bridge); the serverless keeper runs the back half — close, settle + CCTP burn, attestation, relay + check, finalize — server-side, with a full client-side fallback",
            "Network switching is automatic — the app moves your wallet to the right chain at each phase",
            "The Track tab lists every bridge (both directions) that was started but is not complete yet, and the exact phase it is stuck at — refresh it any time",
            "The header Faucet button links to the Circle USDC faucet and both gas faucets",
            "CCTP Fast Transfer settles in ~8-20 seconds; the reveal round-trip via the Nox KMS is a few seconds",
            "Everything runs on real testnets with real USDC, real Iris attestations, and real Nox proofs — no mock data",
          ],
        },
      ],
    },
  },
];

/* ===== SIDEBAR NAV ITEM ===== */
function SidebarItem({ item, activeId, onSelect, depth = 0 }) {
  const [userOpen, setUserOpen] = useState(null);
  const hasChildren = item.children && item.children.length > 0;
  const isActive = item.id === activeId;
  const hasActiveChild = hasChildren && item.children.some(
    (c) => c.id === activeId || (c.children && c.children.some((cc) => cc.id === activeId))
  );
  // Open when the user toggled it open, or (untouched) when a child is active.
  const open = userOpen !== null ? userOpen : hasActiveChild;

  if (hasChildren) {
    return (
      <li>
        <button
          className={`docs-sidebar-btn ${hasActiveChild ? "has-active" : ""}`}
          onClick={() => setUserOpen(!open)}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <span>{item.label}</span>
          <ChevronIcon open={open} />
        </button>
        {open && (
          <ul className="docs-sidebar-children">
            {item.children.map((child) => (
              <SidebarItem
                key={child.id}
                item={child}
                activeId={activeId}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <button
        className={`docs-sidebar-link ${isActive ? "active" : ""}`}
        onClick={() => onSelect(item.id)}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        {item.label}
      </button>
    </li>
  );
}

/* ===== CONTENT RENDERER ===== */
function DocContent({ content }) {
  if (!content) return null;

  return (
    <div className="docs-content">
      <h1 className="docs-content-title">{content.title}</h1>

      {content.body && <p className="docs-content-body">{content.body}</p>}

      {content.subsections &&
        content.subsections.map((sub, i) => (
          <div key={i} className="docs-subsection">
            <h3 className="docs-subsection-title">{sub.title}</h3>
            {sub.items && (
              <ul className="docs-subsection-list">
                {sub.items.map((item, j) => (
                  <li key={j} className="docs-subsection-item">
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}

      {content.table && (
        <div className="docs-table">
          {content.table.map((row, i) => (
            <div key={i} className="docs-table-row">
              <span className="docs-table-label">{row.label}</span>
              {row.href ? (
                <a
                  className="docs-table-value"
                  href={row.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {row.value}
                </a>
              ) : (
                <span className="docs-table-value">{row.value}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===== FIND CONTENT BY ID ===== */
function findContent(tree, id) {
  for (const item of tree) {
    if (item.id === id) return item.content;
    if (item.children) {
      const found = findContent(item.children, id);
      if (found) return found;
    }
  }
  return null;
}

/* ===== MAIN PAGE ===== */
export default function ResourcesPage() {
  const [activeId, setActiveId] = useState("getting-started");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const content = findContent(docsTree, activeId);

  const handleSelect = (id) => {
    setActiveId(id);
    setSidebarOpen(false);
  };

  // Group items by category
  const categories = {};
  docsTree.forEach((item) => {
    const cat = item.category || "General";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(item);
  });

  return (
    <div className="docs-page">
      {/* Mobile sidebar toggle */}
      <button
        className="docs-mobile-toggle"
        onClick={() => setSidebarOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
        </svg>
        Documentation
      </button>

      {/* Sidebar */}
      <aside className={`docs-sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="docs-sidebar-header">
          <span className="docs-sidebar-title">Documentation</span>
        </div>
        <nav className="docs-sidebar-nav">
          {Object.entries(categories).map(([category, items]) => (
            <div key={category} className="docs-sidebar-category">
              <span className="docs-sidebar-category-label">{category}</span>
              <ul className="docs-sidebar-list">
                {items.map((item) => (
                  <SidebarItem
                    key={item.id}
                    item={item}
                    activeId={activeId}
                    onSelect={handleSelect}
                  />
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="docs-sidebar-cta">
          <Link to="/" className="docs-sidebar-cta-btn">
            Start bridging
          </Link>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="docs-sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="docs-main">
        <DocContent content={content} />
      </main>
    </div>
  );
}
