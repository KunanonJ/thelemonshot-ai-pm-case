import { Show, useAuth, UserButton } from "@clerk/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";

// The one place the app touches Clerk. Local end-to-end checks run without it: the Worker only reports
// devAuthBypass for localhost requests with DEV_AUTH_BYPASS=1 (the same rule requireAuth applies), so
// production always goes through Clerk.
type AuthBridge = { getToken: () => Promise<string | null>; dev: boolean };
const AuthContext = createContext<AuthBridge | null>(null);

export function ClerkBridge({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const value = useMemo(() => ({ getToken: () => getToken(), dev: false }), [getToken]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function DevBridge({ children }: { children: ReactNode }) {
  const value = useMemo(() => ({ getToken: async () => null, dev: true }), []);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthBridge(): AuthBridge {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuthBridge outside an auth bridge");
  return value;
}

export function SignedInGate({ signedIn, signedOut }: { signedIn: ReactNode; signedOut: ReactNode }) {
  const { dev } = useAuthBridge();
  if (dev) return <>{signedIn}</>;
  return (
    <>
      <Show when="signed-out">{signedOut}</Show>
      <Show when="signed-in">{signedIn}</Show>
    </>
  );
}

export function UserMenu() {
  const { dev } = useAuthBridge();
  return dev ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Local test</span> : <UserButton />;
}
