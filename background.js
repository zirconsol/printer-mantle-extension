// Config
const DEFAULT_RPC = "https://mantle-rpc.publicnode.com";
const PRINTR_WALLET_ENDPOINT = "/api/getWalletBalances";
const MS_API = "https://explorer.mantle.xyz/api";
const PRINTR_API = "https://app.printr.money/api";

const TOKEN_ID_MAP = {
  "0x375450706cb79ab749ebb90001bda10341dd82bc": "0x57a02b3daa88adffcd720f122feb2567765d89bba832b933edd5ac7cce434980",
  "0x6e25f88171c71abc3f89494896d89cc028d1e27b": "0x471b96c034047ef9d98ec584855c37ecfd44d7d057e2c4366a50b6147fd50a91"
};

console.log("[BG] boot: service worker evaluated");
chrome.runtime.onInstalled.addListener(function() {
  console.log("[BG] onInstalled");
});
self.addEventListener("activate", function() {
  console.log("[BG] activate");
});

function broadcastWalletToTabs(wallet, networkId) {
  chrome.tabs.query({ url: "https://app.printr.money/*" }, function(tabs) {
    for (var i = 0; i < (tabs || []).length; i++) {
      var t = tabs[i];
      chrome.tabs.sendMessage(
        t.id,
        { type: "WALLET_UPDATE", wallet: wallet, networkId: networkId || null },
        function() {
          void chrome.runtime.lastError;
        }
      );
    }
  });
}

function trySaveWalletFromUrl(rawUrl, phase) {
  try {
    var url = new URL(rawUrl);
    if (!url.pathname.endsWith(PRINTR_WALLET_ENDPOINT)) return false;

    var wallet = url.searchParams.get("walletAddress");
    var networkId = url.searchParams.get("networkId");
    console.log("[BG] " + phase + ": hit " + url.pathname, { wallet: wallet, networkId: networkId });

    if (wallet && /^0x[a-fA-F0-9]{40}$/i.test(wallet)) {
      chrome.storage.session.set({
        printrWallet: wallet,
        printrNetworkId: networkId || null,
        printrWalletDetectedAt: Date.now()
      });
      console.log("[BG] wallet saved:", wallet, "network:", networkId || null);
      broadcastWalletToTabs(wallet, networkId);
      return true;
    }
    return false;
  } catch (e) {
    console.warn("[BG] parse error:", e && e.message ? e.message : e);
    return false;
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  function(d) { return trySaveWalletFromUrl(d.url, "onBeforeRequest"); },
  { urls: ["https://app.printr.money/*"] }
);
chrome.webRequest.onCompleted.addListener(
  function(d) { return trySaveWalletFromUrl(d.url, "onCompleted"); },
  { urls: ["https://app.printr.money/*"] }
);

async function rpc(rpcUrl, method, params) {
  if (!params) params = [];
  var r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
  });
  var j = await r.json();
  if (j.error) throw new Error(j.error.message || String(j.error));
  return j.result;
}

function pad32(hex) {
  return "0x" + hex.replace(/^0x/, "").padStart(64, "0").toLowerCase();
}

var SEL_DECIMALS   = "0x313ce567";
var SEL_SYMBOL     = "0x95d89b41";
var SEL_NAME       = "0x06fdde03";
var SEL_BALANCEOF  = "0x70a08231";

async function eth_call(rpcUrl, to, data) {
  return rpc(rpcUrl, "eth_call", [{ to: to, data: data }, "latest"]);
}

function hexToAsciiMaybe(hex) {
  try {
    var clean = hex.replace(/^0x/, "");
    if (clean.length < 128) return null;
    var lenHex = "0x" + clean.slice(64, 128);
    var len = Number(BigInt(lenHex));
    var dataStart = 128;
    var bytesHex = clean.slice(dataStart, dataStart + len * 2);
    var matches = bytesHex.match(/.{1,2}/g);
    var bytes = new Uint8Array(matches.map(function(b) { return parseInt(b, 16); }));
    return new TextDecoder().decode(bytes).replace(/\0+$/g, "");
  } catch (err) {
    return null;
  }
}

async function erc20_decimals(rpcUrl, token) {
  try {
    var res = await eth_call(rpcUrl, token, SEL_DECIMALS);
    return parseInt(res, 16) || 18;
  } catch (err) { return 18; }
}

async function erc20_symbol(rpcUrl, token) {
  try {
    var res = await eth_call(rpcUrl, token, SEL_SYMBOL);
    return hexToAsciiMaybe(res) || null;
  } catch (err) { return null; }
}

async function erc20_name(rpcUrl, token) {
  try {
    var res = await eth_call(rpcUrl, token, SEL_NAME);
    return hexToAsciiMaybe(res) || null;
  } catch (err) { return null; }
}

async function erc20_balanceOf(rpcUrl, token, wallet) {
  try {
    var data = SEL_BALANCEOF + pad32(wallet).slice(2);
    var res = await eth_call(rpcUrl, token, data);
    return BigInt(res);
  } catch (err) { return 0n; }
}

