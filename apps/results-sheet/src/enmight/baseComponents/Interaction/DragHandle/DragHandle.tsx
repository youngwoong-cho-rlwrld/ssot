import React from "react";
import { IconGripVertical } from "@tabler/icons-react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { useDndContext } from "@dnd-kit/core";

interface DragHandleProps extends React.HTMLAttributes<HTMLDivElement> {
  tooltipLabel?: React.ReactNode;
  alwaysVisible?: boolean;
}

const DragHandle: React.FC<DragHandleProps> = ({
  tooltipLabel,
  alwaysVisible,
  ...props
}) => {
  const { active } = useDndContext();

  const content = (
    <div
      {...props}
      style={{
        display: "flex",
        alignItems: "center",
        opacity: alwaysVisible ? 1 : undefined,
        transition: "opacity 0.2s ease-in-out, background-color 0.2s ease-in-out",
      }}
    >
      <ActionIcon
        size="sm"
        variant="subtle"
        color="var(--enmight-gray-4)"
        style={{ cursor: "grab" }}
      >
        <IconGripVertical stroke={1.3} color="var(--text-secondary)" size={20} />
      </ActionIcon>
    </div>
  );

  if (active || !tooltipLabel) return content;

  return (
    <Tooltip
      arrowSize={6}
      label={tooltipLabel}
      withArrow
      position="bottom"
      radius={0}
      transitionProps={{ transition: "fade", duration: 200 }}
      openDelay={500}
    >
      {content}
    </Tooltip>
  );
};

export default DragHandle;
