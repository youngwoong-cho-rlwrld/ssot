import DragHandle from "@enmight/baseComponents/Interaction/DragHandle/DragHandle";
import Filters from "@enmight/baseComponents/DataDisplay/Filters/Filters";
import React from "react";
import { CSS } from '@dnd-kit/utilities';
import type { ColorStylerItemProps } from "../types";
import {
  DEFAULT_TABLE_RULE_COLOR,
  normalizeTableColor,
  tableColorLabel,
  TABLE_COLOR_SWATCHES,
} from "@/lib/tableColors";
import { Flex, Tooltip, ActionIcon } from "@mantine/core";
import { FormattedColorInput, FormattedSelectInput } from "@enmight/utils/formatters";
import { IconTrash } from "@tabler/icons-react";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import { useDataTableContext } from "../../../context/DataTable.context";
import { useSortable } from "@dnd-kit/sortable";
import { Filters as FiltersType } from "@enmight/types/filterTypes";

const ColorStylerItem: React.FC<ColorStylerItemProps> = ({ colorStylerItem, onUpdate, onDelete }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: colorStylerItem.id });

  const { columns } = useDataTableContext();

  const handleUpdateColor = (id: string, value: string) => {
    onUpdate(id, { color: normalizeTableColor(value) ?? '' });
  };

  const handleUpdateTargetType = (id: string, targetType: 'cell' | 'row') => {
    onUpdate(id, { targetType });
    if (!colorStylerItem.color) {
      onUpdate(id, { color: DEFAULT_TABLE_RULE_COLOR });
    }
  };

  const hexValue = normalizeTableColor(colorStylerItem.color) ?? '';
  const colorLabel = tableColorLabel(colorStylerItem.color);

  return (
    <div
      ref={setNodeRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        padding: 8,
        backgroundColor: 'var(--background-gray-0-level-1)',
        borderRadius: 4,
      }}
    >
      <Flex
        align='center'
        justify='space-between'
        w='100%'
        style={{
          transition: 'margin 0.2s'
        }}
      >
        <Flex gap={12} align='center'>
          <DragHandle
            {...attributes}
            {...listeners}
            alwaysVisible
            tooltipLabel={
              <Typography c='var(--text-tooltip)' variant="label" size="md"><strong>Drag</strong> to reorder priorities</Typography>
            }
          />
          <Typography variant="label" size="lg">Color the</Typography>
          <FormattedSelectInput
            size='xs'
            value={colorStylerItem.targetType}
            onChange={(value) => handleUpdateTargetType(colorStylerItem.id, value as 'cell' | 'row')}
            data={[
              { value: 'cell', label: 'Cell' },
              { value: 'row', label: 'Row' }
            ]}
            w={100}
            comboboxProps={{ withinPortal: false }}
            placeholder="Select..."
          />
          <Typography variant="label" size="lg">with</Typography>
          <div style={{ position: 'relative', width: 180 }}>
            <FormattedColorInput
              size='xs'
              value={hexValue}
              onChange={(value) => handleUpdateColor(colorStylerItem.id, value)}
              format="hex"
              swatchesPerRow={8}
              swatches={TABLE_COLOR_SWATCHES}
              popoverProps={{ withinPortal: false }}
              placeholder="Select Color..."
              w={180}
              disallowInput
              withPicker={false}
              closeOnColorSwatchClick
              styles={() => ({
                input: {
                  fontSize: hexValue ? 0 : 14,
                }
              })}
            />
            {colorStylerItem.color && (
              <div style={{ 
                position: 'absolute', 
                top: '50%', 
                left: 36,
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                zIndex: 2,
                maxWidth: 'calc(100% - 50px)', 
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>
                <Typography variant="label" size="lg" fw={450}>{colorLabel}</Typography>
              </div>
            )}
          </div>
        </Flex>

        <Tooltip
          arrowSize={6}
          label={
            <Typography c='var(--text-tooltip)' variant="label" size="md"><strong>Remove</strong> condition</Typography>
          }
          withArrow
          position="bottom"
          radius={0}
          transitionProps={{ transition: "fade", duration: 200 }}
          openDelay={250}
        >
          <ActionIcon
            size='sm'
            variant="subtle"
            color='var(--border-strong)'
            onClick={() => onDelete(colorStylerItem.id)}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Tooltip>
      </Flex>

      <Filters
        columnOptions={columns}
        value={colorStylerItem.filter}
        onChange={(filters: FiltersType) => onUpdate(colorStylerItem.id, { filter: filters })}
        showTitle={false}
        allowMultiple={false}
      />
    </div>
  );
};

export default ColorStylerItem;
