import type { DetailedHTMLProps, HTMLAttributes } from "react";

// Shared SSOT user chip, defined by /portal-assets/theme/ssot-user.js (served
// by the gateway; the custom element renders nothing when the app is reached
// standalone and the script 404s). React 19 keeps IntrinsicElements under
// React.JSX, so the element is registered by augmenting the "react" module.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ssot-user": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        "settings-url"?: string;
        "login-url"?: string;
      };
      // Shared icon-only light/dark toggle, defined by
      // /portal-assets/theme/ssot-theme-toggle.js (served by the gateway).
      "ssot-theme-toggle": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
