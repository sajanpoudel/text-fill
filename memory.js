// ── State ─────────────────────────────────────────────────────────────────────
let allMemories    = [];
let embeddingIndex = {};   // { [id]: number[] } — pre-normalized unit vectors
let activeCategory = "all";
let searchQuery    = "";
let clusterView    = false;

// ── Storage helpers ───────────────────────────────────────────────────────────
const loadMemories = async () => {
  const { memories = [], memoryEmbeddings = {} } =
    await chrome.storage.local.get(["memories", "memoryEmbeddings"]);
  embeddingIndex = memoryEmbeddings;
  return memories;
};

const persistMemories = async (memories) => {
  await chrome.storage.local.set({ memories });
};

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer = null;
const showToast = (msg, isError = false) => {
  const el = document.getElementById("memToast");
  el.textContent = msg;
  el.className = "mem-toast show" + (isError ? " error" : "");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = "mem-toast"; }, 2500);
};

// ── Embedding utils (plain JS, no WASM needed at this scale) ─────────────────
const dotProduct = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
};

const normalizeVector = (v) => {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? v : v.map((x) => x / mag);
};

// K-means clustering on pre-normalized embedding vectors (cosine = dot product).
// Returns an array of clusters, each being an array of memory ids.
const kMeansClustering = (ids, k, maxIter = 20) => {
  const validIds = ids.filter((id) => embeddingIndex[id]);
  if (validIds.length < 2) return [validIds];
  k = Math.min(k, validIds.length);

  const dim = embeddingIndex[validIds[0]].length;
  const shuffled = [...validIds].sort(() => Math.random() - 0.5);
  let centroids = shuffled.slice(0, k).map((id) => [...embeddingIndex[id]]);
  let assignments = new Array(validIds.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < validIds.length; i++) {
      const emb = embeddingIndex[validIds[i]];
      let best = 0, bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = dotProduct(emb, centroids[c]);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed) break;

    centroids = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < validIds.length; i++) {
      const emb = embeddingIndex[validIds[i]];
      const c = assignments[i];
      for (let d = 0; d < dim; d++) centroids[c][d] += emb[d];
      counts[c]++;
    }
    centroids = centroids.map((centroid, c) =>
      counts[c] > 0 ? normalizeVector(centroid) : centroid
    );
  }

  const clusters = Array.from({ length: k }, () => []);
  validIds.forEach((id, i) => clusters[assignments[i]].push(id));
  // Also add ids with no embedding to the largest cluster
  const noEmbedIds = ids.filter((id) => !embeddingIndex[id]);
  if (noEmbedIds.length > 0) {
    const largest = clusters.reduce((a, b) => a.length >= b.length ? a : b);
    noEmbedIds.forEach((id) => largest.push(id));
  }
  return clusters.filter((c) => c.length > 0);
};

// Generate a human-readable cluster label from member memories
const clusterLabel = (memIds) => {
  const mems = memIds.map((id) => allMemories.find((m) => m.id === id)).filter(Boolean);
  const entities = mems.flatMap((m) => m.entities || []);
  const tags = mems.flatMap((m) => m.tags || []);
  const topTerms = [...new Set([...entities, ...tags])].slice(0, 3);
  return topTerms.length > 0 ? topTerms.join(", ") : "General";
};

// ── Filter + sort ─────────────────────────────────────────────────────────────
const filteredMemories = () => {
  let list;
  if (activeCategory === "archived") {
    list = allMemories.filter((m) => m.tier === "archived");
  } else if (activeCategory === "all") {
    list = allMemories.filter((m) => m.tier !== "archived");
  } else {
    list = allMemories.filter((m) => m.category === activeCategory && m.tier !== "archived");
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    list = list.filter(
      (m) =>
        m.content?.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q)) ||
        m.entities?.some((e) => e.toLowerCase().includes(q)) ||
        m.type?.toLowerCase().includes(q)
    );
  }

  return [...list].sort(
    (a, b) =>
      (b.importance || 2) - (a.importance || 2) ||
      (b.updatedAt || 0) - (a.updatedAt || 0)
  );
};

