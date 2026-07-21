import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { navRoutes } from "@/lib/nav-routes";

export default function Home() {
  return (
    <div className="ssot-page">
      {/* Title and nav share one centered, constrained column so the rows keep a
          readable intrinsic width on wide screens; the page itself stays full-bleed. */}
      <div className="mx-auto max-w-2xl">
        <h1 className="text-xl font-semibold tracking-tight">Train / Eval</h1>
        <nav className="mt-6 divide-y divide-[var(--ssot-border)] border-y border-[var(--ssot-border)]">
          {navRoutes.map((r) => (
            <Tile key={r.href} href={r.href} icon={r.icon} title={r.title} desc={r.desc} />
          ))}
        </nav>
      </div>
    </div>
  );
}

function Tile({
  href,
  icon: Icon,
  title,
  desc,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 py-3 transition-colors hover:text-[var(--ssot-accent)]"
    >
      <Icon className="h-4 w-4 shrink-0 text-[var(--ssot-text-soft)] transition-colors group-hover:text-[var(--ssot-accent)]" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[13px] text-[var(--ssot-text-soft)]">{desc}</div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ssot-text-faint)] transition-colors group-hover:text-[var(--ssot-accent)]" />
    </Link>
  );
}
