(function() {
  const WID = "printr-mini-pnl-banner";
  let hasLoadedOnce = false;
  
  console.log("[CS] content script loaded");

  // ===== Utils =====
  const isVisible = (el) => !!(el && el.offsetParent !== null);
  const up = (s) => (s || "").trim().toUpperCase();
  const elByText = (selector, starts) => {
    const nodes = document.querySelectorAll(selector);
    const needle = up(starts);
    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const t = up(n.textContent);
      if (t.startsWith(needle)) return n;
    }
    return null;
  };

  function findTabsBar() {
    const buy = elByText("[role='tab'],button,div,span,a", "BUY");
    console.log("[CS] findTabsBar: buy button found?", !!buy);
    if (!buy) return null;
    let cur = buy;
    for (let i = 0; i < 6 && cur?.parentElement; i++) {
      const parent = cur.parentElement;
      const hasSell = Array.from(parent.querySelectorAll("[role='tab'],button,div,span,a"))
        .some((n) => isVisible(n) && up(n.textContent).startsWith("SELL"));
      if (hasSell) {
        console.log("[CS] findTabsBar: found tabs bar container");
        return parent;
      }
      cur = parent;
    }
    console.log("[CS] findTabsBar: tabs bar not found");
    return null;
  }

  // ===== UI =====
  function buildBanner() {
    console.log("[CS] buildBanner: creating banner");
    const host = document.createElement("div");
    host.id = WID;
    host.style.margin = "6px 0";
    host.style.display = "block";
    host.style.width = "100%";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .wrap {
        font-family: "PP Monument Extended", ui-sans-serif, system-ui, sans-serif;
        font-weight: 700;
        letter-spacing: 0.3px;
        display: flex;
        align-items: center;
        gap: 10px;
        margin-left: auto;
        max-width: 100%;
        padding-right: 16px;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
      }
      .row {
        display: flex; gap: 16px; flex-wrap: wrap;
        justify-content: flex-end; width: 100%;
      }
      .item {
        display: inline-flex; align-items: center; gap: 8px;
        background: transparent;
      }
      .name { color:#ffffff !important; font-weight:800; text-decoration:none; }
      .name:hover{ text-decoration: underline; }
      .val { color:#a0a0a0; opacity:1; font-weight:700; }
      .pct { font-weight:800; font-size:12px; color:rgb(78,194,23); }
      .wal { margin-left: 8px; color:#8b8b8b; font-weight:600; font-size:12px }
    `;

    const body = document.createElement("div");
    body.className = "wrap";
    body.innerHTML = `
      <div class="row" id="tokensRow"></div>
      <span id="wal" class="wal"></span>
    `;

    shadow.append(style, body);
    return host;
  }

  function ensureBanner() {
    if (document.getElementById(WID)) {
      console.log("[CS] ensureBanner: banner already exists");
      return document.getElementById(WID);
    }
    const tabsBar = findTabsBar();
    if (!tabsBar || !tabsBar.parentElement) {
      console.log("[CS] ensureBanner: tabs bar not found, cannot insert banner");
      return null;
    }
    const host = buildBanner();
    tabsBar.parentElement.insertBefore(host, tabsBar);
    console.log("[CS] ensureBanner: banner inserted successfully");
    return host;
  }

  function setWalletBadge(addr) {
    console.log("[CS] setWalletBadge:", addr);
    const host = document.getElementById(WID);
    const r = host?.shadowRoot;
    if (!r) {
      console.log("[CS] setWalletBadge: no shadowRoot found");
      return false;
    }
    const el = r.querySelector("#wal");
    if (!el) {
      console.log("[CS] setWalletBadge: wallet element not found");
      return false;
    }
    if (addr && /^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      const compact = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      el.textContent = `(${compact})`;
      console.log("[CS] setWalletBadge: set to", compact);
    } else {
      el.textContent = "";
    }
    return true;
  }

  function renderTokens(tokens) {
    console.log("[CS] renderTokens: rendering", tokens?.length || 0, "tokens");
    const host = document.getElementById(WID);
    const r = host?.shadowRoot;
    if (!r) {
      console.log("[CS] renderTokens: no shadowRoot");
      return;
    }
    const row = r.getElementById("tokensRow");
    if (!row) {
      console.log("[CS] renderTokens: tokensRow element not found");
      return;
    }

    row.textContent = "";
    if (!tokens || tokens.length === 0) {
      const span = document.createElement("span");
      span.className = "val";
      span.textContent = "No tokens with balance";
      row.appendChild(span);
      console.log("[CS] renderTokens: no tokens to display");
      return;
    }

    for (const t of tokens) {
      const a = document.createElement("a");
      a.className = "name";
      a.href = "#";
      a.target = "_blank";
      a.textContent = t.symbol || t.name || "TOKEN";

      const val = document.createElement("span");
      val.className = "val";
      // Priorizar USD, si no hay mostrar cantidad
      if (t.formattedUSD) {
        val.textContent = t.formattedUSD;
      } else {
        val.textContent = t.formattedBalance || "0";
      }
      
      console.log("[CS] Token:", t.symbol, "formattedUSD:", t.formattedUSD, "formattedBalance:", t.formattedBalance);

      const pct = document.createElement("span");
      pct.className = "pct";
      // Mostrar cambio real de 24h si esta disponible
      if (t.change24 !== null && t.change24 !== undefined) {
        const change = t.change24 * 100;
        const sign = change >= 0 ? "+" : "";
        pct.textContent = sign + change.toFixed(2) + "%";
        // Cambiar color segun si es positivo o negativo
        if (change < 0) {
          pct.style.color = "rgb(239,68,68)"; // rojo
        }
      } else {
        pct.textContent = "+4.25%";
      }

      const item = document.createElement("div");
      item.className = "item";
      item.append(a, val, pct);

      row.appendChild(item);
    }
    console.log("[CS] renderTokens: rendered", tokens.length, "tokens successfully");
  }

  function showLoading() {
    console.log("[CS] showLoading");
    const host = document.getElementById(WID);
    const r = host?.shadowRoot;
    const row = r?.getElementById("tokensRow");
    if (!row) {
      console.log("[CS] showLoading: tokensRow not found");
      return;
    }
    row.textContent = "";
    const span = document.createElement("span");
    span.className = "val";
    span.textContent = "Loading tokens...";
    row.appendChild(span);
  }

  function showError(message) {
    console.log("[CS] showError:", message);
    const host = document.getElementById(WID);
    const r = host?.shadowRoot;
    const row = r?.getElementById("tokensRow");
    if (!row) return;
    row.textContent = "";
    const span = document.createElement("span");
    span.className = "val";
    span.textContent = message;
    row.appendChild(span);
  }

  async function requestAndRenderIfWallet() {
    console.log("[CS] requestAndRenderIfWallet: starting");
    
    let tries = 0;
    while (!ensureBanner() && tries < 50) {
      await new Promise((r) => setTimeout(r, 200));
      tries++;
    }

    if (!document.getElementById(WID)) {
      console.log("[CS] requestAndRenderIfWallet: failed to create banner after", tries, "tries");
      return;
    }

    console.log("[CS] requestAndRenderIfWallet: banner ready, requesting wallet from background");

    if (!hasLoadedOnce) {
      showLoading();
    }

    console.log("[CS] requestAndRenderIfWallet: sending SCAN_TOKENS_MS message to background");
    
    try {
      chrome.runtime.sendMessage({ type: "SCAN_TOKENS_MS" }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error("[CS] sendMessage error:", chrome.runtime.lastError.message);
          if (!hasLoadedOnce) {
            showError("Connection error");
          }
          return;
        }
        
        console.log("[CS] requestAndRenderIfWallet: received response:", resp);
        
        if (!resp?.ok) {
          console.warn("[CS] scan error:", resp?.error);
          if (!hasLoadedOnce) {
            showError(resp?.error || "Scan error");
          }
          return;
        }
        
        if (resp.items && resp.items.length >= 0) {
          chrome.runtime.sendMessage({ type: "GET_WALLET" }, (walletResp) => {
            if (walletResp?.wallet) {
              setWalletBadge(walletResp.wallet);
            }
          });
        }
        
        console.log("[CS] requestAndRenderIfWallet: rendering tokens", resp.items);
        renderTokens(resp.items || []);
        hasLoadedOnce = true;
      });
    } catch (e) {
      console.error("[CS] requestAndRenderIfWallet: exception:", e);
      if (!hasLoadedOnce) {
        showError("Exception: " + e.message);
      }
    }
  }

  // ===== Boot/SPA =====
  console.log("[CS] setting up observers and listeners");
  
  const mo = new MutationObserver(() => {
    if (!document.getElementById(WID)) {
      ensureBanner();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  const trig = () => {
    console.log("[CS] navigation detected, ensuring banner");
    queueMicrotask(() => {
      ensureBanner();
      setTimeout(() => requestAndRenderIfWallet(), 1000);
    });
  };
  
  history.pushState = function () { 
    const r = origPush.apply(this, arguments); 
    trig(); 
    return r; 
  };
  history.replaceState = function () { 
    const r = origReplace.apply(this, arguments); 
    trig(); 
    return r; 
  };
  window.addEventListener("popstate", trig);

  if (document.readyState === "loading") {
    console.log("[CS] waiting for DOMContentLoaded");
    document.addEventListener("DOMContentLoaded", () => {
      console.log("[CS] DOMContentLoaded fired");
      ensureBanner();
      setTimeout(() => requestAndRenderIfWallet(), 500);
    }, { once: true });
  } else {
    console.log("[CS] document already ready");
    ensureBanner();
    setTimeout(() => requestAndRenderIfWallet(), 500);
  }

  chrome.runtime.onMessage?.addListener((msg) => {
    console.log("[CS] received message from background:", msg);
    if (msg?.type === "WALLET_UPDATE" && msg.wallet) {
      console.log("[CS] WALLET_UPDATE received, refreshing");
      setTimeout(() => {
        setWalletBadge(msg.wallet);
        requestAndRenderIfWallet();
      }, 500);
    }
  });

  console.log("[CS] content script initialization complete");
})();