const CAT_LABELS = { work: "Work", social: "Social", personal: "Personal", persona: "Persona" };
const CAT_DOT    = { work: "dot-work", social: "dot-social", personal: "dot-personal", persona: "dot-persona" };
const CAT_CLASS  = { work: "cat-work", social: "cat-social", personal: "cat-personal", persona: "cat-persona" };

const relativeTime = (ts) => {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

// Forget score bar: subtle visual 0–1 strength indicator
const forgetScoreBar = (score) => {
  if (!score || score < 0.1) return null;
  const bar = document.createElement("div");
  bar.className = "forget-bar";
  bar.title = `Forget pressure: ${Math.round(score * 100)}% — ${score > 0.6 ? "archived soon" : "healthy"}`;
  const fill = document.createElement("div");
  fill.className = "forget-bar-fill";
  fill.style.width = `${Math.round(score * 100)}%`;
  fill.style.background = score > 0.6 ? "#f87171" : score > 0.35 ? "#fbbf24" : "#86efac";
  bar.appendChild(fill);
  return bar;
};

const renderStars = (importance, cardId) => {
  const wrap = document.createElement("div");
  wrap.className = "mem-importance";
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("span");
    star.className = "imp-star" + (i <= (importance || 2) ? " on" : "");
    star.textContent = "★";
    star.title = `Importance: ${i}`;
    star.dataset.val = i;
    star.addEventListener("click", async (e) => {
      e.stopPropagation();
      const newVal = Number(star.dataset.val);
      const idx = allMemories.findIndex((m) => m.id === cardId);
      if (idx >= 0) {
        allMemories[idx].importance = newVal;
        allMemories[idx].updatedAt = Date.now();
        await persistMemories(allMemories);
        renderAll();
      }
    });
    wrap.appendChild(star);
  }
  return wrap;
};

