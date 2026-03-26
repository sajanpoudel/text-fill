import { useConvexAuth } from "convex/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

// Returns auth state + the user's profile in one hook
export function useCurrentUser() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const profile = useQuery(
    api.users.getProfile,
    isAuthenticated ? {} : "skip"
  );

  return {
    isLoading,
    isAuthenticated,
    profile,
    hasProfile: !!profile,
  };
}