function formatTokenAmount(rawBalance, decimals) {
  try {
    var bal = BigInt(rawBalance);
    var divisor = BigInt(10) ** BigInt(decimals);
    var wholePart = bal / divisor;
    var fracPart = bal % divisor;
    
    var wholeNum = Number(wholePart);
    var fracNum = Number(fracPart) / Number(divisor);
    var total = wholeNum + fracNum;
    
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

function formatUSD(value) {
  try {
    var num = Number(value);
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

async function getTokenPrice(contractAddress) {
  try {
    var lowerAddr = contractAddress.toLowerCase();
    var tokenId = TOKEN_ID_MAP[lowerAddr];
    if (!tokenId) {
      console.log("[BG] No token ID mapping for contract:", contractAddress);
      console.log("[BG] Available mappings:", Object.keys(TOKEN_ID_MAP));
      return null;
    }
    
    var url = PRINTR_API + "/getToken/" + tokenId;
    console.log("[BG] Fetching price from:", url);
    var r = await fetch(url, { method: "GET" });
    
    if (!r.ok) {
      console.warn("[BG] Printr API not ok:", r.status, "for", contractAddress);
      return null;
    }
    
    var data = await r.json();
    
    var deployment = null;
    if (data.deployments) {
      for (var i = 0; i < data.deployments.length; i++) {
        if (data.deployments[i].chainId === "eip155:5000") {
          deployment = data.deployments[i];
          break;
        }
      }
    }
    
    if (deployment && deployment.priceUSD) {
      console.log("[BG] Price for", data.symbol, ":", deployment.priceUSD);
      return {
        priceUSD: deployment.priceUSD,
        change24: deployment.change24 || 0
      };
    }
    
    console.log("[BG] No price found for", contractAddress);
    return null;
  } catch (e) {
    console.warn("[BG] getTokenPrice error:", e && e.message ? e.message : e);
    return null;
  }
}

async function mantleScanTokenContracts(wallet) {
  var url = MS_API + "?module=account&action=tokentx&address=" + wallet + "&startblock=0&endblock=999999999&sort=asc";
  var r = await fetch(url, { method: "GET" });
  if (!r.ok) {
    console.warn("[BG] MantleScan not ok:", r.status);
    return [];
  }
  var j = await r.json().catch(function() { return null; });
  if (!j || j.status !== "1" || !Array.isArray(j.result)) {
    console.log("[BG] MantleScan empty or no ERC20 txs");
    return [];
  }
  var set = new Set();
  for (var i = 0; i < j.result.length; i++) {
    var tx = j.result[i];
    var ca = (tx.contractAddress || "").toLowerCase();
    if (ca && /^0x[0-9a-f]{40}$/.test(ca)) set.add(ca);
  }
  return Array.from(set);
}

async function scanBalancesFromWalletStored() {
  var stored = await chrome.storage.session.get(["printrWallet"]);
  var printrWallet = stored.printrWallet;
  if (!printrWallet || !/^0x[a-fA-F0-9]{40}$/i.test(printrWallet)) {
    throw new Error("No wallet in storage.session");
  }
  var wallet = printrWallet;
  var rpcUrl = DEFAULT_RPC;

  console.log("[BG] scan via MantleScan for wallet:", wallet);

  var tokenAddresses = await mantleScanTokenContracts(wallet);
  if (!tokenAddresses.length) {
    return [];
  }

  var out = [];
  for (var i = 0; i < tokenAddresses.length; i++) {
    var token = tokenAddresses[i];
    try {
      var bal = await erc20_balanceOf(rpcUrl, token, wallet);
      if (bal <= 0n) continue;

      var dec = await erc20_decimals(rpcUrl, token).catch(function() { return 18; });
      var sym = await erc20_symbol(rpcUrl, token).catch(function() { return null; });
      var name = await erc20_name(rpcUrl, token).catch(function() { return null; });

      var symbolUp = (sym || "").toUpperCase();
      if (symbolUp === "MNT") continue;

      var formattedBalance = formatTokenAmount(bal.toString(), dec);
      
      var balNum = Number(bal) / Math.pow(10, dec);
      
      var priceData = await getTokenPrice(token);
      var valueUSD = null;
      var formattedUSD = null;
      var change24 = null;
      
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

    await new Promise(function(r) { setTimeout(r, 80); });
  }

  return out;
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg && msg.type === "SCAN_TOKENS_MS") {
    (async function() {
      try {
        var t0 = performance.now();
        var items = await scanBalancesFromWalletStored();
        var t1 = performance.now();
        console.log("[BG] SCAN_TOKENS_MS done", { count: items.length, ms: Math.round(t1 - t0) });
        sendResponse({ ok: true, items: items });
      } catch (e) {
        console.warn("[BG] SCAN_TOKENS_MS error:", e && e.message ? e.message : e);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }
  
  if (msg && msg.type === "GET_WALLET") {
    (async function() {
      try {
        var stored = await chrome.storage.session.get(["printrWallet"]);
        sendResponse({ ok: true, wallet: stored.printrWallet || null });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();
    return true;
  }
});