const createCard = (memory) => {
  const isArchived = memory.tier === "archived";
  const card = document.createElement("div");
  card.className = "mem-card" +
    (memory.private  ? " mem-card-private"  : "") +
    (isArchived      ? " mem-card-archived" : "");
  card.dataset.id = memory.id;

  // Top row
  const top = document.createElement("div");
  top.className = "mem-card-top";

  const catBadge = document.createElement("span");
  catBadge.className = `mem-card-cat ${CAT_CLASS[memory.category] || "cat-persona"}`;
  catBadge.textContent = CAT_LABELS[memory.category] || memory.category;

  if (isArchived) {
    const archBadge = document.createElement("span");
    archBadge.className = "mem-card-cat cat-archived";
    archBadge.textContent = "Archived";
    top.appendChild(catBadge);
    top.appendChild(archBadge);
  } else {
    top.appendChild(catBadge);
  }

  const contentEl = document.createElement("div");
  contentEl.className = "mem-card-content";
  contentEl.textContent = memory.content;

  const editArea = document.createElement("div");
  editArea.className = "mem-card-edit-area";
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.value = memory.content;
  editArea.appendChild(textarea);

  const contentWrap = document.createElement("div");
  contentWrap.style.flex = "1";
  contentWrap.style.minWidth = "0";
  contentWrap.appendChild(contentEl);
  contentWrap.appendChild(editArea);

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "mem-card-actions";

  // Restore button (only for archived)
  if (isArchived) {
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "mem-icon-btn";
    restoreBtn.title = "Restore to active";
    restoreBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
    </svg>`;
    restoreBtn.addEventListener("click", async () => {
      const idx = allMemories.findIndex((m) => m.id === memory.id);
      if (idx >= 0) {
        allMemories[idx].tier = "active";
        allMemories[idx].forgetScore = 0;
        allMemories[idx].updatedAt = Date.now();
        await persistMemories(allMemories);
        showToast("Memory restored");
        renderAll();
      }
    });
    actions.appendChild(restoreBtn);
  }

  // Private toggle
  const privBtn = document.createElement("button");
  privBtn.className = "mem-icon-btn" + (memory.private ? " active" : "");
  privBtn.title = memory.private ? "Mark public" : "Mark private";
  privBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    ${memory.private
      ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
      : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'}
  </svg>`;
  privBtn.addEventListener("click", async () => {
    const idx = allMemories.findIndex((m) => m.id === memory.id);
    if (idx >= 0) {
      allMemories[idx].private = !allMemories[idx].private;
      allMemories[idx].updatedAt = Date.now();
      await persistMemories(allMemories);
      renderAll();
    }
  });

  // Edit button
  const editBtn = document.createElement("button");
  editBtn.className = "mem-icon-btn";
  editBtn.title = "Edit";
  editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>`;

  // Delete button
  const delBtn = document.createElement("button");
  delBtn.className = "mem-icon-btn del";
  delBtn.title = "Delete";
  delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>`;
  delBtn.addEventListener("click", async () => {
    if (!confirm("Delete this memory?")) return;
    // Use the background handler so the embedding index is also cleaned up
    await chrome.runtime.sendMessage({ type: "deleteMemory", id: memory.id });
    allMemories = allMemories.filter((m) => m.id !== memory.id);
    showToast("Memory deleted");
    renderAll();
  });

  actions.appendChild(privBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  top.appendChild(contentWrap);
  top.appendChild(actions);
  card.appendChild(top);

  // Importance + edit save/cancel
  const midRow = document.createElement("div");
  midRow.style.display = "flex";
  midRow.style.alignItems = "center";
  midRow.style.justifyContent = "space-between";
  midRow.style.gap = "8px";

  midRow.appendChild(renderStars(memory.importance, memory.id));

  const editActions = document.createElement("div");
  editActions.className = "mem-edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.className = "mem-btn-save";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const newContent = textarea.value.trim();
    if (!newContent) return;
    const idx = allMemories.findIndex((m) => m.id === memory.id);
    if (idx >= 0) {
      allMemories[idx].content = newContent;
      allMemories[idx].updatedAt = Date.now();
      await persistMemories(allMemories);
      showToast("Memory updated");
      renderAll();
    }
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mem-btn-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    textarea.value = memory.content;
    contentEl.classList.remove("editing");
    editArea.classList.remove("editing");
    editActions.classList.remove("editing");
    editBtn.classList.remove("active");
  });

  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);
  midRow.appendChild(editActions);
  card.appendChild(midRow);

  // Edit toggle
  editBtn.addEventListener("click", () => {
    const isEditing = editArea.classList.contains("editing");
    if (isEditing) {
      textarea.value = memory.content;
      contentEl.classList.remove("editing");
      editArea.classList.remove("editing");
      editActions.classList.remove("editing");
      editBtn.classList.remove("active");
    } else {
      contentEl.classList.add("editing");
      editArea.classList.add("editing");
      editActions.classList.add("editing");
      editBtn.classList.add("active");
      textarea.focus();
    }
  });

  // Forget score bar
  const scoreBar = forgetScoreBar(memory.forgetScore);
  if (scoreBar) card.appendChild(scoreBar);

  // Tags
  if (memory.tags?.length > 0) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "mem-tags";
    memory.tags.forEach((tag) => {
      const t = document.createElement("span");
      t.className = "mem-tag";
      t.textContent = `#${tag}`;
      tagsRow.appendChild(t);
    });
    card.appendChild(tagsRow);
  }

  // Meta row
  const meta = document.createElement("div");
  meta.className = "mem-meta";

  if (memory.source) {
    const src = document.createElement("span");
    src.className = "mem-meta-source";
    src.textContent = memory.source;
    meta.appendChild(src);
  }
  if ((memory.mentions || 1) > 1) {
    const men = document.createElement("span");
    men.className = "mem-meta-mentions";
    men.textContent = `${memory.mentions} mentions`;
    meta.appendChild(men);
  }
  if ((memory.accessCount || 0) > 0) {
    const acc = document.createElement("span");
    acc.className = "mem-meta-mentions";
    acc.textContent = `used ${memory.accessCount}×`;
    meta.appendChild(acc);
  }
  const time = document.createElement("span");
  time.textContent = relativeTime(memory.updatedAt || memory.createdAt);
  meta.appendChild(time);

  if (memory.private) {
    const priv = document.createElement("span");
    priv.textContent = "🔒 private";
    meta.appendChild(priv);
  }

  card.appendChild(meta);
  return card;
};

