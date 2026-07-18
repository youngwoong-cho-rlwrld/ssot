/// <reference types="vite/client" />

declare module "@fontsource-variable/inter";

// Shared SSOT chrome (defined by /portal-assets/theme/*.js, served by the
// gateway; renders nothing when the app runs standalone).
declare namespace JSX {
  interface IntrinsicElements {
    "ssot-theme-toggle": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    "ssot-user": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      "settings-url"?: string;
      "login-url"?: string;
    };
  }
}
