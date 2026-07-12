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
      body: "{HyperSecret} is an anonymous deposit protocol for Hyperliquid Testnet, powered by iExec TEE (Trusted Execution Environment) on Arbitrum Sepolia. It allows users to deposit USDC2 into a vault on-chain and have it bridged anonymously to any address on Hyperliquid Testnet, without anyone being able to link the initial deposit to the final destination.",
      subsections: [
        {
          title: "Prerequisites",
          items: [
            "A wallet with ETH on Arbitrum Sepolia",
            "USDC2 tokens on Arbitrum Sepolia (withdraw from Hyperliquid Testnet)",
            "A Hyperliquid Testnet destination address",
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
        label: "1. Deposit USDC",
        content: {
          title: "Deposit USDC2",
          body: "Approve and deposit USDC2 into the PrivacyVault smart contract on Arbitrum Sepolia.",
          subsections: [
            {
              title: "Details",
              items: [
                "Minimum deposit: 5 USDC2",
                "Requires a prior ERC20 approve() transaction",
                "USDC2 uses 6 decimals (5 USDC2 = 5,000,000 wei)",
                "Deposits are tracked on-chain for emergency withdrawal",
              ],
            },
          ],
        },
      },
      {
        id: "submit-intent",
        label: "2. Submit Intent",
        content: {
          title: "Submit Encrypted Intent",
          body: "Your Hyperliquid destination address is encrypted and submitted to iExec's TEE (SGX enclave). Nobody can read it outside the enclave.",
          subsections: [
            {
              title: "Execution Modes",
              items: [
                "iExec TEE: Production mode, intent encrypted via iExec SDK",
                "Fallback Server: Demo/testing mode when iExec workerpool is unavailable",
              ],
            },
          ],
        },
      },
      {
        id: "tee-processing",
        label: "3. TEE Processing",
        content: {
          title: "TEE Processing",
          body: "Inside the TEE, a fresh wallet is generated. The vault redistributes your USDC2 to this fresh wallet, which then bridges to Hyperliquid and forwards to your destination.",
          subsections: [
            {
              title: "Execution Steps",
              items: [
                "Generate a fresh random wallet (ethers.Wallet.createRandom)",
                "Call redistribute() on the vault to send USDC2 to the fresh wallet",
                "Fund the fresh wallet with ~0.001 ETH for gas",
                "Fresh wallet bridges USDC2 to Hyperliquid via the HL bridge contract",
                "Poll Hyperliquid API until USDC is credited (~60 seconds)",
                "Sign EIP-712 usdSend to transfer from fresh wallet to your HL destination",
              ],
            },
          ],
        },
      },
      {
        id: "receive",
        label: "4. Receive on HL",
        content: {
          title: "Receive on Hyperliquid Testnet",
          body: "The fresh wallet transfers USDC to your destination address on Hyperliquid Testnet via EIP-712 signed usdSend. No link to your original deposit exists anywhere on-chain.",
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
      body: "The protocol operates across three domains: Arbitrum Sepolia (user deposits), iExec TEE (SGX enclave for private processing), and Hyperliquid Testnet (final destination). The TEE ensures that the mapping between deposit and destination is never exposed.",
      table: [
        { label: "Smart Contract", value: "PrivacyVault.sol (Solidity 0.8.20, OpenZeppelin 5.x)" },
        { label: "TEE Runtime", value: "Node.js + ethers.js v6, running in iExec SGX/TDX enclave" },
        { label: "Frontend", value: "React 19, Vite, wagmi, viem, @tanstack/react-query" },
        { label: "Bridge", value: "Hyperliquid Testnet bridge + EIP-712 usdSend" },
      ],
    },
  },
  {
    id: "smart-contract",
    label: "Smart Contract",
    category: "Technical",
    content: {
      title: "Smart Contract",
      body: "The PrivacyVault contract has three main functions:",
      table: [
        { label: "deposit(amount)", value: "User deposits USDC2 (min 5). Requires prior ERC20 approve()." },
        { label: "redistribute(recipients, amounts)", value: "TEE-only function (REDISTRIBUTOR_ROLE). Sends USDC2 from vault to fresh wallets." },
        { label: "emergencyWithdraw()", value: "Safety net allowing users to recover deposited USDC2 if the TEE is unavailable." },
      ],
    },
  },
  {
    id: "network-config",
    label: "Network Configuration",
    category: "Reference",
    content: {
      title: "Network Configuration",
      table: [
        { label: "Chain", value: "Arbitrum Sepolia (Chain ID: 421614)" },
        { label: "PrivacyVault", value: "0xa285D070351aEAF4865923e4B88C51E63283aD84" },
        { label: "USDC2 Contract", value: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5 (6 decimals)" },
        { label: "HL Bridge", value: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89" },
        { label: "HL API", value: "api.hyperliquid-testnet.xyz" },
        { label: "USDC2 Source", value: "Withdraw from Hyperliquid Testnet (drip faucet → withdraw)" },
        { label: "ETH Faucet", value: "faucets.chain.link/arbitrum-sepolia" },
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
          title: "Warnings",
          items: [
            "Minimum deposit on Hyperliquid Testnet is 5 USDC2. Below this, funds are lost forever.",
            "USDC2 uses 6 decimals, not 18. 5 USDC2 = 5,000,000 in raw units.",
            "The Hyperliquid bridge takes approximately 60 seconds to process.",
            "The EIP-712 signatureChainId must be 0x66eee (421614 hex) or usdSend fails silently.",
            "Fresh wallets need ~0.001 ETH for gas to call the bridge contract.",
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
            Start Bridging
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