// ── Cluster view ──────────────────────────────────────────────────────────────
const renderClusters = (list) => {
  const listEl = document.getElementById("memList");
  listEl.innerHTML = "";

  if (list.length === 0) {
    listEl.innerHTML = `<div class="mem-empty"><p>No active memories to cluster.</p></div>`;
    return;
  }

  // Group by category first, then cluster within each
  const cats = [...new Set(list.map((m) => m.category))];
  cats.forEach((cat) => {
    const catMems = list.filter((m) => m.category === cat);
    const k = Math.min(3, Math.max(1, Math.floor(catMems.length / 3)));
    const clusters = kMeansClustering(catMems.map((m) => m.id), k);

    const catSection = document.createElement("div");
    catSection.className = "cluster-category";

    const catTitle = document.createElement("div");
    catTitle.className = "cluster-cat-title";
    catTitle.textContent = CAT_LABELS[cat] || cat;
    catSection.appendChild(catTitle);

    clusters.forEach((clusterIds, idx) => {
      if (clusterIds.length === 0) return;
      const label = clusterLabel(clusterIds);

      const group = document.createElement("div");
      group.className = "cluster-group";

      const header = document.createElement("div");
      header.className = "cluster-group-header";
      header.innerHTML = `
        <span class="cluster-label">${label}</span>
        <span class="cluster-count">${clusterIds.length} ${clusterIds.length === 1 ? "memory" : "memories"}</span>
        <span class="cluster-toggle">▾</span>
      `;
      group.appendChild(header);

      const body = document.createElement("div");
      body.className = "cluster-group-body";
      clusterIds
        .map((id) => allMemories.find((m) => m.id === id))
        .filter(Boolean)
        .forEach((mem) => body.appendChild(createCard(mem)));
      group.appendChild(body);

      // Collapse/expand toggle
      header.addEventListener("click", () => {
        const isOpen = body.classList.toggle("collapsed");
        header.querySelector(".cluster-toggle").textContent = isOpen ? "▸" : "▾";
      });

      catSection.appendChild(group);
    });

    listEl.appendChild(catSection);
  });
};

// ── Stats bar ─────────────────────────────────────────────────────────────────
const renderStats = () => {
  const statsEl = document.getElementById("memStats");
  statsEl.innerHTML = "";
  const active   = allMemories.filter((m) => m.tier !== "archived");
  const archived = allMemories.filter((m) => m.tier === "archived");
  const cats = ["work", "social", "personal", "persona"];

  cats.forEach((cat) => {
    const count = active.filter((m) => m.category === cat).length;
    if (count === 0) return;
    const stat = document.createElement("div");
    stat.className = "mem-stat";
    const dot = document.createElement("span");
    dot.className = `mem-stat-dot ${CAT_DOT[cat]}`;
    const label = document.createElement("span");
    label.className = "mem-stat-label";
    label.textContent = CAT_LABELS[cat];
    const val = document.createElement("span");
    val.className = "mem-stat-val";
    val.textContent = count;
    stat.appendChild(dot);
    stat.appendChild(label);
    stat.appendChild(val);
    statsEl.appendChild(stat);
  });

  if (archived.length > 0) {
    const stat = document.createElement("div");
    stat.className = "mem-stat";
    const dot = document.createElement("span");
    dot.className = "mem-stat-dot dot-archived";
    const label = document.createElement("span");
    label.className = "mem-stat-label";
    label.textContent = "Archived";
    const val = document.createElement("span");
    val.className = "mem-stat-val";
    val.textContent = archived.length;
    stat.appendChild(dot);
    stat.appendChild(label);
    stat.appendChild(val);
    statsEl.appendChild(stat);
  }
};

