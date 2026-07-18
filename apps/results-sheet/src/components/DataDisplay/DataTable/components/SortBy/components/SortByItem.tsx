import DragHandle from '@enmight/baseComponents/Interaction/DragHandle/DragHandle';
import React from 'react';
import { CSS } from '@dnd-kit/utilities';
import { Field } from '@enmight/types/apiTypes';
import { Flex, Tooltip, ActionIcon } from '@mantine/core';
import { FormattedSelectInput } from '@enmight/utils/formatters';
import { IconTrash } from '@tabler/icons-react';
import { SortByItemProps } from '../types';
import { Typography } from '@enmight/baseComponents/Typography/Typography';
import { useDataTableContext } from '../../../context/DataTable.context';
import { useSortable } from '@dnd-kit/sortable';

const SortByItem: React.FC<SortByItemProps> = ({ 
  sortByItem, 
  onUpdate, 
  onDelete,
  newSortByItems
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortByItem.id });

  const { columns } = useDataTableContext();
  const field: Field | undefined = columns.find(col => col.id === sortByItem.fieldId);

  // Exclude multi selectable columns
  const availableFields = columns
  .filter(column =>
    column.id === sortByItem.fieldId ||
    !newSortByItems.some(item => item.id !== sortByItem.id && item.fieldId === column.id)
  );

  const sortOptions = [
    {
      value: 'asc',
      label:
        field ? (
          field.type === 'TEXT' ? 'A to Z' :
          field.type === 'NUMBER' ? '1 to 9' :
          field.type === 'DATETIME' ? 'Oldest to Newest' :
          field.type === 'BOOLEAN' ? 'False to True' :
          'Ascending'
        ) : ''
    },
    {
      value: 'desc',
      label:
        field ? (
          field.type === 'TEXT' ? 'Z to A' :
          field.type === 'NUMBER' ? '9 to 1' :
          field.type === 'DATETIME' ? 'Newest to Oldest' :
          field.type === 'BOOLEAN' ? 'True to False' :
          'Descending'
        ) : ''
    }
  ];

  return (
    <div
      ref={setNodeRef}
      style={{
        display: 'flex',
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        padding: '4px 0',
      }}
    >
      <Flex
        align='center'
        w='100%'
        gap={6}
      >
        <DragHandle
          {...attributes}
          {...listeners}
          alwaysVisible
          tooltipLabel={
            <Typography c='var(--text-tooltip)' variant="label" size="md"><strong>Drag</strong> to reorder priorities</Typography>
          }
        />

        <FormattedSelectInput
          size='xs'
          placeholder="Select Field.."
          value={sortByItem.fieldId}
          onChange={(value) => onUpdate(sortByItem.id, { fieldId: value })}
          data={availableFields.map(col => ({
            value: col.id,
            label: col.displayName
          }))}
          required
          style={{ flex: 1 }}
          comboboxProps={{ withinPortal: false }}
        />

        <FormattedSelectInput
          size='xs'
          placeholder="Sort Order"
          value={sortByItem.sortState}
          onChange={(value) => onUpdate(sortByItem.id, { 
            sortState: value as 'asc' | 'desc' | null 
          })}
          data={sortOptions}
          style={{ flex: 1 }}
          disabled={!sortByItem.fieldId}
          comboboxProps={{ withinPortal: false }}
          allowDeselect={false}
        />

        <Tooltip
          arrowSize={6}
          label={
            <Typography c='var(--text-tooltip)' variant="label" size="md"><strong>Remove</strong> sort</Typography>
          }
          withArrow
          position="bottom"
          radius={0}
          transitionProps={{ transition: "fade", duration: 200 }}
          openDelay={250}
        >
          <ActionIcon
            aria-label="Remove sort"
            size='sm'
            variant="subtle"
            color='var(--border-strong)'
            onClick={() => onDelete(sortByItem.id)}
          >
            <IconTrash size={20} stroke={1.3} />
          </ActionIcon>
        </Tooltip>
      </Flex>
    </div>
  );
};

export default SortByItem;
