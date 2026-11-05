import { createContext, useContext } from "react";
import type { Features, User } from "./types";

export interface AuthState {
  user: User;
  features: Features;
  refreshUser: () => Promise<void>;
  pendingCount: number;
  reviewCount: number;
  refreshPending: () => void;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthContext がありません");
  return ctx;
}
