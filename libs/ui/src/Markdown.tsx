"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Canonical SSOT markdown renderer for chat + transcript message bodies, shared
// via @ssot/ui. react-markdown does not render raw HTML by default, so this is
// XSS-safe without extra config. Links open in a new tab with a safe rel;
// everything else is styled via the `.md` scope in @ssot/theme (chat.css) using
// the shared --ssot-* tokens. The "use client" directive is harmless under Vite
// and required for Next.js server components.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // `props` is typed loosely so this compiles under both the React 18 and
          // React 19 type environments the shared lib is built in (react-markdown's
          // render-prop ref type differs between them); `node` is dropped, the rest
          // spread onto a real anchor — identical output.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          a: ({ node: _node, ...props }: any) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
