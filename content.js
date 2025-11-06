(() => {
  const WID = "printr-mini-pnl-banner";

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

  // Encontrar la barra de tabs BUY/SELL para insertar arriba
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

  // Slug del token desde /trade/:slug (puede ser 0x... largo o 20 bytes)
  function getTradeSlug() {
    const m = location.pathname.match(/\/trade\/(0x[0-9a-fA-F]+)/);
    return m ? m[1] : null;
  }

  // Pide /api/getToken/:slug y devuelve imageUrl (o null)
  async function fetchTokenImageUrl(slug) {
    if (!slug) return null;
    const url = `${location.origin}/api/getToken/${slug}`;
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: { "Accept": "*/*", "Referer": location.href }
      });
      if (!r.ok) return null;

      // El endpoint suele devolver JSON válido aun con content-type text/plain
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch { return null; }

      // Campo directo provisto por Printr
      const direct = j?.imageUrl || j?.image || j?.icon;
      if (typeof direct === "string" && direct.trim()) return direct.trim();

      // Fallbacks por si cambia la forma
      const nested =
        j?.token?.imageUrl ||
        j?.token?.image ||
        j?.data?.imageUrl ||
        j?.data?.image || null;
      if (typeof nested === "string" && nested.trim()) return nested.trim();

      return null;
    } catch {
      return null;
    }
  }

  // ===== UI =====
  function buildBanner() {
    const host = document.createElement("div");
    host.id = WID;
    host.style.margin = "6px 0";
    host.style.display = "block";
    host.style.width = "100%";
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
        margin-left: auto;            /* empuja el bloque a la derecha */
        max-width: max-content;       /* ancho del contenido */
        padding-right: 16px;          /* ajuste fino hacia la derecha */
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
      }

      /* icono: slot para el logo (con fallback "!") */
      .icon {
        width: 18px; height: 18px; border-radius: 50%;
        background: transparent;
        display: inline-flex; align-items: center; justify-content: center;
        overflow: hidden;
        border: 1px dashed rgba(187,187,187,.35);
        color: #bbb; font-size: 12px;
      }
      .icon img {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }

      /* blanco brillante para el nombre del token */
      .name {
        color: #ffffff !important;
        font-weight: 800;
        text-decoration: none;
        letter-spacing: 0.2px;
      }
      .name:hover { text-decoration: underline; }

      /* gris medio para el monto en USD */
      .val {
        color: #a0a0a0;
        opacity: 1;
        font-weight: 700;
      }

      /* PnL en verde (transparente) */
      .pct {
        font-weight: 800;
        font-size: 12px;
        color: rgb(78, 194, 23);
        background: transparent;
      }

      @media (prefers-color-scheme: light) {
        .icon { border-color: rgba(100,100,100,.35); color:#666; }
      }
    `;

    const body = document.createElement("div");
    body.className = "wrap";
    body.innerHTML = `
      <div class="icon" title="Token logo"><span>!</span></div>
      <a id="tkn" class="name" href="#" target="_blank" rel="noopener">BILLI</a>
      <div class="val">$20.42</div>
      <div class="pct">+4.25%</div>
    `;

    shadow.append(style, body);
    return host;
  }

  async function placeBanner() {
    if (document.getElementById(WID)) return true;

    const tabsBar = findTabsBar();
    if (!tabsBar || !tabsBar.parentElement) return false;

    const host = buildBanner();
    tabsBar.parentElement.insertBefore(host, tabsBar);

    // Link del nombre -> trade actual
    const slug = getTradeSlug();
    const href = slug ? `${location.origin}/trade/${slug}` : location.href;
    const a = host.shadowRoot.getElementById("tkn");
    if (a) a.href = href;

    // Cargar imagen desde /api/getToken/:slug → imageUrl
    try {
      const imgUrl = await fetchTokenImageUrl(slug);
      if (imgUrl) {
        const icon = host.shadowRoot.querySelector(".icon");
        icon.innerHTML = "";
        const img = document.createElement("img");
        img.src = imgUrl;            // usamos URL directa (cdn.printr.money)
        img.alt = "logo";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.onerror = () => { icon.textContent = "!"; }; // fallback
        icon.appendChild(img);
      }
    } catch {
      /* fallback "!" */
    }

    return true;
  }

  // Boot + SPA observers
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
