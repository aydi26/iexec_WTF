import { useState, useEffect, useCallback } from "react";
import {
  useAccount,
  useConnect,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { parseUnits, formatUnits } from "viem";
import {
  VAULT_ADDRESS,
  USDC_ADDRESS,
  IAPP_ADDRESS,
  IEXEC_HUB_ADDRESS,
  FALLBACK_API,
  VAULT_ABI,
  ERC20_ABI,
} from "../config/contracts";
import arbitrumSvg from "../assets svg/1225_Arbitrum_Logomark_FullColor_ClearSpace.svg";
import ElasticSlider from "./ElasticSlider";
import "./BridgeWidget.css";

/* ===== CHAIN / TOKEN LOGOS (from actual project assets) ===== */
const UsdcLogo = ({ size = 40 }) => (
  <svg width={size} height={size} viewBox="0 0 2000 2000" xmlns="http://www.w3.org/2000/svg">
    <path d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z" fill="#2775ca"/>
    <path d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z" fill="#fff"/>
    <path d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z" fill="#fff"/>
  </svg>
);

const ArbitrumLogo = ({ size = 18 }) => (
  <img src={arbitrumSvg} alt="Arbitrum" width={size} height={size} style={{ borderRadius: '50%', display: 'block' }} />
);

const HyperliquidLogo = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 144 144" xmlns="http://www.w3.org/2000/svg">
    <circle cx="72" cy="72" r="72" fill="#B0F2B6"/>
    <path d="M144 71.6991C144 119.306 114.866 134.582 99.5156 120.98C86.8804 109.889 83.1211 86.4521 64.116 84.0456C39.9942 81.0113 37.9057 113.133 22.0334 113.133C3.5504 113.133 0 86.2428 0 72.4315C0 58.3063 3.96809 39.0542 19.736 39.0542C38.1146 39.0542 39.1588 66.5722 62.132 65.1073C85.0007 63.5379 85.4184 34.8689 100.247 22.6271C113.195 12.0593 144 23.4641 144 71.6991Z" fill="#072723" transform="scale(0.65) translate(40, 40)"/>
  </svg>
);

const IEXEC_STATUS_MAP = {
  0: "UNSET",
  1: "ACTIVE",
  2: "REVEALING",
  3: "COMPLETED",
  4: "FAILED",
};

const STEPS = [
  { key: "approve", label: "Approve USDC" },
  { key: "deposit", label: "Deposit to Vault" },
  { key: "intent", label: "Submit Intent to TEE" },
  { key: "bridge", label: "Anonymous Transfer" },
];

