import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Canonical control look mapped from libs/theme/controls.css: 32px height,
// var(--ssot-radius-sm), 13px/500 text, border var(--ssot-border-strong) at
// rest, accent hover, and a 2px var(--ssot-ring) focus ring (no offset).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--ssot-radius-sm)] border text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:ring-[color:var(--ssot-ring)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border-[var(--ssot-accent)] bg-[var(--ssot-accent)] text-white hover:border-[var(--ssot-accent-strong)] hover:bg-[var(--ssot-accent-strong)]",
        destructive:
          "border-[var(--ssot-danger)] bg-[var(--ssot-danger)] text-white hover:opacity-90",
        destructiveOutline:
          "border-[var(--ssot-danger)] bg-[var(--ssot-surface)] text-[var(--ssot-danger)] hover:bg-[var(--ssot-danger-soft)]",
        outline:
          "border-[var(--ssot-border-strong)] bg-[var(--ssot-surface)] text-[var(--ssot-text)] hover:border-[var(--ssot-accent)] hover:bg-[var(--ssot-accent-soft)]",
        secondary:
          "border-[var(--ssot-border-strong)] bg-[var(--ssot-surface-muted)] text-[var(--ssot-text)] hover:border-[var(--ssot-accent)] hover:bg-[var(--ssot-accent-soft)]",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2 text-[12px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
