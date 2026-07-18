import type { ColorStylerItemType } from "@enmight/types/layoutTypes";
import type { Dispatch, SetStateAction } from "react";
import type { Filters } from "@enmight/types/filterTypes";

export interface ColorStylerProps {
  newColorStylerItems: ColorStylerItemType[];
  setNewColorStylerItems: Dispatch<SetStateAction<ColorStylerItemType[]>>;
}

export interface UpdateOptionPayload {
  color?: string;
  filter?: Filters;
  targetType?: 'cell' | 'row';
}

export interface ColorStylerItemProps {
  colorStylerItem: ColorStylerItemType;
  onUpdate: (id: string, updates: UpdateOptionPayload) => void;
  onDelete: (id: string) => void;
}
