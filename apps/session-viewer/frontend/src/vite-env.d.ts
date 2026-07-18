/// <reference types="vite/client" />

// Shared SSOT user chip (defined by /portal-assets/theme/ssot-user.js, served
// by the gateway; renders nothing when the app runs standalone).
declare namespace JSX {
  interface IntrinsicElements {
    "ssot-user": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement>,
      HTMLElement
    > & {
      "settings-url"?: string;
      "login-url"?: string;
    };
    // Shared SSOT icon-only light/dark toggle (defined by
    // /portal-assets/theme/ssot-theme-toggle.js; renders nothing standalone).
    "ssot-theme-toggle": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement>,
      HTMLElement
    >;
  }
}
