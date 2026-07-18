import type { DetailedHTMLProps, HTMLAttributes } from "react";

/** Shared <ssot-user> custom element served by the gateway at
 *  /portal-assets/theme/ssot-user.js. Absent when running standalone. */
type SsotUserProps = DetailedHTMLProps<
  HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  "settings-url"?: string;
  "login-url"?: string;
};

/** Shared icon-only light/dark toggle served by the gateway at
 *  /portal-assets/theme/ssot-theme-toggle.js. Absent when running standalone. */
type SsotThemeToggleProps = DetailedHTMLProps<
  HTMLAttributes<HTMLElement>,
  HTMLElement
>;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ssot-user": SsotUserProps;
      "ssot-theme-toggle": SsotThemeToggleProps;
    }
  }
}
