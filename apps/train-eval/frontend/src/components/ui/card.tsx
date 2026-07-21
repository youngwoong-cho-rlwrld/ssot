import * as React from "react";
import { cn } from "@/lib/utils";

// Flat "section" grammar (OpenClaw style): no card chrome — sections are set
// apart by a thin top rule instead of rounded corners, borders on all sides,
// shadows, or chunky inner padding. Consumers still compose the same
// Card/CardHeader/CardTitle/CardContent parts, so the whole app flattens at
// once and stays consistent. Pass `border-t-0` to drop the divider (e.g. rows
// already separated by a parent `divide-y`).
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("border-t border-[var(--ssot-border)] pt-4 text-[var(--ssot-text)]", className)}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1 pb-3", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

// Section headings read as small labels sitting above their section, not as
// heavy card titles.
export const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm font-semibold tracking-tight", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-[13px] text-[var(--ssot-text-soft)]", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";
