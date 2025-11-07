// ========= Config =========
const DEFAULT_RPC = "https://mantle-rpc.publicnode.com";
const PRINTR_WALLET_ENDPOINT = "/api/getWalletBalances";
const MS_API = "https://explorer.mantle.xyz/api";
const PRINTR_API = "https://app.printr.money/api";

// Token ID mapping (contract address -> Printr token ID)
const TOKEN_ID_MAP = {
  "0x375450706cb79ab749ebb90001bda10341dd82bc": "0x57a02b3daa88adffcd720f122feb2567765d89bba832b933edd5ac7cce434980", // BILLI
  "0x4f605d24ab0be4dc5bc6837a59869537f66f947a": "0x471b96c034047ef9d98ec584855c37ecfd44d7d057e2c4366a50b6147fd50a91"  // MOMNTUM
};

// ========= Logs de arranque =========
console.log("[BG] boot: service worker evaluated");
chrome.runtime.onInstalled.addListener(() => console.log("[BG] onInstalled"));
self.addEventListener("activate", () => console.log("[BG] activate"));

// ========= Sniff de wallet desde Printr =========
function broadcastWalletToTabs(wallet, networkId) {
  chrome.tabs.query({ url: "https://app.printr.money/*" }, (tabs) => {
    for (const t of tabs || []) {
      chrome.tabs.sendMessage(
        t.id,
        { type: "WALLET_UPDATE", wallet, networkId: networkId || null },
        () => void chrome.runtime.lastError
      );
    }
  });
}

function trySaveWalletFromUrl(rawUrl, phase) {
  try {
    const url = new URL(rawUrl);
    if (!url.pathname.endsWith(PRINTR_WALLET_ENDPOINT)) return false;

    const wallet = url.searchParams.get("walletAddress");
    const networkId = url.searchParams.get("networkId");
    console.log(`[BG] ${phase}: hit ${url.pathname}`, { wallet, networkId });

    if (wallet && /^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
      chrome.storage.session.set({
        printrWallet: wallet,
        printrNetworkId: networkId || null,
        printrWalletDetectedAt: Date.now(),
      });
      console.log("[BG] wallet saved:", wallet, "network:", networkId || null);
      broadcastWalletToTabs(wallet, networkId);
      return true;
    }
    return false;
  } catch (e) {
    console.warn("[BG] parse error:", e?.message || e);
    return false;
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => trySaveWalletFromUrl(d.url, "onBeforeRequest"),
  { urls: ["https://app.printr.money/*"] }
);
chrome.webRequest.onCompleted.addListener(
  (d) => trySaveWalletFromUrl(d.url, "onCompleted"),
  { urls: ["https://app.printr.money/*"] }
);

// ========= Helpers JSON-RPC =========
async function rpc(rpcUrl, method, params = []) {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || String(j.error));
  return j.result;
}
const pad32 = (hex) => "0x" + hex.replace(/^0x/, "").padStart(64, "0").toLowerCase();

// ABI selectors
const SEL_DECIMALS   = "0x313ce567";
const SEL_SYMBOL     = "0x95d89b41";
const SEL_NAME       = "0x06fdde03";
const SEL_BALANCEOF  = "0x70a08231";

// eth_call helper
async function eth_call(rpcUrl, to, data) {
  return rpc(rpcUrl, "eth_call", [{ to, data }, "latest"]);
}

