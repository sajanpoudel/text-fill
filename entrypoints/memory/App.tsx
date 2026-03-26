import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Authenticated,
  Unauthenticated,
  AuthLoading,
  useQuery,
  useMutation,
  useAction,
} from "convex/react";
import { AppProviders } from "../../src/components/AppProviders";
import { AuthScreen } from "../../src/components/AuthScreen";
import { cn, formatRelativeTime } from "../../src/lib/utils";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  Archive,
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  Clock3,
  Edit2,
  Link as LinkIcon,
  RotateCcw,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

type StatusFilter = "active" | "archived";
type CategoryFilter = "all" | "work" | "social" | "personal" | "persona";
type SortOption =
  | "recent"
  | "updated"
  | "importance"
  | "confidence"
  | "mentions"
  | "lastUsed"
  | "forgetRisk"
  | "match";

type MemoryItem = {
  _id: Id<"memories"> | string;
  text: string;
  tags?: string[];
  platform?: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  importance?: number;
  confidence?: number;
  mentions?: number;
  accessCount?: number;
  lastAccessedAt?: number;
  forgetScore?: number;
  sourceUrl?: string;
  score?: number;
};

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: "All",
  work: "Work",
  social: "Social",
  personal: "Personal",
  persona: "Persona",
};

const SORT_LABELS: Record<SortOption, string> = {
  recent: "Newest",
  updated: "Recently updated",
  importance: "Highest importance",
  confidence: "Highest confidence",
  mentions: "Most reinforced",
  lastUsed: "Recently used",
  forgetRisk: "Most at risk",
  match: "Best semantic match",
};

function normalizeMetric(value?: number) {
  return typeof value === "number" ? value : 0;
}

function formatPercent(value?: number) {
  if (typeof value !== "number") return null;
  return `${Math.round(value * 100)}%`;
}

function getMemoryCategory(memory: Pick<MemoryItem, "platform">): CategoryFilter | null {
  const raw = memory.platform?.toLowerCase();
  if (!raw) return null;
  if (raw === "work" || raw === "social" || raw === "personal" || raw === "persona") {
    return raw;
  }
  if (["linkedin", "gmail", "slack", "canvas"].includes(raw)) return "work";
  if (["twitter", "x", "facebook", "threads", "reddit", "youtube", "instagram", "discord"].includes(raw)) {
    return "social";
  }
  if (raw === "general") return "personal";
  return null;
}

function sortMemories(memories: MemoryItem[], sortBy: SortOption) {
  const sorted = [...memories];
  sorted.sort((a, b) => {
    switch (sortBy) {
      case "match":
        return normalizeMetric(b.score) - normalizeMetric(a.score);
      case "importance":
        return normalizeMetric(b.importance) - normalizeMetric(a.importance);
      case "confidence":
        return normalizeMetric(b.confidence) - normalizeMetric(a.confidence);
      case "mentions":
        return normalizeMetric(b.mentions) - normalizeMetric(a.mentions);
      case "lastUsed":
        return normalizeMetric(b.lastAccessedAt) - normalizeMetric(a.lastAccessedAt);
      case "forgetRisk":
        return normalizeMetric(b.forgetScore) - normalizeMetric(a.forgetScore);
      case "updated":
        return normalizeMetric(b.updatedAt ?? b.createdAt) - normalizeMetric(a.updatedAt ?? a.createdAt);
      case "recent":
      default:
        return normalizeMetric(b.createdAt) - normalizeMetric(a.createdAt);
    }
  });
  return sorted;
}

function SummaryCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: number;
  hint: string;
  icon: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">{label}</div>
          <div className="mt-2 text-2xl font-semibold text-gray-950">{value}</div>
          <div className="mt-1 text-xs text-gray-500">{hint}</div>
        </div>
        <div className="rounded-xl bg-gray-100 p-2 text-gray-600">{icon}</div>
      </div>
    </div>
  );
}

