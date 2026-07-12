import { useState, useEffect, useRef } from "react";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import arbitrumSvg from "../assets svg/1225_Arbitrum_Logomark_FullColor_ClearSpace.svg";
import "./ConnectButton.css";

const SUPPORTED_CHAIN_ID = arbitrumSepolia.id; // 421614

export default function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [showWalletPicker, setShowWalletPicker] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showChainMenu, setShowChainMenu] = useState(false);
  const [isManualConnect, setIsManualConnect] = useState(false);
  const hasShownConfirm = useRef(false);

  const isWrongChain = isConnected && chainId !== SUPPORTED_CHAIN_ID;

  // Show confirmation only on auto-reconnect (page load with existing session)
  useEffect(() => {
    if (isConnected && !hasShownConfirm.current && !isManualConnect) {
      setShowConfirm(true);
      hasShownConfirm.current = true;
    }
    if (isConnected && isManualConnect) {
      hasShownConfirm.current = true;
      setIsManualConnect(false);
    }
  }, [isConnected, isManualConnect]);

  // Get unique connectors (filter duplicates by name)
  const uniqueConnectors = connectors.reduce((acc, connector) => {
    if (!acc.find((c) => c.name === connector.name)) {
      acc.push(connector);
    }
    return acc;
  }, []);

  const handleConnectClick = () => {
    setIsManualConnect(true);
    if (uniqueConnectors.length === 1) {
      connect({ connector: uniqueConnectors[0] });
    } else {
      setShowWalletPicker(true);
    }
  };

  const handleSelectWallet = (connector) => {
    setIsManualConnect(true);
    connect({ connector });
    setShowWalletPicker(false);
  };

  const handleSwitchChain = () => {
    switchChain({ chainId: SUPPORTED_CHAIN_ID });
    setShowChainMenu(false);
  };

  if (isPending) {
    return (
      <div className="connect-wrapper">
        <button
          onClick={() => {
            disconnect();
            setShowWalletPicker(false);
          }}
          className="connect-btn connecting"
        >
          <div className="connect-spinner" />
          Connecting...
          <span className="connect-cancel">Cancel</span>
        </button>
      </div>
    );
  }

  if (isConnected) {
    return (
      <div className="connect-wrapper">
        <div className="connect-connected">
          {/* Chain indicator */}
          <div className="connect-chain-wrapper">
            <button
              className={`connect-chain-btn ${isWrongChain ? "wrong" : ""}`}
              onClick={() => setShowChainMenu(!showChainMenu)}
            >
              <img src={arbitrumSvg} alt="Arbitrum" className="connect-chain-icon" />
              <svg
                className={`connect-chain-chevron ${showChainMenu ? "open" : ""}`}
                width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
              >
                <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
              </svg>
            </button>
            {showChainMenu && (
              <>
                <div className="wallet-picker-overlay" onClick={() => setShowChainMenu(false)} />
                <div className="connect-chain-menu">
                  <div className="connect-chain-menu-title">Network</div>
                  <button
                    className={`connect-chain-option ${!isWrongChain ? "active" : ""}`}
                    onClick={handleSwitchChain}
                  >
                    <img src={arbitrumSvg} alt="Arbitrum" className="connect-chain-option-icon" />
                    <span>Arbitrum Sepolia</span>
                    {!isWrongChain && <span className="connect-chain-check">&#10003;</span>}
                  </button>
                  {isWrongChain && (
                    <div className="connect-chain-warning">
                      Wrong network. Switch to Arbitrum Sepolia.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="connect-address">
            <div className={`connect-dot ${isWrongChain ? "wrong" : ""}`} />
            <span className="connect-addr-text">
              {address.slice(0, 6)}...{address.slice(-4)}
            </span>
          </div>
          <button
            onClick={() => disconnect()}
            className="connect-disconnect-btn"
          >
            Disconnect
          </button>
        </div>

        {/* Post-connect confirmation */}
        {showConfirm && (
          <>
            <div
              className="wallet-picker-overlay"
              onClick={() => {
                disconnect();
                setShowConfirm(false);
              }}
            />
            <div className="connect-confirm">
              <div className="connect-confirm-icon">
                <div className="connect-confirm-dot" />
              </div>
              <div className="connect-confirm-title">Welcome back</div>
              <div className="connect-confirm-addr">
                {address.slice(0, 6)}...{address.slice(-4)}
              </div>
              <div className="connect-confirm-text">
                Your wallet is still connected. Stay connected?
              </div>
              <div className="connect-confirm-actions">
                <button
                  className="connect-confirm-btn stay"
                  onClick={() => setShowConfirm(false)}
                >
                  Stay Connected
                </button>
                <button
                  className="connect-confirm-btn leave"
                  onClick={() => {
                    disconnect();
                    setShowConfirm(false);
                  }}
                >
                  Disconnect
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="connect-wrapper">
      <button onClick={handleConnectClick} className="connect-btn primary">
        Connect Wallet
      </button>

      {/* Wallet picker modal */}
      {showWalletPicker && (
        <>
          <div
            className="wallet-picker-overlay"
            onClick={() => setShowWalletPicker(false)}
          />
          <div className="wallet-picker">
            <div className="wallet-picker-header">
              <span className="wallet-picker-title">Connect Wallet</span>
              <button
                className="wallet-picker-close"
                onClick={() => setShowWalletPicker(false)}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                </svg>
              </button>
            </div>
            <div className="wallet-picker-list">
              {uniqueConnectors.map((connector) => (
                <button
                  key={connector.uid}
                  className="wallet-picker-item"
                  onClick={() => handleSelectWallet(connector)}
                >
                  {connector.icon ? (
                    <img
                      src={connector.icon}
                      alt={connector.name}
                      className="wallet-picker-icon"
                    />
                  ) : (
                    <div className="wallet-picker-icon-fallback">
                      {connector.name.charAt(0)}
                    </div>
                  )}
                  <span className="wallet-picker-name">{connector.name}</span>
                  <svg
                    className="wallet-picker-arrow"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
