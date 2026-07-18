import * as Mantine from "@mantine/core";
import React from "react";
import classes from "./Button.module.css";

interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "color" | "style">,
    Mantine.ButtonProps {
  variant?:
    | "primary"
    | "primary-outlined"
    | "secondary"
    | "secondary-outlined"
    | "tertiary"
    | "alert"
    | "alert-outlined"
    | "yellow"
    | "yellow-outlined"
    | "subtle";
  size?:
    | "xl"
    | "lg"
    | "md"
    | "sm"
    | "xs"
    | "compact-xl"
    | "compact-lg"
    | "compact-md"
    | "compact-sm"
    | "compact-xs";
}

export const Button: React.ForwardRefExoticComponent<
  ButtonProps & React.RefAttributes<HTMLButtonElement> & { component?: unknown }
> = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "sm", children, ...props }, ref) => (
    <Mantine.Button
      ref={ref}
      {...props}
      classNames={classes}
      variant={variant}
      size={size}
    >
      {children}
    </Mantine.Button>
  ),
);

Button.displayName = "Button";
