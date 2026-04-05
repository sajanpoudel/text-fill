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
  Database,
  User,
  Check,
  ChevronDown,
  Edit2,
  Link as LinkIcon,
  RotateCcw,
  Search,
  Shield,
  SlidersHorizontal,
  Trash2,
  X,
  ArrowLeft,
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

  const activeCount = useMemo(() => library.filter((m) => m.status === "active").length, [library]);
  const archivedCount = useMemo(() => library.filter((m) => m.status === "archived").length, [library]);

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
    <div className="min-h-screen bg-bg font-sans text-text">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="flex items-center gap-3 text-3xl font-extrabold tracking-tighter text-text">
              <button
                onClick={() => window.location.href = chrome.runtime.getURL("options.html")}
                className="p-1 hover:bg-neutral-200 rounded-full transition-colors"
                title="Back to Settings"
              >
                <ArrowLeft className="h-6 w-6 text-text" />
              </button>
              <Database className="h-7 w-7 text-primary" />
              Memory Bank
            </h1>
            <p className="mt-2 text-sm font-medium text-text-muted max-w-2xl pl-[44px]">
              Review saved contexts, surface high-value persona details,
              and curate information for precision retrieval.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-4 py-2.5 text-xs font-semibold text-text-muted shadow-sm">
            <SlidersHorizontal className="h-4 w-4 text-text-muted" />
            {searchResults
              ? `${filteredMemories.length} semantic results`
              : `${filteredMemories.length} memories in view`}
          </div>
        </div>

        <div className="mb-6 rounded-md border border-border bg-surface p-5 shadow-sm">
          <form onSubmit={handleSearch} className="mb-5 flex flex-col gap-3 md:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!e.target.value) setSearchResults(null);
                }}
                placeholder="Semantic search across memories, experiences, and persona..."
                className="input w-full pl-10 h-11"
              />
            </div>
            <button
              type="submit"
              disabled={searching}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 h-11 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50 transition-colors shadow-sm"
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
                className="rounded-md border border-border px-5 h-11 text-sm font-semibold text-text hover:bg-bg transition-colors shadow-sm"
              >
                Clear
              </button>
            )}
          </form>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex gap-1 rounded-md border border-border bg-bg p-1 shadow-inner">
                {(["active", "archived"] as const).map((status) => (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    className={cn(
                      "rounded px-4 py-1.5 text-xs font-bold uppercase tracking-wider transition-all",
                      statusFilter === status
                        ? "bg-surface text-text shadow-sm"
                        : "text-text-muted hover:text-text"
                    )}
                  >
                    {status}{" "}
                    <span className="opacity-60 ml-1">
                      ({status === "active" ? activeCount : archivedCount})
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
                      "rounded-md border px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-colors",
                      categoryFilter === category
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-surface text-text-muted hover:border-primary hover:text-text"
                    )}
                  >
                    {CATEGORY_LABELS[category]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 self-start lg:self-auto">
              <BarChart3 className="h-4 w-4 text-text-muted" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-xs font-semibold text-text shadow-sm outline-none focus:ring-1 focus:ring-primary"
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
            <div className="mt-5 rounded-md border border-primary bg-primary px-4 py-3 text-sm font-medium text-white shadow-sm">
              {searchResults.length} semantic matches for "{searchQuery}". Filters and sort apply.
            </div>
          )}
        </div>

        <div className="space-y-4">
          {loading ? (
            <div className="rounded-md border border-border bg-surface p-10 text-center font-semibold text-text-muted uppercase tracking-widest text-xs">
              Loading memories…
            </div>
          ) : filteredMemories.length === 0 ? (
            <div className="rounded-md border border-dashed border-border bg-transparent py-24 text-center text-text-muted">
              <Database className="mx-auto mb-4 h-8 w-8 text-neutral-300" />
              <p className="text-xs font-bold uppercase tracking-widest">No memories match this view</p>
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
                    "rounded-md border bg-surface p-6 shadow-sm transition-all duration-200",
                    isPersona
                      ? "border-primary"
                      : "border-border hover:border-primary hover:shadow-md"
                  )}
                >
                  {isEditing ? (
                    <div className="flex flex-col gap-4">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        rows={4}
                        className="input resize-none text-sm font-medium leading-relaxed"
                        autoFocus
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => saveEdit(memory._id as Id<"memories">)}
                          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wide text-white transition-colors hover:bg-primary-hover"
                        >
                          <Check className="h-3.5 w-3.5" /> Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-xs font-bold uppercase tracking-wide text-text transition-colors hover:bg-bg"
                        >
                          <X className="h-3.5 w-3.5" /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="mb-4 flex flex-wrap items-center gap-2">
                            <span
                              className={cn(
                                "rounded px-2 py-1 text-[10px] font-extrabold uppercase tracking-widest",
                                isPersona
                                  ? "bg-primary text-white"
                                  : "bg-neutral-100 text-neutral-600"
                              )}
                            >
                              {category ?? (memory.platform || "uncategorized")}
                            </span>
                            <span className="rounded border border-border bg-surface px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted">
                              {memory.status}
                            </span>
                            {typeof memory.score === "number" && (
                              <span className="rounded bg-bg px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-text">
                                {Math.round(memory.score * 100)}% match
                              </span>
                            )}
                          </div>

                          <p className="text-[15px] font-medium leading-relaxed text-text">{memory.text}</p>

                          <div className="mt-5 flex flex-wrap items-center gap-2">
                            {typeof memory.importance === "number" && (
                              <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mr-2">
                                IMP {formatPercent(memory.importance)}
                              </span>
                            )}
                            {typeof memory.confidence === "number" && (
                              <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mr-2">
                                CONF {formatPercent(memory.confidence)}
                              </span>
                            )}
                            {typeof memory.mentions === "number" && (
                              <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mr-2">
                                REINF {memory.mentions}x
                              </span>
                            )}
                            {typeof memory.forgetScore === "number" && (
                              <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mr-2">
                                RISK {formatPercent(memory.forgetScore)}
                              </span>
                            )}
                            <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mr-2">
                              {formatRelativeTime(memory.createdAt)}
                            </span>
                          </div>

                          {memory.tags && memory.tags.length > 0 && (
                            <div className="mt-4 flex flex-wrap gap-2">
                              {memory.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="rounded border border-border bg-bg px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted"
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
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-text transition-colors hover:bg-bg shadow-sm"
                          >
                            Details
                            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-180")} />
                          </button>
                          <button
                            onClick={() => {
                              setEditingId(memoryId);
                              setEditText(memory.text);
                            }}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-text transition-colors hover:bg-bg shadow-sm"
                          >
                            <Edit2 className="h-3 w-3" />
                            Edit
                          </button>
                          {memory.status === "active" ? (
                            <button
                              onClick={() => archive(memory._id as Id<"memories">)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-text transition-colors hover:bg-bg shadow-sm"
                            >
                              <Archive className="h-3 w-3" />
                              Archive
                            </button>
                          ) : (
                            <button
                              onClick={() => restore(memory._id as Id<"memories">)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-text transition-colors hover:bg-bg shadow-sm"
                            >
                              <RotateCcw className="h-3 w-3" />
                              Restore
                            </button>
                          )}
                          <button
                            onClick={() => remove({ memoryId: memory._id as Id<"memories"> })}
                            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-text-muted transition-colors hover:border-primary hover:text-primary shadow-sm"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-5 grid gap-4 border-t border-border pt-5 text-sm text-text md:grid-cols-2 xl:grid-cols-4">
                          <div>
                            <div className="text-[10px] font-extrabold uppercase tracking-widest text-text-muted">
                              Access
                            </div>
                            <div className="mt-1 font-semibold">
                              {memory.accessCount ?? 0} uses
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-extrabold uppercase tracking-widest text-text-muted">
                              Updated
                            </div>
                            <div className="mt-1 font-semibold">
                              {formatRelativeTime(memory.updatedAt ?? memory.createdAt)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-extrabold uppercase tracking-widest text-text-muted">
                              Retrieval class
                            </div>
                            <div className="mt-1 font-semibold">
                              {isPersona ? "Always-on persona" : category ? `${category} memory` : "Unclassified"}
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-extrabold uppercase tracking-widest text-text-muted">
                              Source
                            </div>
                            <div className="mt-1 font-semibold">
                              {memory.sourceUrl ? (
                                <a
                                  href={memory.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 hover:underline"
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
        <div className="flex min-h-screen items-center justify-center text-text font-semibold text-sm uppercase tracking-widest">Loading…</div>
      </AuthLoading>
      <Unauthenticated>
        <div className="flex min-h-screen items-center justify-center bg-bg">
          <div className="w-full max-w-md">
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
