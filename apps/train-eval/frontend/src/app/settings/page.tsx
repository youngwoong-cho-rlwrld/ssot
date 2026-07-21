"use client";

import { useEffect } from "react";

/** Settings now live in the gateway, outside this app's basePath. This page
 *  just bounces there; the link is the no-JS / pre-redirect fallback. */
const settingsUrl = process.env.NEXT_PUBLIC_SSOT_SETTINGS_URL ?? "/settings";

export default function SettingsPage() {
  useEffect(() => {
    window.location.replace(settingsUrl);
  }, []);

  return (
    <div className="ssot-page">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Redirecting to{" "}
        <a href={settingsUrl} className="text-[var(--ssot-accent)] hover:underline">
          settings
        </a>
        .
      </p>
    </div>
  );
}
