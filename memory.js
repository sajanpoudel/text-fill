// ── State ─────────────────────────────────────────────────────────────────────
let allMemories = [];
let activeCategory = "all";
let searchQuery = "";

// ── Storage helpers ───────────────────────────────────────────────────────────
const loadMemories = async () => {
  const { memories = [] } = await chrome.storage.local.get("memories");
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

// ── Filter + render ───────────────────────────────────────────────────────────
const filteredMemories = () => {
  let list = allMemories;
  if (activeCategory !== "all") list = list.filter((m) => m.category === activeCategory);
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
  // Sort: importance desc, then most recent
  return [...list].sort(
    (a, b) =>
      (b.importance || 2) - (a.importance || 2) ||
      (b.updatedAt || 0) - (a.updatedAt || 0)
  );
};

const CAT_LABELS = { work: "Work", social: "Social", personal: "Personal", persona: "Persona" };
const CAT_DOT = { work: "dot-work", social: "dot-social", personal: "dot-personal", persona: "dot-persona" };
const CAT_CLASS = { work: "cat-work", social: "cat-social", personal: "cat-personal", persona: "cat-persona" };

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
  const card = document.createElement("div");
  card.className = "mem-card" + (memory.private ? " mem-card-private" : "");
  card.dataset.id = memory.id;

  // Top row
  const top = document.createElement("div");
  top.className = "mem-card-top";

  const catBadge = document.createElement("span");
  catBadge.className = `mem-card-cat ${CAT_CLASS[memory.category] || "cat-persona"}`;
  catBadge.textContent = CAT_LABELS[memory.category] || memory.category;

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
    allMemories = allMemories.filter((m) => m.id !== memory.id);
    await persistMemories(allMemories);
    showToast("Memory deleted");
    renderAll();
  });

  actions.appendChild(privBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  top.appendChild(catBadge);
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

const renderStats = () => {
  const statsEl = document.getElementById("memStats");
  statsEl.innerHTML = "";
  const cats = ["work", "social", "personal", "persona"];
  cats.forEach((cat) => {
    const count = allMemories.filter((m) => m.category === cat).length;
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
};

const renderAll = () => {
  const list = filteredMemories();
  const listEl = document.getElementById("memList");
  const countEl = document.getElementById("memCount");
  const footer = document.getElementById("memFooter");

  countEl.textContent = `${allMemories.length} ${allMemories.length === 1 ? "entry" : "entries"}`;
  footer.style.display = allMemories.length > 0 ? "flex" : "none";

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

  listEl.innerHTML = "";
  list.forEach((mem) => listEl.appendChild(createCard(mem)));
};

// ── Optimize: remove very low-score entries ───────────────────────────────────
const optimizeMemories = async () => {
  const btn = document.getElementById("btnOptimize");
  btn.disabled = true;
  btn.textContent = "Optimizing…";

  // Score each: importance × log(1 + mentions) — drop bottom 20% if > 20 entries
  const scored = allMemories.map((m) => ({
    ...m,
    _score: (m.importance || 2) * Math.log(1 + (m.mentions || 1)),
  }));

  let removed = 0;
  if (scored.length > 20) {
    const sorted = [...scored].sort((a, b) => b._score - a._score);
    const keep = Math.max(20, Math.floor(scored.length * 0.8));
    const kept = sorted.slice(0, keep).map(({ _score, ...m }) => m);
    removed = allMemories.length - kept.length;
    allMemories = kept;
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

  // Clear all
  document.getElementById("btnClearAll").addEventListener("click", async () => {
    if (!confirm(`Delete all ${allMemories.length} memories? This cannot be undone.`)) return;
    allMemories = [];
    await persistMemories(allMemories);
    showToast("All memories cleared");
    renderAll();
  });

  // Optimize
  document.getElementById("btnOptimize").addEventListener("click", optimizeMemories);
};

init();