// ── Render ────────────────────────────────────────────────────────────────────
const renderAll = () => {
  const list    = filteredMemories();
  const listEl  = document.getElementById("memList");
  const countEl = document.getElementById("memCount");
  const footer  = document.getElementById("memFooter");
  const clusterBtn = document.getElementById("btnClusterView");

  const active   = allMemories.filter((m) => m.tier !== "archived").length;
  const archived = allMemories.filter((m) => m.tier === "archived").length;
  countEl.textContent = `${active} active${archived > 0 ? ` · ${archived} archived` : ""}`;
  footer.style.display = allMemories.length > 0 ? "flex" : "none";

  // Cluster toggle button state
  clusterBtn.classList.toggle("active", clusterView);
  // Cluster view only makes sense for non-archived categories
  const canCluster = activeCategory !== "archived" && list.length >= 3;
  clusterBtn.style.display = canCluster ? "" : "none";

  renderStats();

  if (list.length === 0) {
    listEl.innerHTML = `
      <div class="mem-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 11l3 3L22 4"/>
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
        </svg>
        <p>${searchQuery || activeCategory !== "all" ? "No matches found." : "No memories yet."}</p>
        ${!searchQuery && activeCategory === "all"
          ? "<p>Generate text in the extension to start building memory.</p>"
          : ""}
      </div>`;
    return;
  }

  if (clusterView && canCluster) {
    renderClusters(list);
    return;
  }

  listEl.innerHTML = "";
  list.forEach((mem) => listEl.appendChild(createCard(mem)));
};

// ── Optimize ──────────────────────────────────────────────────────────────────
const optimizeMemories = async () => {
  const btn = document.getElementById("btnOptimize");
  btn.disabled = true;
  btn.textContent = "Optimizing…";

  const active = allMemories.filter((m) => m.tier !== "archived");

  // Use forgetScore if available, otherwise fall back to importance × mentions
  const scored = active.map((m) => ({
    ...m,
    _sortKey: m.forgetScore != null
      ? (1 - m.forgetScore)                                   // lower forgetScore = keep
      : (m.importance || 2) * Math.log(1 + (m.mentions || 1)), // legacy fallback
  }));

  let removed = 0;
  if (scored.length > 20) {
    const sorted = [...scored].sort((a, b) => b._sortKey - a._sortKey);
    const keep = Math.max(20, Math.floor(scored.length * 0.8));
    const kept = sorted.slice(0, keep).map(({ _sortKey, ...m }) => m);
    const evicted = sorted.slice(keep).map(({ _sortKey, ...m }) => m);
    removed = evicted.length;

    // Clean up embedding index for removed memories
    if (embeddingIndex && evicted.length > 0) {
      const { memoryEmbeddings = {} } = await chrome.storage.local.get("memoryEmbeddings");
      evicted.forEach((m) => delete memoryEmbeddings[m.id]);
      await chrome.storage.local.set({ memoryEmbeddings });
      embeddingIndex = memoryEmbeddings;
    }

    // Re-merge with archived memories (keep them untouched)
    const archived = allMemories.filter((m) => m.tier === "archived");
    allMemories = [...kept, ...archived];
    await persistMemories(allMemories);
  }

  btn.disabled = false;
  btn.textContent = "Optimize & Deduplicate";
  showToast(removed > 0 ? `Removed ${removed} low-value memories` : "Already optimized");
  renderAll();
};

// ── Init ──────────────────────────────────────────────────────────────────────
const init = async () => {
  allMemories = await loadMemories();
  renderAll();

  // Search
  document.getElementById("memSearch").addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    renderAll();
  });

  // Category tabs
  document.querySelectorAll(".mem-filter-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".mem-filter-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeCategory = tab.dataset.cat;
      renderAll();
    });
  });

  // Cluster view toggle
  document.getElementById("btnClusterView").addEventListener("click", () => {
    clusterView = !clusterView;
    renderAll();
  });

  // Clear all
  document.getElementById("btnClearAll").addEventListener("click", async () => {
    if (!confirm(`Delete all ${allMemories.length} memories? This cannot be undone.`)) return;
    allMemories = [];
    await persistMemories(allMemories);
    await chrome.storage.local.remove("memoryEmbeddings");
    showToast("All memories cleared");
    renderAll();
  });

  // Optimize
  document.getElementById("btnOptimize").addEventListener("click", optimizeMemories);
};

init();
