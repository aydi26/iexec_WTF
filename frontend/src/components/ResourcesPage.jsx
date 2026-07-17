import { useState, useRef, useEffect } from "react";
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
      body: "Noxus is a confidential cross-chain USDC settlement layer over Circle CCTP V2, using iExec Nox (encrypted ERC-7984 handles + TEE) as the privacy layer. The app is a single bridge widget: you enter an amount and a destination, and everything — wrapping USDC into confidential cUSDC, batching, the CCTP bridge, the TEE integrity check and the confidential distribution — runs in the background, driven entirely from your browser. Individual amounts never touch the blockchain; only the batch aggregate is ever public. Positioning: confidentiality, not anonymity — participants are visible, amounts are not.",
      subsections: [
        {
          title: "Prerequisites",
          items: [
            "A wallet (e.g. MetaMask) connected to Ethereum Sepolia",
            "Testnet USDC on Ethereum Sepolia (get it from faucet.circle.com) — the widget wraps it into cUSDC for you",
            "A little ETH for gas on BOTH Ethereum Sepolia and Arbitrum Sepolia",
            "During the bridge your wallet switches networks a few times — approve each prompt",
          ],
        },
        {
          title: "The k=3 batch (why a little extra)",
          items: [
            "Privacy needs a crowd: a batch must have at least 3 depositors to hide any single amount",
            "So your transfer is bundled with 2 tiny automatic filler transfers back to yourself",
            "The fillers cost a little extra USDC up front and are returned to you as cUSD on Arbitrum",
            "You only enter your amount + destination — the fillers are handled in the background",
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
          body: "On Ethereum Sepolia, you wrap USDC into confidential cUSDC (ERC-7984), then deposit an amount that is encrypted client-side before it ever touches the chain. On-chain, observers see that you deposited — but never how much.",
          subsections: [
            {
              title: "What happens",
              items: [
                "approve USDC, then wrap it into cUSDC (confidential ERC-7984 token)",
                "setOperator authorizes the Batcher to pull your encrypted balance",
                "Your amount is encrypted in the browser via the Nox handle SDK",
                "deposit() adds your encrypted amount to the epoch's encrypted sum",
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
          body: "CCTP V2 Fast Transfer mints A on Arbitrum Sepolia (~8-20s). Before any money moves, an on-chain, TEE-verified integrity check confirms that the sum of the (still-encrypted) destination claims equals the bridged aggregate A. This is what makes cheating detectable.",
          subsections: [
            {
              title: "The check",
              items: [
                "Each depositor pre-registers their confidential destination claim on Arbitrum (own tx)",
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
      body: "Noxus spans two chains and calls two unmodified official protocols. The source leg batches confidential deposits on Ethereum Sepolia; the destination leg verifies and distributes on Arbitrum Sepolia. Circle CCTP V2 does the actual bridging; iExec Nox provides the encrypted handles, the TEE compute, and the on-chain ACL. Neither protocol is modified — Noxus only calls them.",
      table: [
        { label: "Source leg", value: "NoxusBatcher.sol on Ethereum Sepolia" },
        { label: "Destination leg", value: "NoxusDistributor.sol on Arbitrum Sepolia" },
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
      body: "Three authored contracts, plus the unmodified CCTP V2 and NoxCompute deployments. Every function is permissionless (guarded by state + on-chain proof verification, not caller identity); the keeper is just whoever bothers to advance the epoch.",
      table: [
        { label: "NoxusBatcher", value: "deposit / withdrawDeposit / closeEpoch / settleEpoch / relayRefund / grantAuditor" },
        { label: "NoxusDistributor", value: "preRegister / relayReceive / checkEpoch / finalizeEpoch / fallback + refund" },
        { label: "NoxusCUSDC", value: "Confidential USDC wrapper: wrap / unwrap / confidentialTransfer" },
        { label: "Integrity", value: "3 reveal sites only; no plaintext amount in events; no branching on encrypted data" },
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
      title: "Live Deployments (Sourcify-verified)",
      table: [
        { label: "Ethereum Sepolia", value: "Chain ID 11155111 · CCTP domain 0" },
        { label: "NoxusBatcher (ETH)", value: "0x814a70961395218365DA5892F5de768a9Ed84E37" },
        { label: "NoxusCUSDC (ETH)", value: "0x47d150572dFCEB75C27b6dDf5EADc4D6fa33e41C" },
        { label: "Arbitrum Sepolia", value: "Chain ID 421614 · CCTP domain 3" },
        { label: "NoxusDistributor (Arb)", value: "0x410195cF6137661B066d4264515C6dc9b860ECFA" },
        { label: "NoxusCUSDC (Arb)", value: "0xD74A1F2bF0285Dc64F7855D0233E774772Ab0209" },
        { label: "CCTP TokenMessengerV2", value: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA (both chains)" },
        { label: "CCTP MessageTransmitterV2", value: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 (both chains)" },
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
            "USDC uses 6 decimals — 1 USDC = 1,000,000 raw units",
            "closeEpoch requires at least minDepositors (default 3) to preserve k-anonymity",
            "The ENTIRE bridge runs in your browser from the single widget — deposits, batching, CCTP bridge, TEE check and distribution; your wallet switches between Ethereum and Arbitrum Sepolia along the way",
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
  const [open, setOpen] = useState(false);
  const hasChildren = item.children && item.children.length > 0;
  const isActive = item.id === activeId;
  const hasActiveChild = hasChildren && item.children.some(
    (c) => c.id === activeId || (c.children && c.children.some((cc) => cc.id === activeId))
  );

  useEffect(() => {
    if (hasActiveChild) setOpen(true);
  }, [hasActiveChild]);

  if (hasChildren) {
    return (
      <li>
        <button
          className={`docs-sidebar-btn ${hasActiveChild ? "has-active" : ""}`}
          onClick={() => setOpen((o) => !o)}
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
              <span className="docs-table-value">{row.value}</span>
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
            Open the App
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
