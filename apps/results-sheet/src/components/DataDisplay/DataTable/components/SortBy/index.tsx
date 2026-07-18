import React, { useEffect } from "react";
import SortByItem from "./components/SortByItem";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import { DndContext, useSensors, useSensor, PointerSensor, KeyboardSensor, closestCenter, DragEndEvent } from "@dnd-kit/core";
import { IconHelpCircle, IconPlus } from "@tabler/icons-react";
import { SortByItemType } from "@enmight/types/layoutTypes";
import { SortByProps, UpdateOptionPayload } from "./types";
import { Stack, Box, Group, Divider, Tooltip } from "@mantine/core";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToFirstScrollableAncestor } from "@dnd-kit/modifiers";
import { makeId } from "@/lib/id";

const SortBy: React.FC<SortByProps> = ({ newSortByItems, setNewSortByItems }) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // If there is no sort by items, add an empty item
  useEffect(() => {
    if (newSortByItems.length === 0 ) {
      setNewSortByItems([emptySortRule()]);
    }
  }, [newSortByItems, setNewSortByItems]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
  
    const oldIndex = newSortByItems.findIndex(item => item.id === active.id);
    const newIndex = newSortByItems.findIndex(item => item.id === over.id);
    
    setNewSortByItems(items => arrayMove(items, oldIndex, newIndex));
  };
  
  const handleAddOption = () => {
    setNewSortByItems(items => [...items, emptySortRule()]);
  };
  
  const handleUpdateOption = (id: string, updates: UpdateOptionPayload) => {
    setNewSortByItems(items => items.map(item => {
      if (item.id === id) {
        // If fieldId is being updated and it's not null, automatically set sortState to 'asc'
        if ('fieldId' in updates && updates.fieldId !== null) {
          return { ...item, ...updates, sortState: 'asc' };
        }
        return { ...item, ...updates };
      }
      return item;
    }));
  };
  
  const handleDeleteOption = (id: string) => {
    if (newSortByItems.length === 1) {
      setNewSortByItems([emptySortRule()]);
    } else {
      setNewSortByItems(items => items.filter(item => item.id !== id));
    }
  };

  return (
    <Stack gap={0}>
      <Group gap={6}>
        <Typography variant="label" size="lg">Sort by</Typography>

        <Tooltip
          arrowSize={6}
          label={
            <Typography c='var(--text-tooltip)' variant="label" size="md">
              The top sort is primary; others below act as tiebreakers, prioritized top to bottom.
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
        </Tooltip>
      </Group>
      
      <Divider mt={6} mb={12} />

      <Box style={{ position: 'relative' }}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        >
          <SortableContext
            items={newSortByItems.map(item => item.id)}
            strategy={verticalListSortingStrategy}
          >
            {newSortByItems.map((item) => (
              <SortByItem
                key={item.id}
                sortByItem={item}
                onUpdate={handleUpdateOption}
                onDelete={handleDeleteOption}
                newSortByItems={newSortByItems}
              />
            ))}
          </SortableContext>
        </DndContext>
      </Box>

      <Group>
        <Button
          variant='subtle'
          onClick={handleAddOption}
          size="compact-sm"
          c='var(--text-primary)'
          leftSection={
            <IconPlus size={16} stroke={1.3} color='var(--text-primary)' />
          }
        >            
          Add a Field to Sort by
        </Button>
      </Group>

      <Divider mt={6} mb={0} />
    </Stack>
  );
};

export default SortBy;

function emptySortRule(): SortByItemType {
  return { id: makeId("sort"), fieldId: null, sortState: null };
}
