import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "flex h-8 w-full rounded-[var(--ssot-radius-sm)] border border-[var(--ssot-border-strong)] bg-[var(--ssot-surface)] px-3 text-[13px] text-[var(--ssot-text)] shadow-sm transition-colors file:border-0 file:bg-transparent file:text-[13px] file:font-medium placeholder:text-[var(--ssot-text-faint)] focus-visible:border-[var(--ssot-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ssot-ring)] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