function MemoryList() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const allMemories = useQuery(api.memories.listAll, { limit: 800 });
  const searchFn = useAction(api.memories.searchMemories);
  const updateStatus = useMutation(api.memories.updateStatus);
  const updateText = useMutation(api.memories.updateText);
  const remove = useMutation(api.memories.remove);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const results = await searchFn({ queryText: searchQuery, limit: 20 });
      setSearchResults(results as MemoryItem[]);
      setSortBy("match");
    } finally {
      setSearching(false);
    }
  }

  async function saveEdit(id: Id<"memories">) {
    await updateText({ memoryId: id, text: editText });
    setEditingId(null);
  }

  async function archive(id: Id<"memories">) {
    await updateStatus({ memoryId: id, status: "archived" });
  }

  async function restore(id: Id<"memories">) {
    await updateStatus({ memoryId: id, status: "active" });
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  const library = (allMemories ?? []) as MemoryItem[];

  const metrics = useMemo(() => {
    const active = library.filter((m) => m.status === "active");
    const archived = library.filter((m) => m.status === "archived");
    const persona = library.filter((m) => getMemoryCategory(m) === "persona");
    const highPriority = library.filter((m) => normalizeMetric(m.importance) >= 0.8);
    const atRisk = library.filter((m) => normalizeMetric(m.forgetScore) >= 0.6);

    return {
      active: active.length,
      archived: archived.length,
      persona: persona.length,
      highPriority: highPriority.length,
      atRisk: atRisk.length,
    };
  }, [library]);

  const sourceMemories = searchResults ?? library;
  const filteredMemories = useMemo(() => {
    const byStatus = sourceMemories.filter((memory) => memory.status === statusFilter);
    const byCategory =
      categoryFilter === "all"
        ? byStatus
        : byStatus.filter((memory) => getMemoryCategory(memory) === categoryFilter);
    return sortMemories(byCategory, sortBy);
  }, [sourceMemories, statusFilter, categoryFilter, sortBy]);

  const loading = allMemories === undefined && !searchResults;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#eef2ff,_#f8fafc_45%,_#f8fafc)]">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white/80 px-3 py-1 text-xs font-medium text-indigo-700 backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" />
              Long-term memory control
            </div>
            <h1 className="flex items-center gap-2 text-3xl font-bold text-gray-950">
              <Brain className="h-7 w-7 text-indigo-600" />
              Memory Bank
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-gray-600">
              Review what the extension has learned, surface high-value persona memories,
              and keep low-signal memories from cluttering retrieval.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 shadow-sm">
            <SlidersHorizontal className="h-4 w-4 text-gray-400" />
            {searchResults
              ? `${filteredMemories.length} filtered semantic results`
              : `${filteredMemories.length} memories in this view`}
          </div>
        </div>

        <div className="mb-6 grid gap-3 md:grid-cols-5">
          <SummaryCard label="Active" value={metrics.active} hint="Currently retrievable" icon={<Brain className="h-4 w-4" />} />
          <SummaryCard label="Archived" value={metrics.archived} hint="Kept, but out of prompt" icon={<Archive className="h-4 w-4" />} />
          <SummaryCard label="Persona" value={metrics.persona} hint="Always-on identity/style" icon={<Sparkles className="h-4 w-4" />} />
          <SummaryCard label="High Priority" value={metrics.highPriority} hint="Importance 80%+" icon={<Shield className="h-4 w-4" />} />
          <SummaryCard label="At Risk" value={metrics.atRisk} hint="Forget score 60%+" icon={<Clock3 className="h-4 w-4" />} />
        </div>

        <div className="mb-6 rounded-3xl border border-gray-200 bg-white p-4 shadow-sm">
          <form onSubmit={handleSearch} className="mb-4 flex flex-col gap-3 md:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!e.target.value) setSearchResults(null);
                }}
                placeholder="Semantic search across memories, experiences, preferences, and persona..."
                className="input w-full pl-10"
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              {searching ? "Searching…" : "Search"}
            </button>
            {searchResults && (
              <button
                type="button"
                onClick={() => {
                  setSearchResults(null);
                  setSearchQuery("");
                  setSortBy("recent");
                }}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                Clear
              </button>
            )}
          </form>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1">
                {(["active", "archived"] as const).map((status) => (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    className={cn(
                      "rounded-lg px-4 py-2 text-sm font-medium capitalize transition-colors",
                      statusFilter === status
                        ? "bg-gray-900 text-white"
                        : "text-gray-600 hover:bg-white"
                    )}
                  >
                    {status}{" "}
                    <span className="text-xs opacity-75">
                      ({status === "active" ? metrics.active : metrics.archived})
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                {(Object.keys(CATEGORY_LABELS) as CategoryFilter[]).map((category) => (
                  <button
                    key={category}
                    onClick={() => setCategoryFilter(category)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      categoryFilter === category
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                    )}
                  >
                    {CATEGORY_LABELS[category]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 self-start lg:self-auto">
              <BarChart3 className="h-4 w-4 text-gray-400" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700"
              >
                {(
                  searchResults
                    ? (["match", "recent", "updated", "importance", "confidence", "mentions", "lastUsed", "forgetRisk"] as SortOption[])
                    : (["recent", "updated", "importance", "confidence", "mentions", "lastUsed", "forgetRisk"] as SortOption[])
                ).map((option) => (
                  <option key={option} value={option}>
                    {SORT_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {searchResults && (
            <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-indigo-900">
              {searchResults.length} semantic matches for{" "}
              <span className="font-semibold">“{searchQuery}”</span>. Filters and sort still apply.
            </div>
          )}
        </div>

        <div className="space-y-3">
          {loading ? (
            <div className="rounded-3xl border border-gray-200 bg-white p-8 text-center text-gray-400 shadow-sm">
              Loading memories…
            </div>
          ) : filteredMemories.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-gray-300 bg-white/70 py-20 text-center text-gray-400">
              <Brain className="mx-auto mb-3 h-12 w-12 text-gray-200" />
              <p className="text-sm">No memories match this view</p>
            </div>
          ) : (
            filteredMemories.map((memory) => {
              const memoryId = String(memory._id);
              const category = getMemoryCategory(memory);
              const isExpanded = expandedIds.includes(memoryId);
              const isEditing = editingId === memoryId;
              const isPersona = category === "persona";

              return (
                <div
                  key={memoryId}
                  className={cn(
                    "rounded-3xl border bg-white p-5 shadow-sm transition-colors",
                    isPersona
                      ? "border-amber-200 bg-[linear-gradient(180deg,#fffaf0_0%,#ffffff_55%)]"
                      : "border-gray-200 hover:border-gray-300"
                  )}
                >
                  {isEditing ? (
                    <div className="flex flex-col gap-3">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={4}
                        className="input resize-none text-sm"
                        autoFocus
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => saveEdit(memory._id as Id<"memories">)}
                          className="inline-flex items-center gap-1 rounded-xl bg-indigo-600 px-3 py-2 text-xs font-medium text-white"
                        >
                          <Check className="h-3.5 w-3.5" /> Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600"
                        >
                          <X className="h-3.5 w-3.5" /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="mb-3 flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                "rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]",
                                isPersona
                                  ? "bg-amber-100 text-amber-800"
                                  : category === "work"
                                    ? "bg-blue-50 text-blue-700"
                                    : category === "social"
                                      ? "bg-pink-50 text-pink-700"
                                      : category === "personal"
                                        ? "bg-emerald-50 text-emerald-700"
                                        : "bg-gray-100 text-gray-600"
                              )}
                            >
                              {category ?? (memory.platform || "uncategorized")}
                            </span>
                            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-600">
                              {memory.status}
                            </span>
                            {typeof memory.score === "number" && (
                              <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700">
                                {Math.round(memory.score * 100)}% match
                              </span>
                            )}
                          </div>

                          <p className="text-[15px] leading-7 text-gray-900">{memory.text}</p>

                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            {typeof memory.importance === "number" && (
                              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                                importance {formatPercent(memory.importance)}
                              </span>
                            )}
                            {typeof memory.confidence === "number" && (
                              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                                confidence {formatPercent(memory.confidence)}
                              </span>
                            )}
                            {typeof memory.mentions === "number" && (
                              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                                reinforced {memory.mentions}x
                              </span>
                            )}
                            {typeof memory.forgetScore === "number" && (
                              <span
                                className={cn(
                                  "rounded-full px-2.5 py-1 text-xs",
                                  memory.forgetScore >= 0.6
                                    ? "bg-red-50 text-red-700"
                                    : "bg-gray-100 text-gray-700"
                                )}
                              >
                                forget risk {formatPercent(memory.forgetScore)}
                              </span>
                            )}
                            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                              created {formatRelativeTime(memory.createdAt)}
                            </span>
                            {memory.lastAccessedAt && (
                              <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">
                                used {formatRelativeTime(memory.lastAccessedAt)}
                              </span>
                            )}
                          </div>

                          {memory.tags && memory.tags.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {memory.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-500"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                          <button
                            onClick={() => toggleExpanded(memoryId)}
                            className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                          >
                            Details
                            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-180")} />
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(memoryId);
                              setEditText(memory.text);
                            }}
                            className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                            Edit
                          </button>
                          {memory.status === "active" ? (
                            <button
                              onClick={() => archive(memory._id as Id<"memories">)}
                              className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                            >
                              <Archive className="h-3.5 w-3.5" />
                              Archive
                            </button>
                          ) : (
                            <button
                              onClick={() => restore(memory._id as Id<"memories">)}
                              className="inline-flex items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Restore
                            </button>
                          )}
                          <button
                            onClick={() => remove({ memoryId: memory._id as Id<"memories"> })}
                            className="inline-flex items-center gap-1 rounded-xl border border-red-200 px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-4 grid gap-3 rounded-2xl border border-gray-200 bg-gray-50/70 p-4 text-sm text-gray-700 md:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                              Access
                            </div>
                            <div className="mt-1 text-sm text-gray-900">
                              {memory.accessCount ?? 0} uses
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                              Updated
                            </div>
                            <div className="mt-1 text-sm text-gray-900">
                              {formatRelativeTime(memory.updatedAt ?? memory.createdAt)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                              Retrieval class
                            </div>
                            <div className="mt-1 text-sm text-gray-900">
                              {isPersona ? "Always-on persona" : category ? `${category} memory` : "Unclassified"}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500">
                              Source
                            </div>
                            <div className="mt-1 text-sm text-gray-900">
                              {memory.sourceUrl ? (
                                <a
                                  href={memory.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
                                >
                                  <LinkIcon className="h-3.5 w-3.5" />
                                  Open source
                                </a>
                              ) : (
                                "No source URL"
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export function App() {
  return (
    <AppProviders>
      <AuthLoading>
        <div className="flex min-h-screen items-center justify-center text-gray-400">Loading…</div>
      </AuthLoading>
      <Unauthenticated>
        <div className="flex min-h-screen items-center justify-center">
          <div className="w-full max-w-sm">
            <AuthScreen />
          </div>
        </div>
      </Unauthenticated>
      <Authenticated>
        <MemoryList />
      </Authenticated>
    </AppProviders>
  );
}
