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
      // Only save + broadcast if the stored wallet is different (debounce duplicate webRequest events)
      try {
        chrome.storage.session.get(["printrWallet", "printrNetworkId"], function(stored) {
          var existing = stored && stored.printrWallet;
          var existingNet = stored && stored.printrNetworkId;
          if (!existing || existing.toLowerCase() !== wallet.toLowerCase() || String(existingNet) !== String(networkId || null)) {
            chrome.storage.session.set({
              printrWallet: wallet,
              printrNetworkId: networkId || null,
              printrWalletDetectedAt: Date.now()
            });
            console.log("[BG] wallet saved:", wallet, "network:", networkId || null);
            broadcastWalletToTabs(wallet, networkId);
          } else {
            // duplicate detection: don't broadcast again
            console.log("[BG] wallet already stored, skipping broadcast");
          }
        });
      } catch (err) {
        // fallback: attempt to set directly
        chrome.storage.session.set({
          printrWallet: wallet,
          printrNetworkId: networkId || null,
          printrWalletDetectedAt: Date.now()
        });
        broadcastWalletToTabs(wallet, networkId);
      }
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

// Simple cached MNT->USD price (CoinGecko) to convert entry MNT prices to USD
var _cachedMntUsd = { ts: 0, value: null };
async function getMntUsdPrice() {
  try {
    var now = Date.now();
    if (_cachedMntUsd.value != null && now - _cachedMntUsd.ts < 60 * 1000) {
      return _cachedMntUsd.value;
    }
    var url = 'https://api.coingecko.com/api/v3/simple/price?ids=mantle&vs_currencies=usd';
    var r = await fetch(url, { method: 'GET' });
    if (!r.ok) return null;
    var j = await r.json().catch(function() { return null; });
    if (!j || !j.mantle || !j.mantle.usd) return null;
    var v = Number(j.mantle.usd);
    if (isNaN(v)) return null;
    _cachedMntUsd = { ts: now, value: v };
    return v;
  } catch (e) {
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

// Obtener compras (buys) para un token hacia la wallet usando MantleScan: sumar native value de la tx
async function mantleGetBuysForToken(wallet, token, decimals) {
  try {
    var url = MS_API + "?module=account&action=tokentx&address=" + wallet + "&contractaddress=" + token + "&startblock=0&endblock=999999999&sort=asc";
    var r = await fetch(url, { method: "GET" });
    if (!r.ok) {
      console.warn('[BG] mantleGetBuysForToken: MantleScan tokentx fetch not ok', r.status);
      return null;
    }
    var j = await r.json().catch(function() { return null; });
    if (!j || j.status !== "1" || !Array.isArray(j.result)) {
      console.log('[BG] mantleGetBuysForToken: no tokentx result or empty', j);
      return null;
    }
    console.log('[BG] mantleGetBuysForToken: tokentx count', j.result.length, 'for', token, 'wallet', wallet);

    var sumTokensRaw = 0n;
    var sumMntRaw = 0n;
    var buys = 0;

  // cache for symbol lookups
    var symbolCache = {};
    var TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    var walletLower = wallet.toLowerCase();
    var walletTopic = pad32(walletLower).toLowerCase();
  // RPC used to resolve ERC20 symbol when needed
  var rpcUrl = DEFAULT_RPC;

    for (var i = 0; i < j.result.length; i++) {
      var tx = j.result[i];
      var to = (tx.to || '').toLowerCase();
      if (to !== walletLower) continue; // only incoming transfers for this token

      // token amount (raw) from tokentx result
      try {
        var tokenValRaw = BigInt(tx.value || tx.tokenValue || tx.contractValue || '0');
      } catch (e) {
        try { tokenValRaw = BigInt(tx.tokenDecimal ? String(tx.value) : '0'); } catch (e2) { tokenValRaw = 0n; }
      }
      if (tokenValRaw <= 0n) continue;
      var txhash = tx.hash || tx.transactionHash || tx.txhash || tx.txHash;
      console.log('[BG] mantleGetBuysForToken: incoming tokentx', { token: token, txhash: txhash, tokenValRaw: tokenValRaw.toString() });

      // fetch transaction receipt to inspect logs for WMNT (or other ERC20) transfers from the wallet
      try {
        var txhash = tx.hash || tx.transactionHash || tx.txhash;
        if (!txhash) continue;
        var receiptUrl = MS_API + "?module=proxy&action=eth_getTransactionReceipt&txhash=" + txhash;
        // use direct RPC to fetch receipt to avoid explorer proxy limits
        var receipt = null;
        try {
          receipt = await rpc(DEFAULT_RPC, 'eth_getTransactionReceipt', [txhash]);
        } catch (e) {
          console.log('[BG] mantleGetBuysForToken: rpc eth_getTransactionReceipt failed for', txhash, e && e.message);
          continue;
        }
        if (!receipt || !Array.isArray(receipt.logs)) {
          console.log('[BG] mantleGetBuysForToken: no receipt.logs for tx', txhash, receipt);
          continue;
        }
        console.log('[BG] mantleGetBuysForToken: receipt logs length', receipt.logs.length, 'for tx', txhash);
        if (receipt.logs.length > 0) {
          try {
            var firstLog = receipt.logs[0];
            console.log('[BG] mantleGetBuysForToken: receipt first log sample', { address: firstLog.address, topics0: firstLog.topics && firstLog.topics[0], data: String(firstLog.data).slice(0, 66) });
          } catch (e) { }
        }

        // look for any Transfer logs in the same receipt where 'from' == wallet and address != token
        var mntFound = false;
        for (var li = 0; li < receipt.logs.length; li++) {
          var lg = receipt.logs[li];
          if (!lg || !lg.topics || !lg.topics[0]) continue;
          if (lg.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;

          var fromTopic = (lg.topics[1] || '').toLowerCase();
          var toTopic = (lg.topics[2] || '').toLowerCase();
          var logAddr = (lg.address || '').toLowerCase();
          console.log('[BG] mantleGetBuysForToken: inspecting log', { logAddr: logAddr, fromTopic: fromTopic, toTopic: toTopic });

          // if this log represents the token transfer to wallet we are already processing, skip
          if (logAddr === token.toLowerCase() && toTopic === walletTopic) continue;

          // if wallet was sender of some other ERC20 in this tx, consider it payment
          if (fromTopic === walletTopic && logAddr !== token.toLowerCase()) {
            // amount raw is in lg.data
            var otherAmtRaw = BigInt(lg.data || '0x0');

            // try to resolve symbol (cache)
            var sym = symbolCache[logAddr];
            if (sym === undefined) {
              try {
                sym = await erc20_symbol(rpcUrl, logAddr).catch(function() { return null; });
                if (!sym) console.log('[BG] mantleGetBuysForToken: symbol lookup returned null for', logAddr);
              } catch (e) { sym = null; console.log('[BG] mantleGetBuysForToken: symbol lookup error for', logAddr, e && e.message); }
              symbolCache[logAddr] = sym;
            }

            // if the other token is WMNT (wrapped MNT), treat its amount as MNT spent
            if (sym && (sym || '').toUpperCase() === 'WMNT') {
              sumTokensRaw += tokenValRaw;
              sumMntRaw += otherAmtRaw;
              buys++;
              mntFound = true;
              console.log('[BG] mantleGetBuysForToken: detected WMNT payment', { token: token, tx: txhash, otherAddr: logAddr, otherAmtRaw: otherAmtRaw.toString() });
              break; // stop scanning logs for this tx
            }
          }
        }

        // fallback: if no WMNT transfer found, also check native tx value (some swaps may include native value)
        if (!mntFound) {
          try {
            // use RPC eth_getTransactionByHash to get native value
            var txres = await rpc(DEFAULT_RPC, 'eth_getTransactionByHash', [txhash]);
            if (txres) {
              var mntRawHex = txres.value || '0x0';
              var mntRaw = BigInt(mntRawHex);
              if (mntRaw > 0n) {
                sumTokensRaw += tokenValRaw;
                sumMntRaw += mntRaw;
                buys++;
                console.log('[BG] mantleGetBuysForToken: detected native MNT payment', { token: token, tx: txhash, mntRaw: mntRaw.toString() });
              }
            }
          } catch (e) {
            // ignore rpc errors for this tx
          }
        }
      } catch (e) {
        continue;
      }
    }

    if (sumTokensRaw === 0n || sumMntRaw === 0n) return { buys: buys, totalTokensRaw: sumTokensRaw.toString(), totalMntRaw: sumMntRaw.toString(), entryPriceMNT: null };

    // compute weighted average price in MNT per token
    var totalTokens = Number(sumTokensRaw) / Math.pow(10, decimals);
    var totalMnt = Number(sumMntRaw) / 1e18;
    var entryPriceMNT = totalMnt / totalTokens;

    return { buys: buys, totalTokensRaw: sumTokensRaw.toString(), totalMntRaw: sumMntRaw.toString(), entryPriceMNT: entryPriceMNT };
  } catch (e) {
    return null;
  }
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
      var tokenId = TOKEN_ID_MAP[token];

      // Obtener precio de entrada (weighted) basado en compras hacia la wallet
      var entryInfo = null;
      try {
        entryInfo = await mantleGetBuysForToken(wallet, token, dec);
      } catch (e) {
        entryInfo = null;
      }

      var entryPriceMNT = entryInfo && entryInfo.entryPriceMNT ? entryInfo.entryPriceMNT : null;
      var entryBuysCount = entryInfo && typeof entryInfo.buys === 'number' ? entryInfo.buys : 0;
      // totals from buys
      var boughtTokensRaw = entryInfo && entryInfo.totalTokensRaw ? String(entryInfo.totalTokensRaw) : null;
      var boughtMntRaw = entryInfo && entryInfo.totalMntRaw ? String(entryInfo.totalMntRaw) : null;
      var formattedBoughtTokens = null;
      var formattedBoughtMNT = null;
      var boughtUSD = null;
      var formattedBoughtUSD = null;
      try {
        if (boughtTokensRaw) {
          formattedBoughtTokens = formatTokenAmount(boughtTokensRaw, dec);
        }
        if (boughtMntRaw) {
          // format MNT amount as token with 18 decimals
          formattedBoughtMNT = formatTokenAmount(boughtMntRaw, 18) + ' MNT';
          var totalMntNum = Number(BigInt(boughtMntRaw)) / 1e18;
          var mntUsd2 = await getMntUsdPrice();
          if (mntUsd2) {
            boughtUSD = totalMntNum * mntUsd2;
            formattedBoughtUSD = formatUSD(boughtUSD);
          }
        }
      } catch (e) {
        // ignore formatting errors
      }
      // compute PnL in USD/percent if possible
      var pnlPct = null;
      var pnlUSD = null;
      var currentPriceUSD = priceData && priceData.priceUSD ? priceData.priceUSD : null;
      var mntUsd = null;
      try {
        if (entryPriceMNT != null && currentPriceUSD != null) {
          // fetch MNT->USD price (cached)
          mntUsd = await getMntUsdPrice();
          if (mntUsd && typeof mntUsd === 'number' && mntUsd > 0) {
            var entryPriceUSD = entryPriceMNT * mntUsd;
            if (entryPriceUSD > 0) {
              pnlPct = (currentPriceUSD / entryPriceUSD - 1) * 100;
              pnlUSD = (currentPriceUSD - entryPriceUSD) * balNum;
            }
          }
        }
      } catch (e) {
        // ignore
      }

      // debug log token PnL computation
      try {
        console.log('[BG] token PNL debug', {
          token: token,
          symbol: sym,
          entryPriceMNT: entryPriceMNT,
          currentPriceUSD: currentPriceUSD,
          mntUsd: mntUsd,
          pnlPct: pnlPct,
          pnlUSD: pnlUSD,
          entryInfo: entryInfo
        });
      } catch (e) { /* ignore logging errors */ }
      out.push({
        address: token,
        symbol: sym || "TOKEN",
        name: name || sym || "Token",
        decimals: dec,
        rawBalance: bal.toString(),
        formattedBalance: formattedBalance,
        valueUSD: valueUSD,
        formattedUSD: formattedUSD,
        change24: change24,
        tokenId: tokenId,
        entryPriceMNT: entryPriceMNT,
        entryBuys: entryBuysCount,
        boughtTokensRaw: boughtTokensRaw,
        formattedBoughtTokens: formattedBoughtTokens,
        boughtMntRaw: boughtMntRaw,
        formattedBoughtMNT: formattedBoughtMNT,
        boughtUSD: boughtUSD,
        formattedBoughtUSD: formattedBoughtUSD
        ,pnlPct: pnlPct,
        pnlUSD: pnlUSD,
        currentPriceUSD: currentPriceUSD
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

// Support long-lived port for scanning (keeps service worker alive during long operations)
chrome.runtime.onConnect.addListener(function(port) {
  if (!port || port.name !== 'scan-port') return;
  console.log('[BG] port connected:', port.name);
  port.onMessage.addListener(async function(msg) {
    try {
      if (msg && msg.type === 'SCAN_TOKENS_MS') {
        console.log('[BG] port: requested SCAN_TOKENS_MS');
        try {
          var t0 = performance.now();
          var items = await scanBalancesFromWalletStored();
          var t1 = performance.now();
          console.log('[BG] port SCAN_TOKENS_MS done', { count: items.length, ms: Math.round(t1 - t0) });
          port.postMessage({ ok: true, items: items });
        } catch (e) {
          console.warn('[BG] port SCAN_TOKENS_MS error:', e && e.message ? e.message : e);
          port.postMessage({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        // close the port when done
        try { port.disconnect(); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      console.warn('[BG] port message handler error:', err);
      try { port.postMessage({ ok: false, error: String(err) }); } catch (e) {}
      try { port.disconnect(); } catch (e) {}
    }
  });
});
