import * as Mantine from "@mantine/core";
import React from "react";
import classes from "./Typography.module.css";

export interface TypographyProps extends Mantine.TextProps {
  size?: Mantine.MantineSize;
  variant?: "display" | "headline" | "body" | "label" | "title";
  onClick?: () => void;
}

export const Typography: React.FC<React.PropsWithChildren<TypographyProps>> = ({
  size = "md",
  variant = "body",
  onClick,
  children,
  ...props
}) => (
  <Mantine.Text
    {...props}
    classNames={classes}
    size={size}
    variant={variant}
    style={
      onClick
        ? {
            ...props.style,
            color: "var(--ssot-accent)",
            textDecoration: "underline",
            fontWeight: 600,
            cursor: "pointer",
          }
        : { ...props.style }
    }
    onClick={onClick}
  >
    {children}
  </Mantine.Text>
);
