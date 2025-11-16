// content-summary-clean.js
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
    c.style.background = '#111214';
    c.style.color = '#fff';
    c.style.borderRadius = '10px';
    c.style.padding = '12px 14px';
    c.style.margin = '8px 0';
    c.style.boxShadow = '0 2px 12px rgba(0,0,0,0.6)';
    c.style.maxWidth = '420px';
    c.style.fontFamily = 'inherit';
    c.style.fontSize = '13px';
    c.style.lineHeight = '1.3';
    // optional debug outline
    if (DEBUG) c.style.outline = '1px dashed #8a2be2';
    c.innerHTML = `<div style="font-weight:700;margin-bottom:6px">Printr summary</div><div>${msg}</div>`;
    return c;
  }

  function insertAboveXchain(node){
    const btn = findXchainButton();
    if (btn && btn.parentNode){
      try {
        btn.parentNode.insertBefore(node, btn);
        if (DEBUG) console.log('[CS-SUMMARY] inserted above XCHAIN');
        return true;
      } catch(e){ if (DEBUG) console.warn('[CS-SUMMARY] insert error', e); }
    }
    // fallback: prepend to body
    document.body.prepend(node);
    if (DEBUG) console.log('[CS-SUMMARY] inserted to body (fallback)');
    return false;
  }

  function removeExisting(tokenRef){
    try{
      const id = tokenRef ? ('printr-summary-' + tokenRef.value.replace(/^0x/,'') ) : 'printr-summary-global';
      const prev = document.getElementById(id);
      if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    }catch(e){}
  }

  function insertMessage(tokenRef, msg){
    const id = tokenRef ? ('printr-summary-' + tokenRef.value.replace(/^0x/,'') ) : 'printr-summary-global';
    removeExisting(tokenRef);
    const c = createContainerNode(msg);
    c.id = id;
    insertAboveXchain(c);
  }

  // Main injection: get the tool wallet from background and request token scan
  async function injectForCurrentToken(){
    try{
      const tokenRef = getTokenAddressFromUrl();
      if (!tokenRef){ if (DEBUG) console.log('[CS-SUMMARY] no tokenRef in URL'); return; }

      // ask background for the stored site wallet (uses same mechanism as content.js)
      chrome.runtime.sendMessage({ type: 'GET_WALLET' }, function(resp){
        const wallet = resp && resp.ok ? resp.wallet : null;
        if (DEBUG) console.log('[CS-SUMMARY] GET_WALLET ->', resp);
        if (!wallet){
          insertMessage(tokenRef, 'Conectá tu wallet en la página para ver el resumen.');
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
                const bal = token.formattedBalance || token.rawBalance || '0';
                const usd = token.formattedUSD || '$0.00';
                const pct = (token.pnlPct != null) ? (Math.round((token.pnlPct||0)*100)/100 + '%') : '';
                const msg = `<div><b>${token.symbol||token.name||'Token'}</b></div><div>Bal: ${bal} · ${usd} ${pct}</div>`;
                insertMessage(tokenRef, msg);
              }

              try{ port.disconnect(); }catch(e){}
            }catch(e){ if (DEBUG) console.error('[CS-SUMMARY] port onMessage error', e); }
          });
          port.postMessage({ type: 'SCAN_TOKENS_MS' });
        }catch(e){
          if (DEBUG) console.error('[CS-SUMMARY] port connect error', e);
          insertMessage(tokenRef, 'Error al solicitar datos al fondo.');
        }

      });

    }catch(e){ if (DEBUG) console.error('[CS-SUMMARY] inject error', e); }
  }

  // Run on load and SPA navigation
  window.addEventListener('DOMContentLoaded', injectForCurrentToken);
  const _push = history.pushState; history.pushState = function(){ const r = _push.apply(this, arguments); setTimeout(injectForCurrentToken, 300); return r; };
  const _replace = history.replaceState; history.replaceState = function(){ const r = _replace.apply(this, arguments); setTimeout(injectForCurrentToken, 300); return r; };
  window.addEventListener('popstate', () => setTimeout(injectForCurrentToken, 300));

  // Also listen for WALLET_UPDATE broadcasts (background sends these when it detects the site wallet)
  chrome.runtime.onMessage?.addListener((msg)=>{
    try{ if (msg && msg.type === 'WALLET_UPDATE') setTimeout(injectForCurrentToken, 200); }catch(e){}
  });

})();
