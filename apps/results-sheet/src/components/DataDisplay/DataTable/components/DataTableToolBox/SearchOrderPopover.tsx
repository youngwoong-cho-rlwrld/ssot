import * as Mantine from "@mantine/core";
import DragHandle from "@enmight/baseComponents/Interaction/DragHandle/DragHandle";
import React, { CSSProperties, useState } from "react";
import classes from './styles.module.css';
import { Button } from "@enmight/baseComponents/Buttons/Button";
import { CSS } from '@dnd-kit/utilities';
import { Field } from '@enmight/types/apiTypes';
import { IconHelpCircle, IconSettingsSearch } from "@tabler/icons-react";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { closestCenter, DndContext, DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { restrictToVerticalAxis, restrictToFirstScrollableAncestor } from '@dnd-kit/modifiers';
import { useDataTableContext } from "../../context/DataTable.context";

interface SearchOrderItemProps {
  column: Field;
}

const SearchOrderPopover: React.FC = () => {
  const { searchColumns, setSearchColumns } = useDataTableContext();
  const [opened, setOpened] = useState<boolean>(false);
  const [newSearchColumns, setNewSearchColumns] = useState<Field[]>(searchColumns);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
  
    const oldIndex = newSearchColumns.findIndex(item => item.id === active.id);
    const newIndex = newSearchColumns.findIndex(item => item.id === over.id);
    
    setNewSearchColumns(items => arrayMove(items, oldIndex, newIndex));
  };

  const handleClose = () => {
    setNewSearchColumns(searchColumns);
    setOpened(false);
  };

  const handleOpen = () => {
    setNewSearchColumns(searchColumns);
    setOpened(true);
  };

  const handleOpenedChange = (nextOpened: boolean) => {
    if (nextOpened) handleOpen();
    else handleClose();
  };

  const handleApply = () => {
    setSearchColumns(newSearchColumns);
    setOpened(false);
  };
  
  return (
    <Mantine.Popover opened={opened} onClose={handleClose} onChange={handleOpenedChange} position='bottom-end'>
      <Mantine.Popover.Target>
        <Mantine.ActionIcon
          aria-label="Configure search order"
          variant='subtle'
          c='var(--button-secondary)'
          onClick={opened ? handleClose : handleOpen}
        >
          <IconSettingsSearch size={20} stroke={1.3} />
        </Mantine.ActionIcon>
      </Mantine.Popover.Target>
      <Mantine.Popover.Dropdown>
        <Mantine.Stack gap='xs'>
          <Mantine.Group justify='space-between'>
            <Mantine.Group gap={6}>
              <Typography style={{ fontSize: 16, fontWeight: 500 }}>Search Order</Typography>

              <Mantine.Tooltip
                arrowSize={6}
                label={
                  <Typography c='var(--text-tooltip)' variant="label" size="md">
                    Drag and Drop fields to reorder search.
                  </Typography>
                }
                withArrow
                position="top"
                radius={0}
                multiline
                maw={240}
                transitionProps={{ transition: "fade", duration: 200 }}
                openDelay={250}
              >
                <IconHelpCircle color="var(--mantine-color-ssot-accent-4)" size={22} stroke={1.8} />
              </Mantine.Tooltip>
            </Mantine.Group>
            <Mantine.CloseButton 
              size='sm' 
              onClick={handleClose}
              data-testid="menu-close-button"
            />
          </Mantine.Group>
          <Mantine.Divider />
          <Mantine.Box style={{ position: 'relative' }}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            >
              <SortableContext
                items={newSearchColumns.map(item => item.id)}
                strategy={verticalListSortingStrategy}
              >
                {newSearchColumns.map((column) => (
                  <SearchOrderItem
                    key={column.id}
                    column={column}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </Mantine.Box>
          <Mantine.Divider />
          <Mantine.Group justify='space-between'>
            <Button 
              size='compact-md' 
              variant='subtle' 
              onClick={handleClose}
            >
              Cancel
            </Button>
            <Button 
              size='compact-md'
              onClick={handleApply}
            >
              Apply
            </Button>
          </Mantine.Group>
        </Mantine.Stack>
      </Mantine.Popover.Dropdown>
    </Mantine.Popover>
  )
};

const SearchOrderItem: React.FC<SearchOrderItemProps> = ({ column }) => {
  const {
    setNodeRef,
    transform,
    transition,
    isDragging,
    attributes,
    listeners,
  } = useSortable({ id: column.id });

  const styles: CSSProperties = {
    display: 'flex',
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    padding: '4px 0',
    backgroundColor: isDragging ? 'var(--field-background)' : undefined,
    outline: isDragging ? '1px dashed var(--ssot-accent)' : undefined,
    pointerEvents: isDragging ? 'none' : undefined,
    position: 'relative' as const,
    zIndex: isDragging ? 2 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={styles}
      className={classes.item}
      {...attributes}
      {...listeners}
    >
      <Mantine.Group
        gap={6}
        style={{
          width: '100%',
          transition: 'margin 0.2s'
        }}
      >
        <DragHandle
          tooltipLabel={
            <Typography c='var(--text-tooltip)' variant="label" size="md"><strong>Drag</strong> to reorder search</Typography>
          }
          alwaysVisible
        />
        <Typography style={{ fontSize: 14 }}>{column.displayName}</Typography>
      </Mantine.Group>
    </div>
  );
};

export default SearchOrderPopover;
