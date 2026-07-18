import type { Metadata } from "next";
import Script from "next/script";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/header.css";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Nav } from "@/components/nav";

const portalUrl = process.env.NEXT_PUBLIC_SSOT_PORTAL_URL ?? "/";

export const metadata: Metadata = {
  title: {
    default: "Train / Eval · SSOT",
    template: "%s · Train / Eval · SSOT",
  },
  description: "GR00T train/eval orchestrator",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Apply the persisted theme before first paint to avoid a flash of
            the wrong theme. Mirrors libs/theme/README.md; the shared
            <ssot-theme-toggle> re-applies on load and across tabs. */}
        <Script id="ssot-theme-init" strategy="beforeInteractive">
          {`(function(){try{var t=localStorage.getItem('ssot-theme')==='dark'?'dark':'light';var r=document.documentElement;r.dataset.ssotTheme=t;r.classList.toggle('dark',t==='dark');r.setAttribute('data-mantine-color-scheme',t);}catch(e){}})();`}
        </Script>
      </head>
      <body className="h-full overflow-hidden">
        <Providers>
          <div className="flex h-screen flex-col overflow-hidden">
            <header className="ssot-header">
              <a className="ssot-brand" href={portalUrl}>
                SSOT
              </a>
              <span className="ssot-sep">/</span>
              <span className="ssot-app-name">Train / Eval</span>
              <span className="ssot-header-spacer" />
              <ssot-theme-toggle></ssot-theme-toggle>
              <ssot-user></ssot-user>
            </header>
            <Script
              src="/portal-assets/theme/ssot-theme-toggle.js"
              type="module"
              strategy="afterInteractive"
            />
            <Script
              src="/portal-assets/theme/ssot-user.js"
              type="module"
              strategy="afterInteractive"
            />
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <Nav />
              <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