export default function BridgeWidget() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const chainId = useChainId();
  const isWrongChain = isConnected && chainId !== arbitrumSepolia.id;

  // UI state
  const [activeTab, setActiveTab] = useState("bridge");
  const [showSettings, setShowSettings] = useState(false);
  const [showRecipient, setShowRecipient] = useState(true);
  const [amount, setAmount] = useState("");
  const [hlDestination, setHlDestination] = useState("");
  const [mode, setMode] = useState("iexec");
  const [routePriority, setRoutePriority] = useState("fastest");
  const [gasPrice, setGasPrice] = useState(50);
  const [step, setStep] = useState("input");
  const [failedAt, setFailedAt] = useState(null);
  const [error, setError] = useState(null);
  const [intentResult, setIntentResult] = useState(null);
  const [withdrawStep, setWithdrawStep] = useState("idle"); // idle | confirm | withdrawing | done

  // Status tracking
  const [trackId, setTrackId] = useState("");
  const [trackMode, setTrackMode] = useState("iexec");
  const [trackPolling, setTrackPolling] = useState(false);
  const [trackData, setTrackData] = useState(null);
  const [trackError, setTrackError] = useState(null);

  // Read USDC balance
  const { data: usdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Read existing deposit
  const { data: existingDeposit, refetch: refetchDeposit } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "deposits",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Approve tx
  const {
    writeContract: approve,
    data: approveTxHash,
    error: approveError,
    reset: resetApprove,
  } = useWriteContract();

  // Deposit tx
  const {
    writeContract: deposit,
    data: depositTxHash,
    error: depositError,
    reset: resetDeposit,
  } = useWriteContract();

  // Emergency withdraw tx
  const {
    writeContract: emergencyWithdraw,
    data: withdrawTxHash,
    isPending: isWithdrawing,
    error: withdrawError,
    reset: resetWithdraw,
  } = useWriteContract();

  // Wait for receipts
  const { isSuccess: approveConfirmed, isError: approveReverted } = useWaitForTransactionReceipt({
    hash: approveTxHash,
  });
  const { isSuccess: depositConfirmed, isError: depositReverted } = useWaitForTransactionReceipt({
    hash: depositTxHash,
  });
  const { isSuccess: withdrawConfirmed, isError: withdrawReverted } = useWaitForTransactionReceipt({
    hash: withdrawTxHash,
  });
  // After approve confirms → trigger deposit
  useEffect(() => {
    if (approveConfirmed && step === "approving") {
      const amountWei = parseUnits(amount, 6);
      deposit({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [amountWei],
      });
      setStep("depositing");
    }
  }, [approveConfirmed]);

  // After deposit confirms → submit intent
  useEffect(() => {
    if (depositConfirmed && step === "depositing") {
      setStep("submitting");
      submitIntent();
    }
  }, [depositConfirmed]);

  // Handle errors
  useEffect(() => {
    if (approveError && step === "approving") {
      setError(approveError.message?.slice(0, 150) || "Approval failed");
      setFailedAt("approve");
      setStep("failed");
    }
  }, [approveError]);

  useEffect(() => {
    if (depositError && step === "depositing") {
      setError(depositError.message?.slice(0, 150) || "Deposit failed");
      setFailedAt("deposit");
      setStep("failed");
    }
  }, [depositError]);

  // Handle on-chain reverts (tx mined but failed)
  useEffect(() => {
    if (approveReverted && step === "approving") {
      setError("Approve transaction reverted on-chain");
      setFailedAt("approve");
      setStep("failed");
    }
  }, [approveReverted]);

  useEffect(() => {
    if (depositReverted && step === "depositing") {
      setError("Deposit transaction reverted on-chain. Check that the vault address and token are correct.");
      setFailedAt("deposit");
      setStep("failed");
    }
  }, [depositReverted]);

  // After withdraw confirms
  useEffect(() => {
    if (withdrawConfirmed && withdrawStep === "withdrawing") {
      setWithdrawStep("done");
      refetchBalance();
      refetchDeposit();
      setTimeout(() => setWithdrawStep("idle"), 3000);
    }
  }, [withdrawConfirmed]);

  useEffect(() => {
    if ((withdrawError || withdrawReverted) && withdrawStep === "withdrawing") {
      setWithdrawStep("idle");
    }
  }, [withdrawError, withdrawReverted]);

  // Submit intent
  const submitIntent = async () => {
    try {
      if (mode === "fallback") {
        const res = await fetch(`${FALLBACK_API}/api/process-intent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            hlDestination,
            amount: parseFloat(amount),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Server error");

        setIntentResult({ mode: "fallback", executionId: data.executionId });
        setTrackId(data.executionId);
        setTrackMode("fallback");
        setStep("processing");
        setTrackPolling(true);
      } else {
        const { IExec } = await import("iexec");
        const iexec = new IExec(
          { ethProvider: window.ethereum },
          { hubAddress: IEXEC_HUB_ADDRESS }
        );

        const secretValue = JSON.stringify({
          destination: hlDestination,
          amount: parseFloat(amount),
          vaultAddress: VAULT_ADDRESS,
        });

        // Use unique secret index per request (iExec secrets are immutable)
        const secretIndex = Date.now().toString();
        try {
          await iexec.secrets.pushRequesterSecret(secretIndex, secretValue);
        } catch (e) {
          if (!e.message?.includes("already exists")) throw e;
          const retryIndex = (Date.now() + 1).toString();
          await iexec.secrets.pushRequesterSecret(retryIndex, secretValue);
        }

        const { orders: appOrders } =
          await iexec.orderbook.fetchAppOrderbook(IAPP_ADDRESS);
        const appOrder = appOrders[0]?.order;
        if (!appOrder) throw new Error("No app order available");

        const { orders: wpOrders } =
          await iexec.orderbook.fetchWorkerpoolOrderbook({
            category: 0,
            minTag: ["tee", "scone"],
          });
        const workerpoolOrder = wpOrders[0]?.order;
        if (!workerpoolOrder) throw new Error("No TEE workerpool order (tee,scone)");

        const requestOrderToSign = await iexec.order.createRequestorder({
          app: IAPP_ADDRESS,
          appmaxprice: appOrder.appprice,
          workerpoolmaxprice: workerpoolOrder.workerpoolprice,
          requester: await iexec.wallet.getAddress(),
          category: 0,
          volume: 1,
          tag: ["tee", "scone"],
          params: { iexec_secrets: { 1: secretIndex } },
        });

        const requestOrder =
          await iexec.order.signRequestorder(requestOrderToSign);

        const { dealid } = await iexec.order.matchOrders({
          apporder: appOrder,
          workerpoolorder: workerpoolOrder,
          requestorder: requestOrder,
        });

        const taskid = await iexec.deal.computeTaskId(dealid, 0);

        setIntentResult({ mode: "iexec", dealid, taskid });
        setTrackId(taskid);
        setTrackMode("iexec");
        setStep("processing");
        setTrackPolling(true);
      }
    } catch (err) {
      setError(err.message?.slice(0, 150) || "Intent submission failed");
      setFailedAt("intent");
      setStep("failed");
    }
  };

  // Status polling
  const pollStatus = useCallback(async () => {
    if (!trackId) return;
    try {
      if (trackMode === "fallback") {
        const res = await fetch(`${FALLBACK_API}/api/status/${trackId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Not found");

        setTrackData({
          status: data.status,
          result: data.result,
          error: data.error,
          completed: data.status === "completed",
        });

        if (data.status === "completed" || data.status === "failed") {
          setTrackPolling(false);
          setStep(data.status === "completed" ? "completed" : "failed");
          if (data.status === "failed")
            setError(data.error || "Processing failed");
        }
      } else {
        const { IExec } = await import("iexec");
        const iexec = new IExec(
          { ethProvider: window.ethereum },
          { hubAddress: IEXEC_HUB_ADDRESS }
        );
        const task = await iexec.task.show(trackId);

        const statusText = IEXEC_STATUS_MAP[task.status] || `UNKNOWN(${task.status})`;

        if (task.status === 3) {
          // Task completed - fetch result from IPFS
          let result = null;
          try {
            const response = await iexec.task.fetchResults(trackId);
            const blob = await response.blob();
            const JSZip = (await import("jszip")).default;
            const zip = await JSZip.loadAsync(blob);
            const resultFile = zip.file("result.json");
            if (resultFile) {
              const text = await resultFile.async("text");
              result = JSON.parse(text);
            }
          } catch (e) {
            console.warn("Could not fetch iExec result:", e);
          }

          setTrackData({
            status: statusText,
            raw: task,
            result,
            completed: true,
          });
          setTrackPolling(false);
          setStep("completed");
        } else if (task.status === 4) {
          setTrackData({ status: statusText, raw: task, completed: false });
          setTrackPolling(false);
          setStep("failed");
          setError("TEE task failed");
        } else {
          setTrackData({
            status: statusText,
            raw: task,
            completed: false,
          });
        }
      }
    } catch (err) {
      console.warn("Poll error (will retry):", err.message);
      // Don't stop polling on temporary errors — task may not be indexed yet
      setTrackData((prev) => prev || { status: "Waiting for task...", completed: false });
    }
  }, [trackId, trackMode]);

  useEffect(() => {
    if (!trackPolling || !trackId) return;
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [trackPolling, trackId, pollStatus]);

  // Handlers
  const handleBridge = () => {
    setError(null);
    setFailedAt(null);
    resetApprove();
    resetDeposit();
    const amountWei = parseUnits(amount, 6);
    approve({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [VAULT_ADDRESS, amountWei],
    });
    setStep("approving");
  };

  const handleReset = () => {
    setStep("input");
    setAmount("");
    setHlDestination("");
    setError(null);
    setFailedAt(null);
    setIntentResult(null);
    setTrackData(null);
    setTrackPolling(false);
    resetApprove();
    resetDeposit();
    refetchBalance();
    refetchDeposit();
  };

  const handleEmergencyWithdraw = () => {
    resetWithdraw();
    emergencyWithdraw({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "emergencyWithdraw",
    });
    setWithdrawStep("withdrawing");
  };

  const handleMaxAmount = () => {
    if (usdcBalance) setAmount(formatUnits(usdcBalance, 6));
  };

  const handleTrackSubmit = () => {
    setTrackError(null);
    setTrackData(null);
    setTrackPolling(true);
  };

  // Button state
  const getButtonConfig = () => {
    if (!isConnected) {
      return {
        text: "Connect wallet",
        disabled: false,
        variant: "primary",
        onClick: () => connect({ connector: connectors[0] }),
      };
    }
    if (isWrongChain)
      return { text: "Switch to Arbitrum Sepolia", disabled: true, variant: "secondary" };
    if (!amount || parseFloat(amount) === 0)
      return { text: "Enter an amount", disabled: true, variant: "secondary" };
    if (parseFloat(amount) < 5)
      return { text: "Minimum 5 USDC", disabled: true, variant: "secondary" };

    if (!hlDestination || !hlDestination.startsWith("0x"))
      return {
        text: "Enter destination address",
        disabled: true,
        variant: "secondary",
      };
    if (
      usdcBalance !== undefined &&
      parseUnits(amount || "0", 6) > usdcBalance
    )
      return {
        text: "Insufficient USDC balance",
        disabled: true,
        variant: "secondary",
      };
    return {
      text: "Bridge USDC",
      disabled: false,
      variant: "primary",
      onClick: handleBridge,
    };
  };

  const buttonConfig = getButtonConfig();
  const showRoute = buttonConfig.text === "Bridge USDC";

  // Step progress
  const getStepStatus = (stepKey) => {
    const order = ["approve", "deposit", "intent", "bridge"];
    const stepIndex = order.indexOf(stepKey);
    const stepMap = {
      approving: 0,
      depositing: 1,
      submitting: 2,
      processing: 3,
      completed: 4,
    };
    const currentIndex = stepMap[step];

    if (step === "failed" && failedAt) {
      const failedIndex = order.indexOf(failedAt);
      if (stepIndex < failedIndex) return "completed";
      if (stepIndex === failedIndex) return "failed";
      return "pending";
    }

    if (currentIndex === undefined) return "pending";
    if (stepIndex < currentIndex) return "completed";
    if (stepIndex === currentIndex) return "active";
    return "pending";
  };

  // Formatted values
  const formattedBalance =
    usdcBalance !== undefined
      ? parseFloat(formatUnits(usdcBalance, 6)).toFixed(2)
      : "...";

  const formattedDeposit =
    existingDeposit !== undefined && existingDeposit > 0n
      ? parseFloat(formatUnits(existingDeposit, 6)).toFixed(2)
      : null;

  // ===== RENDER =====
  return (
    <div className="bridge-widget">
      {/* Header */}
      <div className="bridge-header">
        <div className="bridge-header-left">
          <span className="bridge-title">Exchange</span>
          <div className="bridge-tabs">
            <button
              className={`bridge-tab ${activeTab === "bridge" ? "active" : ""}`}
              onClick={() => setActiveTab("bridge")}
            >
              Bridge
            </button>
            <button
              className={`bridge-tab ${activeTab === "track" ? "active" : ""}`}
              onClick={() => setActiveTab("track")}
            >
              Track
            </button>
          </div>
        </div>
        <button
          className={`bridge-settings-btn ${showSettings ? "active" : ""}`}
          onClick={() => setShowSettings(!showSettings)}
          title="Settings"
        >
          <svg className="bridge-settings-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6" />
          </svg>
        </button>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="bridge-settings-panel">
          {/* Execution mode */}
          <div className="bridge-settings-row">
            <span className="bridge-settings-label">Execution</span>
            <div className="bridge-mode-options">
              <button
                className={`bridge-mode-option ${mode === "fallback" ? "active" : ""}`}
                onClick={() => setMode("fallback")}
              >
                Fallback
              </button>
              <button
                className={`bridge-mode-option ${mode === "iexec" ? "active" : ""}`}
                onClick={() => setMode("iexec")}
              >
                iExec TEE
              </button>
            </div>
          </div>

          {/* Route priority */}
          <div className="bridge-settings-row">
            <span className="bridge-settings-label">Route Priority</span>
            <div className="bridge-mode-options">
              <button
                className={`bridge-mode-option ${routePriority === "fastest" ? "active" : ""}`}
                onClick={() => setRoutePriority("fastest")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
                Fastest
              </button>
              <button
                className={`bridge-mode-option ${routePriority === "best-return" ? "active" : ""}`}
                onClick={() => setRoutePriority("best-return")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
                Best Return
              </button>
            </div>
          </div>

          {/* Gas price */}
          <div className="bridge-settings-row gas-row">
            <span className="bridge-settings-label">Gas Price</span>
            <div className="bridge-gas-slider">
              <ElasticSlider
                leftIcon={
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#636366"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                }
                rightIcon={
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="#B0F2B6"><path d="M13 2.05v3.03c3.39.49 6 3.39 6 6.92 0 .9-.18 1.75-.48 2.54l2.6 1.53c.56-1.24.88-2.62.88-4.07 0-5.18-3.95-9.45-9-9.95zM12 19c-3.87 0-7-3.13-7-7 0-3.53 2.61-6.43 6-6.92V2.05c-5.06.5-9 4.76-9 9.95 0 5.52 4.47 10 9.99 10 3.31 0 6.24-1.61 8.06-4.09l-2.6-1.53C16.17 17.98 14.21 19 12 19z"/></svg>
                }
                startingValue={1}
                defaultValue={gasPrice}
                maxValue={100}
                isStepped={false}
                stepSize={1}
                onChange={setGasPrice}
              />
              <span className="bridge-gas-value">{gasPrice} gwei</span>
            </div>
          </div>
        </div>
      )}

      {/* ===== BRIDGE TAB ===== */}
      {activeTab === "bridge" && (
        <div className="bridge-body">
          {formattedDeposit && step === "input" && (
            <div className="bridge-deposit-banner">
              <div className="bridge-deposit-banner-left">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
                <span>{formattedDeposit} USDC in vault</span>
              </div>
              {withdrawStep === "idle" && (
                <button
                  className="bridge-withdraw-trigger"
                  onClick={() => setWithdrawStep("confirm")}
                >
                  Withdraw
                </button>
              )}
              {withdrawStep === "confirm" && (
                <div className="bridge-withdraw-confirm">
                  <span className="bridge-withdraw-question">Withdraw all?</span>
                  <button
                    className="bridge-withdraw-yes"
                    onClick={handleEmergencyWithdraw}
                  >
                    Yes
                  </button>
                  <button
                    className="bridge-withdraw-no"
                    onClick={() => setWithdrawStep("idle")}
                  >
                    No
                  </button>
                </div>
              )}
              {withdrawStep === "withdrawing" && (
                <div className="bridge-withdraw-status">
                  <div className="step-spinner small" />
                  <span>Withdrawing...</span>
                </div>
              )}
              {withdrawStep === "done" && (
                <span className="bridge-withdraw-done">Withdrawn</span>
              )}
            </div>
          )}
          {withdrawError && withdrawStep === "idle" && (
            <div className="bridge-error-msg" style={{ marginBottom: 8 }}>
              {withdrawError.message?.slice(0, 100) || "Withdraw failed"}
            </div>
          )}

          {step === "input" ? (
            <>
              {/* FROM CARD */}
              <div className="bridge-card">
                <div className="bridge-card-content">
                  <p className="bridge-card-label">From</p>
                  <div className="bridge-card-header">
                    <div className="bridge-badge">
                      <div className="bridge-badge-token"><UsdcLogo size={40} /></div>
                      <div className="bridge-badge-chain"><ArbitrumLogo size={18} /></div>
                    </div>
                    <div className="bridge-card-text">
                      <span className="bridge-card-title">USDC</span>
                      <span className="bridge-card-subtitle">
                        on Arbitrum Sepolia
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* SWAP ARROW */}
              <div className="bridge-swap-wrapper">
                <div className="bridge-swap-pill">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="m20 12-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8z" />
                  </svg>
                </div>
              </div>

              {/* TO CARD */}
              <div className="bridge-card">
                <div className="bridge-card-content">
                  <p className="bridge-card-label">To</p>
                  <div className="bridge-card-header">
                    <div className="bridge-badge">
                      <div className="bridge-badge-token"><UsdcLogo size={40} /></div>
                      <div className="bridge-badge-chain"><HyperliquidLogo size={18} /></div>
                    </div>
                    <div className="bridge-card-text">
                      <span className="bridge-card-title">USDC</span>
                      <span className="bridge-card-subtitle">
                        on Hyperliquid Testnet
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* SEND CARD */}
              <div className="bridge-send-card">
                <div className="bridge-send-header">
                  <p className="bridge-send-label">Send</p>
                </div>
                <div className="bridge-send-body">
                  <div className="bridge-badge small">
                    <div className="bridge-badge-token"><UsdcLogo size={32} /></div>
                    <div className="bridge-badge-chain"><ArbitrumLogo size={14} /></div>
                  </div>
                  <div className="bridge-send-input-area">
                    <input
                      className="bridge-send-input"
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      autoComplete="off"
                      name="fromAmount"
                      value={amount}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (/^\d*\.?\d*$/.test(val)) setAmount(val);
                      }}
                    />
                    <div className="bridge-send-helper">
                      <span className="bridge-send-usd">
                        ${amount ? parseFloat(amount).toFixed(2) : "0.00"}
                      </span>
                      <span className="bridge-send-balance">
                        {isConnected ? (
                          <>
                            {formattedBalance} USDC
                            <button
                              className="bridge-send-max"
                              onClick={handleMaxAmount}
                            >
                              Max
                            </button>
                          </>
                        ) : (
                          "-"
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* ROUTE SELECTION (LI.FI style) */}
              {showRoute && (
                <div className="bridge-route-card">
                  <div className="bridge-route-receive">
                    <div className="bridge-route-receive-left">
                      <div className="bridge-badge small">
                        <div className="bridge-badge-token"><UsdcLogo size={32} /></div>
                        <div className="bridge-badge-chain"><HyperliquidLogo size={14} /></div>
                      </div>
                      <div className="bridge-route-receive-info">
                        <span className="bridge-route-receive-amount">{amount} USDC</span>
                        <span className="bridge-route-receive-chain">on Hyperliquid Testnet</span>
                      </div>
                    </div>
                    <span className="bridge-route-receive-tag">Receive</span>
                  </div>

                  <div className="bridge-route-divider" />

                  <div className="bridge-route-path">
                    <div className="bridge-route-path-header">
                      <div className="bridge-route-path-left">
                        <span className="bridge-route-path-dot" />
                        <span className="bridge-route-path-name">{`{HyperSecret}`}</span>
                      </div>
                      <span className="bridge-route-path-tag">Best Route</span>
                    </div>
                    <div className="bridge-route-path-meta">
                      <span className="bridge-route-meta-item">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
                        ~2 min
                      </span>
                      <span className="bridge-route-meta-sep" />
                      <span className="bridge-route-meta-item">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/></svg>
                        Free
                      </span>
                      <span className="bridge-route-meta-sep" />
                      <span className="bridge-route-meta-item">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
                        {mode === "iexec" ? "iExec SGX" : "TEE Enclave"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* ACTIONS */}
              <div className="bridge-actions">
                <button
                  className={`bridge-btn ${buttonConfig.variant}`}
                  disabled={buttonConfig.disabled}
                  onClick={buttonConfig.onClick}
                >
                  {buttonConfig.text}
                </button>
                <button
                  className={`bridge-wallet-btn ${showRecipient ? "active" : ""}`}
                  onClick={() => setShowRecipient(!showRecipient)}
                  title="Recipient address"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18 4H6C3.79 4 2 5.79 2 8v8c0 2.21 1.79 4 4 4h12c2.21 0 4-1.79 4-4V8c0-2.21-1.79-4-4-4m-1.86 9.77c-.24.2-.57.28-.88.2L4.15 11.25C4.45 10.52 5.16 10 6 10h12c.67 0 1.26.34 1.63.84zM6 6h12c1.1 0 2 .9 2 2v.55c-.59-.34-1.27-.55-2-.55H6c-.73 0-1.41.21-2 .55V8c0-1.1.9-2 2-2" />
                  </svg>
                </button>
              </div>

              {/* RECIPIENT */}
              <div className={`bridge-recipient-area ${showRecipient ? "open" : ""}`}>
                <div className="bridge-recipient-card">
                  <div className="bridge-recipient-header">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M18 4H6C3.79 4 2 5.79 2 8v8c0 2.21 1.79 4 4 4h12c2.21 0 4-1.79 4-4V8c0-2.21-1.79-4-4-4m-1.86 9.77c-.24.2-.57.28-.88.2L4.15 11.25C4.45 10.52 5.16 10 6 10h12c.67 0 1.26.34 1.63.84zM6 6h12c1.1 0 2 .9 2 2v.55c-.59-.34-1.27-.55-2-.55H6c-.73 0-1.41.21-2 .55V8c0-1.1.9-2 2-2" />
                    </svg>
                    <span className="bridge-recipient-title">
                      Recipient on Hyperliquid Testnet
                    </span>
                  </div>
                  <input
                    className="bridge-recipient-input"
                    type="text"
                    placeholder="0x..."
                    value={hlDestination}
                    onChange={(e) => setHlDestination(e.target.value)}
                    tabIndex={showRecipient ? 0 : -1}
                  />
                </div>
              </div>

            </>
          ) : step === "completed" ? (
            <div className="bridge-result">
              <div className="bridge-result-icon success">&#10003;</div>
              <div className="bridge-result-title">Transfer Complete!</div>
              <div className="bridge-result-subtitle">
                {amount} USDC sent anonymously to Hyperliquid Testnet
              </div>

              {trackData?.result && (
                <div className="bridge-result-details">
                  {trackData.result.freshWallet && (
                    <div className="bridge-result-row">
                      <span className="label">Fresh Wallet</span>
                      <span className="value">
                        <a
                          href={`https://sepolia.arbiscan.io/address/${trackData.result.freshWallet}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.freshWallet.slice(0, 8)}...
                          {trackData.result.freshWallet.slice(-6)}
                        </a>
                      </span>
                    </div>
                  )}
                  {trackData.result.redistributeTx && (
                    <div className="bridge-result-row">
                      <span className="label">Redistribute</span>
                      <span className="value">
                        <a
                          href={`https://sepolia.arbiscan.io/tx/${trackData.result.redistributeTx}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.redistributeTx.slice(0, 10)}...
                        </a>
                      </span>
                    </div>
                  )}
                  {trackData.result.bridgeTx && (
                    <div className="bridge-result-row">
                      <span className="label">HL Bridge Tx</span>
                      <span className="value">
                        <a
                          href={`https://sepolia.arbiscan.io/tx/${trackData.result.bridgeTx}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.bridgeTx.slice(0, 10)}...
                        </a>
                      </span>
                    </div>
                  )}
                  {trackData.result.destination && (
                    <div className="bridge-result-row">
                      <span className="label">HL Destination</span>
                      <span className="value">
                        <a
                          href={`https://app.hyperliquid-testnet.xyz/portfolio/${trackData.result.destination}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.destination.slice(0, 8)}...
                          {trackData.result.destination.slice(-6)}
                        </a>
                      </span>
                    </div>
                  )}
                </div>
              )}

              {intentResult && (
                <div className="bridge-result-details">
                  <div className="bridge-result-row">
                    <span className="label">Mode</span>
                    <span className="value">{intentResult.mode}</span>
                  </div>
                  {intentResult.executionId && (
                    <div className="bridge-result-row">
                      <span className="label">Execution ID</span>
                      <span className="value">{intentResult.executionId}</span>
                    </div>
                  )}
                  {intentResult.taskid && (
                    <div className="bridge-result-row">
                      <span className="label">iExec Task</span>
                      <span className="value">
                        <a
                          href={`https://explorer.iex.ec/arbitrum-sepolia-testnet/task/${intentResult.taskid}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {intentResult.taskid.slice(0, 10)}...
                          {intentResult.taskid.slice(-6)}
                        </a>
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="bridge-result-actions">
                <button className="bridge-btn primary" onClick={handleReset}>
                  Bridge Again
                </button>
              </div>
            </div>
          ) : step === "failed" ? (
            <div className="bridge-result">
              <div className="bridge-result-icon error">!</div>
              <div className="bridge-result-title">Bridge Failed</div>
              <div className="bridge-result-subtitle">
                Something went wrong during the process
              </div>
              {error && <div className="bridge-error-msg">{error}</div>}
              <div className="bridge-result-actions">
                <button className="bridge-btn primary" onClick={handleReset}>
                  Try Again
                </button>
              </div>
            </div>
          ) : (
            <div className="bridge-progress">
              <div className="bridge-progress-title">
                Bridging {amount} USDC anonymously
              </div>
              <div className="bridge-steps">
                {STEPS.map((s) => {
                  const status = getStepStatus(s.key);
                  return (
                    <div
                      key={s.key}
                      className={`bridge-step ${status === "active" ? "active" : ""}`}
                    >
                      <div className={`bridge-step-icon ${status}`}>
                        {status === "completed" && <span>&#10003;</span>}
                        {status === "active" && <div className="step-spinner" />}
                        {status === "pending" && (
                          <span>
                            {STEPS.findIndex((x) => x.key === s.key) + 1}
                          </span>
                        )}
                        {status === "failed" && <span>!</span>}
                      </div>
                      <span className="bridge-step-text">{s.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== TRACK TAB ===== */}
      {activeTab === "track" && (
        <div className="status-panel">
          <div className="status-panel-title">Track Execution</div>
          <div className="status-mode-row">
            <button
              className={`status-mode-btn ${trackMode === "fallback" ? "active" : ""}`}
              onClick={() => setTrackMode("fallback")}
            >
              Fallback
            </button>
            <button
              className={`status-mode-btn ${trackMode === "iexec" ? "active" : ""}`}
              onClick={() => setTrackMode("iexec")}
            >
              iExec
            </button>
          </div>
          <div className="status-input-row">
            <input
              className="status-input"
              type="text"
              placeholder={
                trackMode === "iexec" ? "Task ID (0x...)" : "Execution ID"
              }
              value={trackId}
              onChange={(e) => setTrackId(e.target.value)}
            />
            <button
              className="status-track-btn"
              onClick={handleTrackSubmit}
              disabled={!trackId || trackPolling}
            >
              {trackPolling ? "Polling..." : "Track"}
            </button>
          </div>
          {trackError && <div className="bridge-error-msg">{trackError}</div>}
          {trackData && (
            <div className="status-display">
              <div
                className={`status-badge ${
                  trackData.completed
                    ? "completed"
                    : trackData.status === "failed" ||
                        trackData.status === "FAILED"
                      ? "failed"
                      : "active"
                }`}
              >
                <span className="dot" />
                {trackData.status}
              </div>
              {trackData.completed && trackData.result && (
                <div className="bridge-result-details" style={{ margin: 0 }}>
                  {trackData.result.freshWallet && (
                    <div className="bridge-result-row">
                      <span className="label">Fresh Wallet</span>
                      <span className="value">
                        <a
                          href={`https://sepolia.arbiscan.io/address/${trackData.result.freshWallet}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.freshWallet.slice(0, 8)}...
                          {trackData.result.freshWallet.slice(-6)}
                        </a>
                      </span>
                    </div>
                  )}
                  {trackData.result.redistributeTx && (
                    <div className="bridge-result-row">
                      <span className="label">Redistribute</span>
                      <span className="value">
                        <a
                          href={`https://sepolia.arbiscan.io/tx/${trackData.result.redistributeTx}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.redistributeTx.slice(0, 10)}...
                        </a>
                      </span>
                    </div>
                  )}
                  {trackData.result.bridgeTx && (
                    <div className="bridge-result-row">
                      <span className="label">HL Bridge Tx</span>
                      <span className="value">
                        <a
                          href={`https://sepolia.arbiscan.io/tx/${trackData.result.bridgeTx}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.bridgeTx.slice(0, 10)}...
                        </a>
                      </span>
                    </div>
                  )}
                  {trackData.result.destination && (
                    <div className="bridge-result-row">
                      <span className="label">HL Destination</span>
                      <span className="value">
                        <a
                          href={`https://app.hyperliquid-testnet.xyz/portfolio/${trackData.result.destination}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {trackData.result.destination.slice(0, 8)}...
                          {trackData.result.destination.slice(-6)}
                        </a>
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
