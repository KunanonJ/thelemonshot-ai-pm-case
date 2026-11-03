import { useEffect, useState, type ReactNode } from "react";
import { ClerkProvider } from "@clerk/react";
import { App } from "./App";
import { ClerkBridge, DevBridge } from "./lib/auth";

type PublicConfig = { clerkPublishableKey: string | null; devAuthBypass?: boolean };

// The publishable key comes from the Worker, so configuring sign-in is a secret change, not a rebuild
export function Root() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/config")
      .then((res) => {
        if (!res.ok) throw new Error(`/config returned ${res.status}`);
        return res.json() as Promise<PublicConfig>;
      })
      .then(setConfig)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Notice title="Couldn't load the app configuration">{error}</Notice>;
  if (!config) return <Notice title="Loading" />;
  if (config.devAuthBypass) {
    return (
      <DevBridge>
        <App />
      </DevBridge>
    );
  }
  if (!config.clerkPublishableKey) {
    return (
      <Notice title="Sign-in isn't configured yet">
        Add <code>CLERK_PUBLISHABLE_KEY</code> and <code>CLERK_SECRET_KEY</code> as Worker secrets.
      </Notice>
    );
  }
  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <ClerkBridge>
        <App />
      </ClerkBridge>
    </ClerkProvider>
  );
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-24">
      <h1 className="text-lg font-semibold">{title}</h1>
      {children && <p className="mt-2 text-sm text-neutral-600">{children}</p>}
    </div>
  );
}
