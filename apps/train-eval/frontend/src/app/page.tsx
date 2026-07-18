import Link from "next/link";
import { navRoutes } from "@/lib/nav-routes";

export default function Home() {
  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Train / Eval</h1>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {navRoutes.map((r) => (
          <Tile key={r.href} href={r.href} icon={r.icon} title={r.title} desc={r.desc} />
        ))}
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
      className="rounded-lg border border-[var(--ssot-border)] bg-[var(--ssot-surface)] p-5 shadow-[var(--ssot-shadow)] transition-colors hover:border-[var(--ssot-accent)]"
    >
      <Icon className="h-5 w-5 text-[var(--ssot-text-soft)]" />
      <div className="mt-3 font-semibold">{title}</div>
      <div className="mt-1 text-[13px] text-[var(--ssot-text-soft)]">{desc}</div>
    </Link>
  );
}
