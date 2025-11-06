(() => {
  const WID = "printr-mini-pnl-banner";

  // Utils
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
    if (!buy) return null;
    let cur = buy;
    for (let i = 0; i < 6 && cur?.parentElement; i++) {
      const parent = cur.parentElement;
      const hasSell = Array.from(parent.querySelectorAll("[role='tab'],button,div,span,a"))
        .some(n => isVisible(n) && up(n.textContent).startsWith("SELL"));
      if (hasSell) return parent;
      cur = parent;
    }
    return null;
  }

  function buildBanner() {
    const host = document.createElement("div");
    host.id = WID;
    host.style.margin = "6px 0";
    host.style.display = "block";
    host.style.width = "100%";            // ocupa todo el ancho del panel
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      /* El contenedor interno se alinea a la derecha */
      .wrap {
        font-family: "PP Monument Extended", ui-sans-serif, system-ui, sans-serif;
        font-weight: 700;
        letter-spacing: 0.3px;
        display: flex;
        align-items: center;
        gap: 10px;
        margin-left: auto;
        max-width: max-content;
        padding-right: 16px;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
      }

        /* blanco brillante para el nombre del token */
      .name {
        color: #ffffff;
        font-weight: 800;
        text-decoration: none;
      }
        .name:hover {
        text-decoration: underline;
      }

        /* gris medio para el monto en USD */
      .val {
        color: #a0a0a0;
        opacity: 1;
        font-weight: 700;
      }

        /* verde o rojo para el PnL (según profit/loss) */
      .pct {
        font-weight: 800;
        font-size: 12px;
        color: rgb(78, 194, 23); /* verde por defecto */
        background: transparent;
      }
      .icon{
        width:18px;height:18px;border-radius:50%;
        background:transparent;
        display:inline-flex;align-items:center;justify-content:center;
        font-size:12px;color:#bbb;
        border:1px dashed rgba(187,187,187,.35);
      }
      .name:hover{text-decoration:underline}
      .val{opacity:.9;font-weight:700}
      @media (prefers-color-scheme:light){
        .icon{border-color:rgba(100,100,100,.35); color:#666}
      }
    `;

    const body = document.createElement("div");
    body.className = "wrap";
    body.innerHTML = `
      <div class="icon" title="Icono pendiente">!</div>
      <a id="tkn" class="name" href="#" target="_blank" rel="noopener">BILLI</a>
      <div class="val">$20.42</div>
      <div class="pct">+4.25%</div>
    `;

    shadow.append(style, body);
    return host;
  }

  async function resolveLinkForCurrent() {
    const m = location.pathname.match(/\/trade\/(0x[0-9a-fA-F]+)/);
    if (!m) return location.href;
    const slug = m[1];
    try {
      await fetch(`${location.origin}/api/getToken/${slug}`, {
        method: "GET",
        headers: { "Accept": "*/*", "Referer": location.href }
      });
    } catch {}
    return `${location.origin}/trade/${slug}`;
  }

  function placeBanner() {
    if (document.getElementById(WID)) return true;
    const tabsBar = findTabsBar();
    if (!tabsBar || !tabsBar.parentElement) return false;

    const host = buildBanner();
    tabsBar.parentElement.insertBefore(host, tabsBar);

    resolveLinkForCurrent().then((href) => {
      const a = host.shadowRoot && host.shadowRoot.getElementById("tkn");
      if (a) a.href = href || "#";
    });
    return true;
  }

  let tries = 0;
  function bootTry() {
    if (placeBanner()) return;
    if (++tries < 30) setTimeout(bootTry, 200);
  }

  const mo = new MutationObserver(() => placeBanner());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const origPush = history.pushState, origReplace = history.replaceState;
  const trig = () => queueMicrotask(placeBanner);
  history.pushState = function(){ const r = origPush.apply(this, arguments); trig(); return r; };
  history.replaceState = function(){ const r = origReplace.apply(this, arguments); trig(); return r; };
  window.addEventListener("popstate", trig);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootTry, { once:true });
  } else {
    bootTry();
  }
})();
