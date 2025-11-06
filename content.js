(() => {
  const WID = "printr-mini-pnl-banner";

  // ————— Utils —————
  const log = (...a) => console.log("[Banner]", ...a);
  const isAddr20 = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || "");
  const isVisible = (el) => !!(el && el.offsetParent !== null);

  function elByText(selector, starts) {
    const nodes = document.querySelectorAll(selector);
    const up = (s) => (s || "").trim().toUpperCase();
    const needle = up(starts);
    for (const n of nodes) {
      const t = up(n.textContent);
      if (t.startsWith(needle) && isVisible(n)) return n;
    }
    return null;
  }

  // Encuentra el contenedor del panel derecho (BUY/SELL).
  // Estrategia:
  //  A) Buscar cabecera "YOU PAY" → subir hasta “card” contenedora.
  //  B) Si falla, localizar la pestaña "BUY" visible y subir.
  function findRightPanel() {
    // A) YOU PAY
    let mark = elByText("div,span,p,label,h3,h4", "YOU PAY");
    if (mark) {
      let node = mark;
      for (let i = 0; i < 8 && node?.parentElement; i++) {
        const cs = getComputedStyle(node);
        // heurística: contenedor con padding o borde distinto de none
        const padded = (cs.paddingLeft !== "0px" || cs.paddingTop !== "0px");
        const bordered = cs.borderStyle && cs.borderStyle !== "none";
        if ((padded || bordered) && node.querySelector && node.querySelector("input,button,[role='tab']")) {
          log("Right panel by YOU PAY");
          return node;
        }
        node = node.parentElement;
      }
    }

    // B) BUY tab visible
    mark =
      elByText("[role='tab']", "BUY") ||
      elByText("button,div,span,a", "BUY");
    if (mark) {
      let node = mark;
      for (let i = 0; i < 8 && node?.parentElement; i++) {
        const cs = getComputedStyle(node);
        const padded = (cs.paddingLeft !== "0px" || cs.paddingTop !== "0px");
        const bordered = cs.borderStyle && cs.borderStyle !== "none";
        if ((padded || bordered) && node.querySelector && node.querySelector("input,button,label")) {
          log("Right panel by BUY tab");
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  // Construye el banner (shadow DOM para aislar estilos)
  function buildBanner() {
    const host = document.createElement("div");
    host.id = WID;
    host.style.margin = "10px 0 10px 0";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      .wrap{
        display:flex;align-items:center;gap:10px;
        padding:10px 12px;border-radius:12px;
        background:rgba(20,20,20,.85);color:#fff;
        border:1px solid rgba(255,255,255,.08);
        box-shadow:0 8px 24px rgba(0,0,0,.25);
        font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif
      }
      .icon{
        width:22px;height:22px;border-radius:50%;
        background:#2a2a2a;display:inline-flex;align-items:center;justify-content:center;
        font-size:12px;color:#bbb
      }
      .name{
        font-weight:800;letter-spacing:.2px;text-decoration:none;color:inherit;outline:0
      }
      .name:hover{text-decoration:underline}
      .val{opacity:.85;font-weight:700}
      .grow{flex:1 1 auto}
      .pill{padding:4px 8px;border-radius:999px;font-weight:800;font-size:12px;background:rgba(22,163,74,.15);color:#16a34a}
      @media (prefers-color-scheme:light){
        .wrap{background:rgba(255,255,255,.92);color:#111;border-color:rgba(0,0,0,.08)}
        .icon{background:#eaeaea;color:#666}
      }
    `;

    const body = document.createElement("div");
    body.className = "wrap";
    body.innerHTML = `
      <div class="icon" title="Icono pendiente">!</div>
      <a id="tkn" class="name" href="#" target="_blank" rel="noopener">BILLI</a>
      <div class="val">$20.42</div>
      <div class="grow"></div>
      <div class="pill">+4.25%</div>
    `;

    shadow.append(style, body);
    return host;
  }

  async function resolveLinkForCurrent() {
    // Usamos el mismo trade actual; dejamos hook para parsear la API luego.
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

    const panel = findRightPanel();
    if (!panel || !panel.parentElement) return false;

    const host = buildBanner();
    // Insertar EXACTAMENTE arriba del panel (antes del nodo panel)
    panel.parentElement.insertBefore(host, panel);

    // link clickeable en “BILLI”
    resolveLinkForCurrent().then((href) => {
      const a = host.shadowRoot && host.shadowRoot.getElementById("tkn");
      if (a) a.href = href || "#";
    });

    log("Banner inserted");
    return true;
  }

  // ——— Boot + reintentos en SPA ———
  // Intento inmediato + poll corto por si el DOM tarda
  let tries = 0;
  function bootTry() {
    if (placeBanner()) return;
    if (++tries < 30) setTimeout(bootTry, 200); // reintenta 6s en total
  }

  // Observer para navegaciones internas y cambios de DOM
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
