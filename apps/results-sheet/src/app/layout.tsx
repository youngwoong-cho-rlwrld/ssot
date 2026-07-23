import type { Metadata } from "next";
import Script from "next/script";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/base.css";
import "@ssot/theme/chat.css";
import "@ssot/theme/header.css";
import "@ssot/theme/controls.css";
import "@ssot/theme/model-switcher.css";
import "@ssot/theme/panel-resize.css";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Results Sheet · SSOT",
  description: "Spreadsheet-style eval results table",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-96x96.png", type: "image/png", sizes: "96x96" },
    ],
  },
};

const portalUrl = process.env.NEXT_PUBLIC_SSOT_PORTAL_URL ?? "/";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script src="/portal-assets/theme/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body suppressHydrationWarning>
        <div className="ssot-app">
          <header className="ssot-header">
            <a className="ssot-brand" href={portalUrl}>SSOT</a>
            <span className="ssot-sep">/</span>
            <span className="ssot-app-name">Results Sheet</span>
            <span className="ssot-header-spacer" />
            <ssot-theme-toggle></ssot-theme-toggle>
            <ssot-user></ssot-user>
          </header>
          <Script
            src="/portal-assets/theme/runtime.js"
            type="module"
            strategy="afterInteractive"
          />
          <Providers>{children}</Providers>
        </div>
      </body>
    </html>
  );
}
