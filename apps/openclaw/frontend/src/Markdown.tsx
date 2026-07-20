import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Shared markdown renderer for chat + transcript message bodies. react-markdown
// does not render raw HTML by default, so this is XSS-safe without extra config.
// Links open in a new tab with a safe rel; everything else is styled via the
// `.md` scope in styles.css using the shared --ssot-* tokens.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
