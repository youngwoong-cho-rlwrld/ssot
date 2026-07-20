/// <reference types="vite/client" />

// Shared SSOT web components (defined by /portal-assets/theme/*.js, served by the
// gateway; render nothing when the app runs standalone).
declare namespace JSX {
  interface IntrinsicElements {
    "ssot-user": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement>,
      HTMLElement
    > & {
      "settings-url"?: string;
      "login-url"?: string;
    };
    "ssot-theme-toggle": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement>,
      HTMLElement
    >;
  }
}
