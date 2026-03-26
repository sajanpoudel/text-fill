import { useQuery, useMutation, useAction } from "convex/react";
import { useConvexAuth } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

export function useMemories(limit = 50) {
  const { isAuthenticated } = useConvexAuth();
  const memories = useQuery(
    api.memories.listActive,
    isAuthenticated ? { limit } : "skip"
  );
  const stats = useQuery(api.memories.getStats, isAuthenticated ? {} : "skip");
  const save = useMutation(api.memories.save);
  const updateStatus = useMutation(api.memories.updateStatus);
  const updateText = useMutation(api.memories.updateText);
  const remove = useMutation(api.memories.remove);

  return {
    memories: memories ?? [],
    stats: stats ?? { active: 0, archived: 0 },
    isLoading: memories === undefined,
    save,
    archive: (id: Id<"memories">) => updateStatus({ memoryId: id, status: "archived" }),
    restore: (id: Id<"memories">) => updateStatus({ memoryId: id, status: "active" }),
    remove,
    updateText,
  };
}

export function useMemorySearch() {
  const search = useAction(api.memories.searchMemories);
  return search;
}
