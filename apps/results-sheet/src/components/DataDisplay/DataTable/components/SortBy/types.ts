import type { Dispatch, SetStateAction } from "react";
import type { SortByItemType } from "@enmight/types/layoutTypes";

export interface SortByItemProps {
  sortByItem: SortByItemType;
  onUpdate: (id: string, updates: UpdateOptionPayload) => void;
  onDelete: (id: string) => void;
  newSortByItems: SortByItemType[];
}

export interface UpdateOptionPayload {
  fieldId?: string | null;
  sortState?: 'asc' | 'desc' | null;
}

export interface SortByProps {
  newSortByItems: SortByItemType[];
  setNewSortByItems: Dispatch<SetStateAction<SortByItemType[]>>;
}
