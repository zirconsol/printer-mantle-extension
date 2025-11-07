// content-summary.js
// Injects a small token summary container above the "XCHAIN" button on Printr pages.

(function(){
  const DEBUG = true;
  if (DEBUG) console.log('[CS-SUMMARY] loaded');

  function up(s){ return (s||'').trim().toUpperCase(); }
  function isVisible(el){ return !!(el && el.offsetParent !== null); }

  function getTokenAddressFromUrl(){
    const p = window.location.pathname;
    let m = p.match(/\/trade\/(0x[0-9a-fA-F]{64})/);
    if (m) return { type: 'tokenId', value: m[1].toLowerCase() };
    m = p.match(/\/trade\/(0x[0-9a-fA-F]{40})/);
    if (m) return { type: 'address', value: m[1].toLowerCase() };
    return null;
  }

  function tokenSummaryHTML(token){
    const name = (token.symbol || token.name || 'Token');
    const bal = token.formattedBalance || token.rawBalance || '0';
    const usd = token.formattedUSD || '$0.00';
    const pct = (token.pnlPct != null) ? (Math.round((token.pnlPct||0)*100)/100 + '%') : '&mdash;';
    const totalProfit = (token.pnlUSD != null) ? ((token.pnlUSD >= 0 ? '' : '-') + '$' + Math.abs(token.pnlUSD).toFixed(2)) : '&mdash;';
    const boughtTokens = token.formattedBoughtTokens || null;
    const boughtAmount = token.formattedBoughtUSD || token.formattedBoughtMNT || null;
    const tile = 'padding:8px 10px;border-radius:8px;display:flex;flex-direction:column;gap:2px;min-height:28px;';
    const k = 'font-size:9px;font-weight:600;color:#b0b0b0;letter-spacing:.2px;';
    const v = 'font-size:12px;font-weight:600;color:#ffffff;';
    const vSub = 'font-size:8px;font-weight:600;color:#c8c8c8;';
    return `
      <div class="printr-summary-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;width:100%">
        <div class="printr-summary-tile" style="${tile}">
          <div style="${k}">${name} Bal</div>
          <div style="${v}">${usd}</div>
          <div style="${vSub}">${bal}</div>
        </div>
        <div class="printr-summary-tile" style="${tile}">
          <div style="${k}">Unrealized</div>
          <div style="${v}color: rgb(186, 250, 119)">${totalProfit}</div>
          <div style="font-size:8px;font-weight:700;color: rgb(186, 250, 119)">${pct}</div>
        </div>
        <div class="printr-summary-tile" style="${tile}">
          <div style="${k}">Realized</div>
          <div style="${v}">&mdash;</div>
          <div style="${vSub}">&mdash;</div>
        </div>
        <div class="printr-summary-tile" style="${tile}">
          <div style="${k}">Current Bought/Avg</div>
          <div style="${v}">${boughtTokens || '&mdash;'}</div>
          <div style="${vSub}">${boughtAmount || '&mdash;'}</div>
        </div>
        <div class="printr-summary-tile" style="${tile}">
          <div style="${k}">Current Sold/Avg</div>
          <div style="${v}">&mdash;</div>
          <div style="${vSub}">&mdash;</div>
        </div>
        <div class="printr-summary-tile" style="${tile}">
          <div style="${k}">Current Total Profit</div>
          <div style="${v}color: rgb(186, 250, 119)">${totalProfit}</div>
          <div style="font-size:8px;font-weight:700;color: rgb(186, 250, 119)">${pct}</div>
        </div>
      </div>
    `;
  }

  function setupResponsivePadding(host){
    const apply = () => {
      try{
        const w = host.offsetWidth || window.innerWidth || 0;
        let padX = 12, padY = 8, tilePadX = 10, tilePadY = 8, gap = 8;
        if (w < 900){ padX = 10; padY = 6; tilePadX = 8; tilePadY = 6; gap = 6; }
        if (w < 700){ padX = 8;  padY = 4; tilePadX = 6; tilePadY = 4; gap = 6; }
        if (w < 500){ padX = 6;  padY = 3; tilePadX = 5; tilePadY = 3; gap = 4; }
        host.style.padding = padY + 'px ' + padX + 'px';
        const grid = host.querySelector('.printr-summary-grid');
        if (grid) grid.style.gap = gap + 'px';
        const tiles = host.querySelectorAll('.printr-summary-tile');
        tiles.forEach(t => { t.style.padding = tilePadY + 'px ' + tilePadX + 'px'; });
      }catch(e){}
    };
    const schedule = () => requestAnimationFrame(apply);
    schedule();
    try{
      const ro = new ResizeObserver(schedule);
      ro.observe(host);
      host.__psb_ro = ro;
    }catch(e){}
    window.addEventListener('resize', schedule);
  }

  function insertTokenSummary(tokenRef, token){
    const id = tokenRef ? ('printr-summary-' + tokenRef.value.replace(/^0x/,'') ) : 'printr-summary-global';
    removeExisting();
    const c = createContainerNode(tokenSummaryHTML(token));
    c.id = id;
    let inserted = false;
    const slot = ensureSlotBetweenChartAndMetrics?.();
    if (slot){ try{ slot.appendChild(c); inserted = true; }catch(e){} }
    if (!inserted && !insertBeforeActionsRow(c)){
      if (!insertBeforeXchain(c)){
        document.body.prepend(c);
        if (DEBUG) console.log('[CS-SUMMARY] inserted to body (fallback)');
      } else { inserted = true; }
    } else if (!inserted) { inserted = true; }
    if (inserted || c.isConnected) setupResponsivePadding(c);
  }

  function findXchainButton(){
    const nodes = document.querySelectorAll('button, [role="button"], a');
    for (const n of nodes){
      if (!isVisible(n)) continue;
      const txt = up(n.textContent || '');
      if (txt === 'XCHAIN' || txt.startsWith('XCHAIN')) return n;
    }
    return null;
  }

  function createContainerNode(msg){
    const c = document.createElement('div');
    c.className = 'printr-summary-box';
    // Full-width rectangular bar styled like Printr chips, but rectangular
    c.style.background = 'rgb(25, 25, 25)';
    c.style.color = '#fff';
    c.style.border = '1.33333px solid rgb(43, 43, 43)';
    c.style.borderRadius = '10px';
    c.style.padding = '8px 12px';
    c.style.margin = '8px 0';
    c.style.boxShadow = 'none';
    c.style.width = '100%';
    c.style.maxWidth = '100%';
    c.style.boxSizing = 'border-box';
    c.style.display = 'flex';
    c.style.alignItems = 'center';
    c.style.columnGap = '8px';
    c.style.rowGap = '8px';
    c.style.minHeight = '28px';
    c.style.fontFamily = 'PP Monument Extended, ui-sans-serif, system-ui, sans-serif';
    c.style.fontSize = '10px';
    c.style.lineHeight = '14px';
    if (DEBUG) c.style.outline = '1px rgba(43, 43, 43,0.5)';
    if (msg != null) c.innerHTML = msg;
    return c;
  }

  function findActionsRowContainer(){
    const btn = findXchainButton();
    if (!btn) return null;
    const wanted = ['XCHAIN','HOLDERS','TRANSACTIONS','TXNS','TRADES'];
    function hasWanted(root){
      const nodes = root.querySelectorAll("[role='tab'], button, [role='button'], a");
      const texts = Array.from(nodes).filter(isVisible).map(n => up(n.textContent||''));
      const hasX = texts.some(t => t.includes('XCHAIN'));
      const hasAny = texts.some(t => wanted.some(w => w!== 'XCHAIN' && t.includes(w)));
      return hasX && hasAny;
    }
    let cur = btn;
    for (let i=0; i<6 && cur && cur.parentElement; i++){
      const p = cur.parentElement;
      if (hasWanted(p)) return p;
      cur = p;
    }
    return null;
  }

  // Preferred slot: between TradingView chart wrapper and the metrics pills row
  function findChartWrapper(){
    try{
      const ifr = Array.from(document.querySelectorAll('iframe[title="Financial Chart"], iframe[id^="tradingview_"]'));
      for (const f of ifr){
        const parent = f.closest('div.border, div.border-border');
        if (parent) return parent;
      }
    }catch(e){}
    return null;
  }

  function findMetricsPillsRow(){
    try{
      const rows = Array.from(document.querySelectorAll('div.flex.flex-wrap.items-center.gap-2, div.flex.items-center.gap-2'));
      const wanted = ['LIQUIDITY','HOLDERS','VOLUME','PRICE','TXNS','24H','1H','4H','5M'];
      for (const r of rows){
        const txt = (r.textContent||'').toUpperCase();
        if (wanted.some(w => txt.includes(w))) return r;
      }
    }catch(e){}
    return null;
  }

  function ensureSlotBetweenChartAndMetrics(){
    try{
      const CHART = findChartWrapper();
      const PILLS = findMetricsPillsRow();
      if (!CHART || !PILLS) return null;
      const parent = CHART.parentElement;
      if (!parent || parent !== PILLS.parentElement) return null;
      let slot = parent.querySelector('#printr-summary-slot');
      if (!slot){
        slot = document.createElement('div');
        slot.id = 'printr-summary-slot';
        slot.style.width = '100%';
        slot.style.margin = '6px 0';
        try { parent.insertBefore(slot, PILLS); } catch (e) { return null; }
      }
      return slot;
    }catch(e){ return null; }
  }

  function insertBeforeActionsRow(node){
    const row = findActionsRowContainer();
    if (row && row.parentNode){
      try{
        row.parentNode.insertBefore(node, row);
        if (DEBUG) console.log('[CS-SUMMARY] inserted before actions row');
        return true;
      }catch(e){ if (DEBUG) console.warn('[CS-SUMMARY] insert before actions error', e); }
    }
    return false;
  }

  function insertBeforeXchain(node){
    const btn = findXchainButton();
    if (btn && btn.parentNode){
      try{
        btn.parentNode.insertBefore(node, btn);
        if (DEBUG) console.log('[CS-SUMMARY] inserted above XCHAIN');
        return true;
      }catch(e){ if (DEBUG) console.warn('[CS-SUMMARY] insert above XCHAIN error', e); }
    }
    return false;
  }

  function removeExisting(){
    try{
      const nodes = document.querySelectorAll('.printr-summary-box');
      nodes.forEach(n => { try{ n.parentNode?.removeChild(n); }catch(e){} });
    }catch(e){}
  }

  function insertMessage(tokenRef, msg){
    const id = tokenRef ? ('printr-summary-' + tokenRef.value.replace(/^0x/,'') ) : 'printr-summary-global';
    removeExisting();
    const c = createContainerNode(msg);
    c.id = id;
    if (!insertBeforeActionsRow(c)){
      if (!insertBeforeXchain(c)){
        document.body.prepend(c);
        if (DEBUG) console.log('[CS-SUMMARY] inserted to body (fallback)');
      }
    }
  }

  // Main injection: get the tool wallet from background and request token scan
  async function injectForCurrentToken(){
    try{
      const tokenRef = getTokenAddressFromUrl();
      if (!tokenRef){ if (DEBUG) console.log('[CS-SUMMARY] no tokenRef in URL'); return; }
      // Wait for actions row to be present to avoid hydration issues and ensure correct placement
      if (!findActionsRowContainer() && !findXchainButton()){
        if (DEBUG) console.log('[CS-SUMMARY] actions row not ready; retrying soon');
        setTimeout(injectForCurrentToken, 600);
        return;
      }

      // ask background for the stored site wallet (uses same mechanism as content.js)
      chrome.runtime.sendMessage({ type: 'GET_WALLET' }, function(resp){
        const wallet = resp && resp.ok ? resp.wallet : null;
        if (DEBUG) console.log('[CS-SUMMARY] GET_WALLET ->', resp);
        if (!wallet){
          insertMessage(tokenRef, 'LOADING TOKEN...');
          return;
        }

        // open long-lived port to ask for scan; background will scan stored wallet and return items
        try{
          const port = chrome.runtime.connect({ name: 'scan-port' });
          port.onMessage.addListener(function(m){
            try{
              if (!m || !m.ok){
                insertMessage(tokenRef, 'No se pudieron obtener los datos del wallet.');
                try{ port.disconnect(); }catch(e){}
                return;
              }
              const items = m.items || [];
              if (DEBUG) console.log('[CS-SUMMARY] port items count', items.length);
              // find matching token by address or tokenId
              let token = null;
              if (tokenRef.type === 'address') token = items.find(t => (t.address||'').toLowerCase() === tokenRef.value);
              else if (tokenRef.type === 'tokenId') token = items.find(t => (t.tokenId||'').toLowerCase() === tokenRef.value || (t.id||'').toLowerCase() === tokenRef.value);

              if (!token){
                insertMessage(tokenRef, 'No hay datos de este token en tu wallet.');
              } else {
                insertTokenSummary(tokenRef, token);
              }

              try{ port.disconnect(); }catch(e){}
            }catch(e){ if (DEBUG) console.error('[CS-SUMMARY] port onMessage error', e); }
          });
          port.postMessage({ type: 'SCAN_TOKENS_MS' });
        }catch(e){
          if (DEBUG) console.error('[CS-SUMMARY] port connect error', e);
          insertMessage(tokenRef, 'Error al solicitar datos al servicio de fondo.');
        }

      });

    }catch(e){ if (DEBUG) console.error('[CS-SUMMARY] inject error', e); }
  }

  // Run on load and SPA navigation (delay a bit to avoid SSR hydration conflicts)
  if (document.readyState === 'complete') {
    setTimeout(injectForCurrentToken, 800);
  } else {
    window.addEventListener('load', () => setTimeout(injectForCurrentToken, 800), { once: true });
  }
  const _push = history.pushState; history.pushState = function(){ const r = _push.apply(this, arguments); setTimeout(injectForCurrentToken, 300); return r; };
  const _replace = history.replaceState; history.replaceState = function(){ const r = _replace.apply(this, arguments); setTimeout(injectForCurrentToken, 300); return r; };
  window.addEventListener('popstate', () => setTimeout(injectForCurrentToken, 300));

  // Also listen for WALLET_UPDATE broadcasts (background sends these when it detects the site wallet)
  chrome.runtime.onMessage?.addListener((msg)=>{
    try{ if (msg && msg.type === 'WALLET_UPDATE') setTimeout(injectForCurrentToken, 200); }catch(e){}
  });

})();
