import type { Metadata } from "next";
import Script from "next/script";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/base.css";
import "@ssot/theme/header.css";
import "@ssot/theme/controls.css";
import "@ssot/theme/modal.css";
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
        <Script src="/portal-assets/theme/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body className="h-full overflow-hidden">
        <Providers>
          <div className="ssot-app">
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
              src="/portal-assets/theme/runtime.js"
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
