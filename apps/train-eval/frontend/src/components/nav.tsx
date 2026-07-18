"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { navRoutes } from "@/lib/nav-routes";

export function Nav() {
  const pathname = usePathname();
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-[var(--ssot-border)] bg-[var(--ssot-surface-muted)] px-3 py-6">
      <Link href="/" className="mb-6 px-3 text-sm font-semibold tracking-tight text-[var(--ssot-text)]">
        Train / Eval
      </Link>
      <nav className="flex flex-col gap-1">
        {navRoutes.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ssot-ring)]",
                active
                  ? "bg-[var(--ssot-accent-soft)] text-[var(--ssot-accent)]"
                  : "text-[var(--ssot-text-soft)] hover:bg-[var(--ssot-accent-soft)] hover:text-[var(--ssot-text)]",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
