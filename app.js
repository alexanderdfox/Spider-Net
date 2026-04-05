/**
 * Spider-Net — client-side crawl orchestration with fabrilis-inspired phases.
 * Phases: patrol (territory sweep), strike (deep follow), weave (fetch), retreat (recover).
 */

(function () {
  "use strict";

  const PHASE = {
    IDLE: "idle",
    PATROL: "patrol_territory",
    STRIKE: "strike_trail",
    WEAVE: "weave_silk",
    RETREAT: "retreat",
  };

  const canvas = document.getElementById("webCanvas");
  const ctx = canvas.getContext("2d");
  const startUrlInput = document.getElementById("startUrl");
  const simModeEl = document.getElementById("simMode");
  const maxNodesEl = document.getElementById("maxNodes");
  const delayMsEl = document.getElementById("delayMs");
  const maxDepthEl = document.getElementById("maxDepth");
  const maxDepthVal = document.getElementById("maxDepthVal");
  const btnStart = document.getElementById("btnStart");
  const btnPause = document.getElementById("btnPause");
  const btnReset = document.getElementById("btnReset");
  const phaseValue = document.getElementById("phaseValue");
  const logEl = document.getElementById("log");
  const statsEl = document.getElementById("stats");

  let rafId = null;
  let crawlTimer = null;
  let paused = false;
  let abort = false;

  /** @type {Map<string, { x: number, y: number, vx: number, vy: number }>} */
  const layout = new Map();

  const spider = { x: 0, y: 0, tx: 0, ty: 0 };

  function resizeCanvas() {
    const wrap = canvas.parentElement;
    const w = Math.min(900, Math.floor(wrap.clientWidth - 8));
    const h = Math.round((w * 560) / 900);
    canvas.width = w;
    canvas.height = h;
  }

  window.addEventListener("resize", () => {
    resizeCanvas();
    renderGraph();
  });

  maxDepthEl.addEventListener("input", () => {
    maxDepthVal.textContent = maxDepthEl.value;
  });

  function logLine(text, cls) {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    logEl.insertBefore(li, logEl.firstChild);
    while (logEl.children.length > 120) logEl.removeChild(logEl.lastChild);
  }

  function setPhase(p) {
    phaseValue.textContent = p;
    phaseValue.style.color =
      p === PHASE.STRIKE ? "var(--strike)" : p === PHASE.PATROL ? "var(--patrol)" : "";
  }

  function normalizeCrawlUrl(href) {
    try {
      const x = new URL(href);
      let h = x.href.split("#")[0];
      if (!h.endsWith("/")) h += "/";
      return h;
    } catch (_) {
      return href;
    }
  }

  function extractLinks(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const base = new URL(baseUrl);
    const out = [];
    doc.querySelectorAll("a[href]").forEach((a) => {
      try {
        const u = new URL(a.getAttribute("href"), base);
        if (u.protocol === "http:" || u.protocol === "https:") {
          out.push(normalizeCrawlUrl(u.href));
        }
      } catch (_) {}
    });
    return [...new Set(out)];
  }

  /**
   * Synthetic site graph: mimics a small multi-section site so the demo runs without CORS.
   */
  function buildSimulationGraph(startHref, graphCap) {
    let root;
    try {
      root = new URL(startHref || "https://web.demo/");
    } catch (_) {
      root = new URL("https://web.demo/");
    }
    const host = root.origin;
    const pages = new Map();

    const sections = ["den", "meadow", "burrow", "trail", "cache"];
    const topics = ["threads", "anchors", "prey", "signals", "paths"];

    let id = 0;
    function addPage(path, depth, outDegreeHint) {
      const u = normalizeCrawlUrl(new URL(path, host).href);
      if (pages.has(u)) return u;
      if (pages.size >= graphCap) return null;
      pages.set(u, { links: [], depth, outDegree: outDegreeHint });
      return u;
    }

    const rootPath = root.pathname && root.pathname !== "" ? root.pathname : "/";
    const rootUrl = addPage(rootPath, 0, 0);
    if (!rootUrl) return { pages, host };

    const queue = [[rootUrl, 0]];
    const seenBfs = new Set([rootUrl]);
    const maxDepthSim = Math.max(4, Number(maxDepthEl.value) + 2);

    while (queue.length && pages.size < graphCap) {
      const [url, depth] = queue.shift();
      const node = pages.get(url);
      if (!node || depth >= maxDepthSim) continue;

      const nChildren = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < nChildren && pages.size < graphCap; i++) {
        id++;
        const sec = sections[id % sections.length];
        const top = topics[(id * 7) % topics.length];
        const basePath = new URL(url).pathname.replace(/\/$/, "") || "";
        const childPath = `${basePath}/${sec}-${top}-${id}/`;
        const childUrl = addPage(childPath, depth + 1, nChildren);
        if (!childUrl) break;

        if (!node.links.includes(childUrl)) node.links.push(childUrl);
        if (!seenBfs.has(childUrl)) {
          seenBfs.add(childUrl);
          queue.push([childUrl, depth + 1]);
        }
      }
    }

    // Cross-weave: random shortcuts (fabrilis sheet-web feel)
    const urls = [...pages.keys()];
    for (let i = 0; i < urls.length && pages.size > 3; i++) {
      const a = urls[Math.floor(Math.random() * urls.length)];
      const b = urls[Math.floor(Math.random() * urls.length)];
      if (a === b) continue;
      const na = pages.get(a);
      if (na.links.length < 8 && !na.links.includes(b)) na.links.push(b);
    }

    pages.forEach((n) => {
      n.outDegree = n.links.length;
    });

    return { pages, host };
  }

  async function fetchPage(url, simGraph) {
    if (simGraph) {
      let node = simGraph.pages.get(url);
      if (!node) {
        const bridge = [...simGraph.pages.keys()].slice(0, 4);
        node = { links: bridge, depth: 0, outDegree: bridge.length };
        simGraph.pages.set(url, node);
      }
      const links = [...node.links];
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 80));
      return { ok: true, html: "", links, simulated: true };
    }
    const res = await fetch(url, {
      credentials: "same-origin",
      redirect: "follow",
      headers: { Accept: "text/html" },
    });
    if (!res.ok) return { ok: false, status: res.status, links: [] };
    const html = await res.text();
    const links = extractLinks(html, url);
    return { ok: true, html, links, simulated: false };
  }

  function sameHost(a, b) {
    try {
      return new URL(a).host === new URL(b).host;
    } catch (_) {
      return false;
    }
  }

  class HuntQueue {
    constructor(originUrl) {
      this.origin = originUrl;
      this.pending = [];
      this.patrolBias = 0;
    }

    push(url, depth, parentUrl, parentOutDegree) {
      if (!url || depth > Number(maxDepthEl.value)) return;
      url = normalizeCrawlUrl(url);
      this.pending.push({
        url,
        depth,
        parentUrl,
        parentOutDegree: parentOutDegree || 0,
        enqueuedAt: performance.now(),
      });
    }

    /**
     * Fabrilis-style scoring: favor same-host (territory), shallow when patrolling,
     * deeper & link-rich parents when striking.
     */
    pickNext(phase) {
      if (!this.pending.length) return null;
      const maxD = Number(maxDepthEl.value);
      this.pending.forEach((p) => {
        let score = 0;
        if (sameHost(p.url, this.origin)) score += 40;
        score += Math.min(20, p.parentOutDegree * 3);
        if (phase === PHASE.PATROL) {
          score += (maxD - p.depth) * 8;
          score += (performance.now() - p.enqueuedAt) * 0.001;
        } else {
          score += p.depth * 6;
          score += p.parentOutDegree * 4;
        }
        p._score = score;
      });
      this.pending.sort((a, b) => b._score - a._score);
      return this.pending.shift();
    }
  }

  function ensureLayoutNode(url, cx, cy) {
    if (layout.has(url)) return;
    const angle = Math.random() * Math.PI * 2;
    const r = 40 + Math.random() * 90;
    layout.set(url, {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: 0,
      vy: 0,
    });
  }

  function tickLayout(nodes, edges, currentUrl) {
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    nodes.forEach((id) => {
      if (!layout.has(id)) ensureLayoutNode(id, cx, cy);
    });

    const kRepel = 420;
    const kSpring = 0.018;
    const len = 95;
    const centerPull = 0.0009;

    const ids = [...nodes];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = layout.get(ids[i]);
        const b = layout.get(ids[j]);
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const f = kRepel / (dist * dist);
        dx /= dist;
        dy /= dist;
        a.vx -= dx * f;
        a.vy -= dy * f;
        b.vx += dx * f;
        b.vy += dy * f;
      }
    }

    edges.forEach(([from, to]) => {
      const a = layout.get(from);
      const b = layout.get(to);
      if (!a || !b) return;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const diff = dist - len;
      const f = kSpring * diff;
      dx /= dist;
      dy /= dist;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    });

    ids.forEach((id) => {
      const p = layout.get(id);
      p.vx += (cx - p.x) * centerPull;
      p.vy += (cy - p.y) * centerPull;
      p.vx *= 0.72;
      p.vy *= 0.72;
      p.x += p.vx;
      p.y += p.vy;
      p.x = Math.max(28, Math.min(w - 28, p.x));
      p.y = Math.max(28, Math.min(h - 28, p.y));
    });

    if (currentUrl && layout.has(currentUrl)) {
      const t = layout.get(currentUrl);
      spider.tx = t.x;
      spider.ty = t.y;
    }
    spider.x += (spider.tx - spider.x) * 0.14;
    spider.y += (spider.ty - spider.y) * 0.14;
  }

  function renderGraph(state) {
    if (!state) return;
    const { visited, edges, currentUrl, failed } = state;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    tickLayout(visited, edges, currentUrl);

    ctx.strokeStyle = "rgba(220, 230, 245, 0.14)";
    ctx.lineWidth = 1;
    edges.forEach(([from, to]) => {
      const a = layout.get(from);
      const b = layout.get(to);
      if (!a || !b) return;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.08;
      const my = (a.y + b.y) / 2 - (b.x - a.x) * 0.08;
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
    });

    visited.forEach((url) => {
      const p = layout.get(url);
      if (!p) return;
      const isCur = url === currentUrl;
      const isFail = failed.has(url);
      ctx.beginPath();
      ctx.arc(p.x, p.y, isCur ? 9 : 6, 0, Math.PI * 2);
      ctx.fillStyle = isFail
        ? "rgba(255,107,107,0.85)"
        : isCur
          ? "rgba(255,159,67,0.95)"
          : "rgba(84,160,255,0.85)";
      ctx.fill();
      if (isCur) {
        ctx.strokeStyle = "rgba(255,200,120,0.5)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    ctx.font = "14px sans-serif";
    ctx.fillText("🕷", spider.x - 10, spider.y + 5);
  }

  function updateStats(v, e, q) {
    statsEl.innerHTML = `nodes: ${v} · strands: ${e} · queued: ${q}`;
  }

  async function runCrawl() {
    abort = false;
    paused = false;
    btnPause.disabled = false;
    btnStart.disabled = true;
    logEl.innerHTML = "";

    const sim = simModeEl.checked;
    const maxNodes = Math.min(500, Math.max(5, Number(maxNodesEl.value) || 48));
    let startHref = startUrlInput.value.trim();
    if (!startHref) startHref = sim ? "https://fabrilis.demo/" : window.location.origin + "/";

    let startUrl;
    try {
      startUrl = normalizeCrawlUrl(new URL(startHref).href);
    } catch (e) {
      logLine("Invalid start URL.", "err");
      setPhase(PHASE.IDLE);
      btnStart.disabled = false;
      btnPause.disabled = true;
      return;
    }

    const simGraph = sim ? buildSimulationGraph(startUrl, Math.min(240, maxNodes * 3)) : null;
    if (sim) {
      logLine("Simulation: synthetic graph (no network HTML).", "ok");
    }

    const visited = new Set();
    const visitedList = [];
    const edges = [];
    const edgeKey = (a, b) => [a, b].sort().join("|");
    const seenEdges = new Set();
    const failed = new Set();

    const hunt = new HuntQueue(startUrl);
    hunt.push(startUrl, 0, null, 12);

    let phase = PHASE.PATROL;
    let steps = 0;
    let currentUrl = null;

    const state = { visited: visitedList, edges, currentUrl: null, failed };

    function loopDraw() {
      state.currentUrl = currentUrl;
      renderGraph(state);
      rafId = requestAnimationFrame(loopDraw);
    }
    cancelAnimationFrame(rafId);
    loopDraw();

    logLine(`Begin at ${startUrl}`, "ok");

    while (!abort && visited.size < maxNodes && hunt.pending.length) {
      while (paused && !abort) await new Promise((r) => setTimeout(r, 120));
      if (abort) break;

      steps++;
      phase = steps % 5 === 0 ? PHASE.STRIKE : PHASE.PATROL;
      setPhase(phase);

      const next = hunt.pickNext(phase);
      if (!next) break;
      currentUrl = next.url;

      if (visited.has(next.url)) {
        if (next.parentUrl) {
          const ek = edgeKey(next.parentUrl, next.url);
          if (!seenEdges.has(ek)) {
            seenEdges.add(ek);
            edges.push([next.parentUrl, next.url]);
          }
        }
        updateStats(visited.size, edges.length, hunt.pending.length);
        continue;
      }

      setPhase(PHASE.WEAVE);
      let result;
      try {
        result = await fetchPage(next.url, simGraph);
      } catch (err) {
        result = { ok: false, links: [] };
        logLine(`retreat ${next.url} — ${err.message || err}`, "err");
      }

      const delay = Number(delayMsEl.value) || 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      visited.add(next.url);
      visitedList.push(next.url);

      if (next.parentUrl) {
        const ek = edgeKey(next.parentUrl, next.url);
        if (!seenEdges.has(ek)) {
          seenEdges.add(ek);
          edges.push([next.parentUrl, next.url]);
        }
      }

      if (!result.ok) {
        failed.add(next.url);
        setPhase(PHASE.RETREAT);
        logLine(`retreat ${next.url} ${result.status ? "(HTTP " + result.status + ")" : ""}`, "err");
        await new Promise((r) => setTimeout(r, Math.min(800, delay + 200)));
        setPhase(phase);
        updateStats(visited.size, edges.length, hunt.pending.length);
        continue;
      }

      logLine(`${result.simulated ? "map" : "weave"} ${next.url}`, "ok");

      const links = result.links || [];
      const outDeg = links.length;
      links.forEach((href) => {
        if (visited.size + hunt.pending.length >= maxNodes * 3) return;
        hunt.push(href, next.depth + 1, next.url, outDeg);
      });

      updateStats(visited.size, edges.length, hunt.pending.length);
    }

    cancelAnimationFrame(rafId);
    rafId = null;
    currentUrl = null;
    state.currentUrl = null;
    renderGraph(state);

    setPhase(PHASE.IDLE);
    logLine(abort ? "Stopped." : "Hunt complete.", "ok");
    btnStart.disabled = false;
    btnPause.disabled = true;
  }

  btnStart.addEventListener("click", () => {
    resizeCanvas();
    runCrawl();
  });

  btnPause.addEventListener("click", () => {
    paused = !paused;
    btnPause.textContent = paused ? "Resume" : "Pause";
  });

  btnReset.addEventListener("click", () => {
    abort = true;
    paused = false;
    btnPause.textContent = "Pause";
    layout.clear();
    cancelAnimationFrame(rafId);
    rafId = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    logEl.innerHTML = "";
    statsEl.textContent = "";
    setPhase(PHASE.IDLE);
    btnStart.disabled = false;
    btnPause.disabled = true;
  });

  startUrlInput.placeholder = window.location.origin + "/";
  resizeCanvas();
  maxDepthVal.textContent = maxDepthEl.value;
  setPhase(PHASE.IDLE);
})();
