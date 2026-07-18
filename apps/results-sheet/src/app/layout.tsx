import type { Metadata } from "next";
import Script from "next/script";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/header.css";
import "@ssot/theme/controls.css";
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

// Set the persisted theme on <html> before the first paint so the app never
// flashes the wrong color scheme. Mirrors the snippet in libs/theme/README.md
// and the attributes <ssot-theme-toggle> maintains at runtime.
const themeInitScript =
  "(function(){try{var t=localStorage.getItem('ssot-theme')==='dark'?'dark':'light';var r=document.documentElement;r.dataset.ssotTheme=t;r.classList.toggle('dark',t==='dark');r.setAttribute('data-mantine-color-scheme',t);}catch(e){}})();";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body suppressHydrationWarning>
        <header className="ssot-header">
          <a className="ssot-brand" href={portalUrl}>SSOT</a>
          <span className="ssot-sep">/</span>
          <span className="ssot-app-name">Results Sheet</span>
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
