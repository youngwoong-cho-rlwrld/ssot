import ColorStylerItem from "./components/ColorStylerItem";
import React, { useEffect } from "react";
import { Button } from "@enmight/baseComponents/Buttons/Button";
import { ColorStylerItemType } from "@enmight/types/layoutTypes";
import { ColorStylerProps, UpdateOptionPayload } from "./types";
import { DndContext, useSensors, useSensor, PointerSensor, KeyboardSensor, closestCenter, DragEndEvent } from "@dnd-kit/core";
import { IconHelpCircle, IconPlus } from "@tabler/icons-react";
import { Stack, Group, Divider, Tooltip } from "@mantine/core";
import { Typography } from "@enmight/baseComponents/Typography/Typography";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { createEmptyFilters } from "@enmight/utils/tables/filters";
import { restrictToVerticalAxis, restrictToFirstScrollableAncestor } from "@dnd-kit/modifiers";
import { makeId } from "@/lib/id";

const ColorStyler: React.FC<ColorStylerProps> = ({ newColorStylerItems, setNewColorStylerItems }) => {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // If there is no color styler items, add an empty item
  useEffect(() => {
    if (newColorStylerItems.length === 0 ) {
      setNewColorStylerItems([emptyColorRule()]);
    }
  }, [newColorStylerItems, setNewColorStylerItems]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
  
    const oldIndex = newColorStylerItems.findIndex(item => item.id === active.id);
    const newIndex = newColorStylerItems.findIndex(item => item.id === over.id);
    
    setNewColorStylerItems(items => arrayMove(items, oldIndex, newIndex));
    
  };
  
  const handleAddOption = () => {    
    setNewColorStylerItems(items => [...items, emptyColorRule()]);
    
  };
  
  const handleUpdateOption = (id: string, updates: UpdateOptionPayload) => {
    setNewColorStylerItems(items => items.map(item => {
      if (item.id === id) {
        return { ...item, ...updates };
      }
      return item;
    }));
    
  };
  
  const handleDeleteOption = (id: string) => {
    if (newColorStylerItems.length === 1) {
      setNewColorStylerItems([emptyColorRule()]);
    } else {
      setNewColorStylerItems(items => items.filter(item => item.id !== id));
    }
    
  };

  return (
    <Stack gap={0}>
      <Group gap={6}>
        <Typography variant="label" size="lg">Color</Typography>

        <Tooltip
          arrowSize={6}
          label={
            <Typography c='var(--text-tooltip)' variant="label" size="md">
              An item&apos;s color is set by the highest-listed rule it matches.
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

      <Stack gap={8} style={{ position: 'relative' }}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        >
          <SortableContext
            items={newColorStylerItems.map(item => item.id)}
            strategy={verticalListSortingStrategy}
          >
            {newColorStylerItems.map((item) => (
              <ColorStylerItem
                key={item.id}
                colorStylerItem={item}
                onUpdate={handleUpdateOption}
                onDelete={handleDeleteOption}
              />
            ))}
          </SortableContext>
        </DndContext>
      </Stack>

      <Group mt={12}>
        <Button
          variant='subtle'
          onClick={handleAddOption}
          size="compact-sm"
          c='var(--text-primary)'
          leftSection={
            <IconPlus size={16} stroke={1.3} color='var(--text-primary)' />
          }
        >
          Add New Coloring Condition
        </Button>
      </Group>

      <Divider mt={12} mb={0} />
    </Stack>
  );
};

export default ColorStyler;

function emptyColorRule(): ColorStylerItemType {
  return {
    id: makeId("color"),
    color: "",
    targetType: null,
    filter: createEmptyFilters(),
  };
}
