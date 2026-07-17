import { BrowserRouter, Routes, Route, NavLink, useLocation } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "./config/wagmi";
import ConnectButton from "./components/ConnectButton";
import StaggeredMenu from "./components/StaggeredMenu";
import Noxus from "./components/Noxus";
import ResourcesPage from "./components/ResourcesPage";
import TeamPage from "./components/TeamPage";
import Plasma from "./components/Plasma";
import "./App.css";

const queryClient = new QueryClient();

function AppContent() {
  const location = useLocation();
  const isFullWidth = ["/resources", "/team"].includes(
    location.pathname
  );

  return (
    <>
      {/* Background */}
      <div className="app-bg">
        <Plasma
          color="#F5D64B"
          speed={0.6}
          direction="forward"
          scale={1.1}
          opacity={0.8}
          mouseInteractive={true}
        />
        <div className="app-bg-overlay" />
      </div>

      {/* Content */}
      <div className="app-content">
        {/* Header */}
        <header className="app-header">
          <NavLink to="/" className="app-logo">
            <span className="app-logo-text"><span className="app-logo-brace">{"{"}</span>Noxus<span className="app-logo-brace">{"}"}</span></span>
          </NavLink>

          <div className="app-header-right">
            <ConnectButton />
            <StaggeredMenu />
          </div>
        </header>

        {/* Main */}
        <main className={`app-main ${isFullWidth ? "top-align" : ""}`}>
          <Routes>
            <Route path="/" element={<Noxus />} />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="/team" element={<TeamPage />} />
          </Routes>
        </main>

        {/* Footer */}
        <footer className="app-footer">
          <div className="app-footer-socials">
            {/* X / Twitter */}
            <a href="https://x.com/aiden_7788" className="app-footer-social" title="X" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M13.6823 10.6218L20.2391 3H18.6854L12.9921 9.61788L8.44486 3L3.2002 3L10.0765 13.0074L3.2002 21H4.75404L10.7663 14.0113L15.5685 21H20.8132L13.6819 10.6218H13.6823ZM11.5541 13.0956L10.8574 12.0991L5.31391 4.16971H7.70053L12.1742 10.5689L12.8709 11.5655L18.6861 19.8835H16.2995L11.5541 13.096V13.0956Z" />
              </svg>
            </a>
            {/* Telegram */}
            <a href="https://web.telegram.org/k/#@iexec_rlc_official" className="app-footer-social" title="Telegram" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM16.64 8.8C16.49 10.38 15.84 14.22 15.51 15.99C15.37 16.74 15.09 16.99 14.83 17.02C14.25 17.07 13.81 16.64 13.25 16.27C12.37 15.69 11.87 15.33 11.02 14.77C10.03 14.12 10.67 13.76 11.24 13.18C11.39 13.03 13.95 10.7 14 10.49C14.0069 10.4582 14.006 10.4252 13.9973 10.3938C13.9886 10.3624 13.9724 10.3337 13.95 10.31C13.89 10.26 13.81 10.28 13.74 10.29C13.65 10.31 12.25 11.24 9.52 13.08C9.12 13.35 8.76 13.49 8.44 13.48C8.08 13.47 7.4 13.28 6.89 13.11C6.26 12.91 5.77 12.8 5.81 12.45C5.83 12.27 6.08 12.09 6.55 11.9C9.47 10.63 11.41 9.79 12.38 9.39C15.16 8.23 15.73 8.03 16.11 8.03C16.19 8.03 16.38 8.05 16.5 8.15C16.6 8.23 16.63 8.34 16.64 8.42C16.63 8.48 16.65 8.66 16.64 8.8Z" />
              </svg>
            </a>
            {/* GitHub */}
            <a href="https://github.com/aydi26/iexec_WTF" className="app-footer-social" title="GitHub" target="_blank" rel="noreferrer">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
            </a>
          </div>
          <span className="app-footer-text">
            Confidential cross-chain USDC settlement — amounts never touch the chain
          </span>
        </footer>
      </div>
    </>
  );
}

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppContent />
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;