function hexToAsciiMaybe(hex) {
  try {
    const clean = hex.replace(/^0x/, "");
    if (clean.length < 128) return null;
    const lenHex = "0x" + clean.slice(64, 128);
    const len = Number(BigInt(lenHex));
    const dataStart = 128;
    const bytesHex = clean.slice(dataStart, dataStart + len * 2);
    const bytes = new Uint8Array(bytesHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    return new TextDecoder().decode(bytes).replace(/\0+$/g, "");
  } catch {
    return null;
  }
}

async function erc20_decimals(rpcUrl, token) {
  try {
    const res = await eth_call(rpcUrl, token, SEL_DECIMALS);
    return parseInt(res, 16) || 18;
  } catch { return 18; }
}
async function erc20_symbol(rpcUrl, token) {
  try {
    const res = await eth_call(rpcUrl, token, SEL_SYMBOL);
    return hexToAsciiMaybe(res) || null;
  } catch { return null; }
}
async function erc20_name(rpcUrl, token) {
  try {
    const res = await eth_call(rpcUrl, token, SEL_NAME);
    return hexToAsciiMaybe(res) || null;
  } catch { return null; }
}
async function erc20_balanceOf(rpcUrl, token, wallet) {
  try {
    const data = SEL_BALANCEOF + pad32(wallet).slice(2);
    const res = await eth_call(rpcUrl, token, data);
    return BigInt(res);
  } catch { return 0n; }
}

// ========= Formatear cantidad =========
function formatTokenAmount(rawBalance, decimals) {
  try {
    const bal = BigInt(rawBalance);
    const divisor = BigInt(10) ** BigInt(decimals);
    const wholePart = bal / divisor;
    const fracPart = bal % divisor;
    
    const wholeNum = Number(wholePart);
    const fracNum = Number(fracPart) / Number(divisor);
    const total = wholeNum + fracNum;
    
    if (total >= 1000000) {
      return (total / 1000000).toFixed(2) + "M";
    } else if (total >= 1000) {
      return (total / 1000).toFixed(2) + "k";
    } else if (total >= 1) {
      return total.toFixed(2);
    } else if (total > 0) {
      return total.toFixed(4);
    }
    return "0";
  } catch (e) {
    console.warn("[BG] formatTokenAmount error:", e);
    return "0";
  }
}

// ========= Formatear USD =========
function formatUSD(value) {
  try {
    const num = Number(value);
    if (isNaN(num) || num === 0) return "$0.00";
    
    if (num >= 1000000) {
      return "$" + (num / 1000000).toFixed(2) + "M";
    } else if (num >= 1000) {
      return "$" + (num / 1000).toFixed(2) + "k";
    } else if (num >= 1) {
      return "$" + num.toFixed(2);
    } else {
      return "$" + num.toFixed(4);
    }
  } catch (e) {
    console.warn("[BG] formatUSD error:", e);
    return "$0.00";
  }
}

// ========= Obtener precio de token desde Printr API =========
async function getTokenPrice(contractAddress) {
  try {
    const tokenId = TOKEN_ID_MAP[contractAddress.toLowerCase()];
    if (!tokenId) {
      console.log("[BG] No token ID mapping for:", contractAddress);
      return null;
    }
    
    const url = PRINTR_API + "/getToken/" + tokenId;
    const r = await fetch(url, { method: "GET" });
    
    if (!r.ok) {
      console.warn("[BG] Printr API not ok:", r.status, "for", contractAddress);
      return null;
    }
    
    const data = await r.json();
    
    // Buscar el deployment de Mantle (chainId: eip155:5000)
    const deployment = data.deployments && data.deployments.find(function(d) {
      return d.chainId === "eip155:5000";
    });
    
    if (deployment && deployment.priceUSD) {
      console.log("[BG] Price for", data.symbol, ":", deployment.priceUSD);
      return {
        priceUSD: deployment.priceUSD,
        change24: deployment.change24 || 0
      };
    }
    
    return null;
  } catch (e) {
    console.warn("[BG] getTokenPrice error:", e && e.message ? e.message : e);
    return null;
  }
}

// ========= MantleScan: enumerar contratos ERC-20 por actividad =========
async function mantleScanTokenContracts(wallet) {
  const url = `${MS_API}?module=account&action=tokentx&address=${wallet}&startblock=0&endblock=999999999&sort=asc`;
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) {
    console.warn("[BG] MantleScan not ok:", r.status);
    return [];
  }
  const j = await r.json().catch(() => null);
  if (!j || j.status !== "1" || !Array.isArray(j.result)) {
    console.log("[BG] MantleScan empty or no ERC20 txs");
    return [];
  }
  const set = new Set();
  for (const tx of j.result) {
    const ca = (tx.contractAddress || "").toLowerCase();
    if (ca && /^0x[0-9a-f]{40}$/.test(ca)) set.add(ca);
  }
  return [...set];
}

// ========= Scan balances =========
async function scanBalancesFromWalletStored() {
  const { printrWallet } = await chrome.storage.session.get(["printrWallet"]);
  if (!printrWallet || !/^0x[a-fA-F0-9]{40}$/i.test(printrWallet)) {
    throw new Error("No wallet in storage.session");
  }
  const wallet = printrWallet;
  const rpcUrl = DEFAULT_RPC;

  console.log("[BG] scan via MantleScan for wallet:", wallet);

  const tokenAddresses = await mantleScanTokenContracts(wallet);
  if (!tokenAddresses.length) {
    return [];
  }

  const out = [];
  for (let i = 0; i < tokenAddresses.length; i++) {
    const token = tokenAddresses[i];
    try {
      const bal = await erc20_balanceOf(rpcUrl, token, wallet);
      if (bal <= 0n) continue;

      const [dec, sym, name] = await Promise.all([
        erc20_decimals(rpcUrl, token).catch(() => 18),
        erc20_symbol(rpcUrl, token).catch(() => null),
        erc20_name(rpcUrl, token).catch(() => null),
      ]);

      const symbolUp = (sym || "").toUpperCase();
      if (symbolUp === "MNT") continue;

      const formattedBalance = formatTokenAmount(bal.toString(), dec);
      
      // Calcular balance numerico para USD
      const balNum = Number(bal) / Math.pow(10, dec);
      
      // Obtener precio y calcular valor en USD
      const priceData = await getTokenPrice(token);
      let valueUSD = null;
      let formattedUSD = null;
      let change24 = null;
      
      if (priceData && priceData.priceUSD) {
        valueUSD = balNum * priceData.priceUSD;
        formattedUSD = formatUSD(valueUSD);
        change24 = priceData.change24;
      }

      out.push({
        address: token,
        symbol: sym || "TOKEN",
        name: name || sym || "Token",
        decimals: dec,
        rawBalance: bal.toString(),
        formattedBalance: formattedBalance,
        valueUSD: valueUSD,
        formattedUSD: formattedUSD,
        change24: change24
      });
    } catch (e) {
      // ignorar contratos invalidos
    }

    await new Promise((r) => setTimeout(r, 80));
  }

  return out;
}

// ========= Mensajeria: content -> background =========
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SCAN_TOKENS_MS") {
    (async () => {
      try {
        const t0 = performance.now();
        const items = await scanBalancesFromWalletStored();
        const t1 = performance.now();
        console.log("[BG] SCAN_TOKENS_MS done", { count: items.length, ms: Math.round(t1 - t0) });
        sendResponse({ ok: true, items });
      } catch (e) {
        console.warn("[BG] SCAN_TOKENS_MS error:", e?.message || e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  
  if (msg?.type === "GET_WALLET") {
    (async () => {
      try {
        const { printrWallet } = await chrome.storage.session.get(["printrWallet"]);
        sendResponse({ ok: true, wallet: printrWallet || null });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});