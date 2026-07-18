import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

export type ParquetRow = Record<string, unknown>;

async function sourceToArrayBuffer(source: File | string): Promise<ArrayBuffer> {
  if (source instanceof File) {
    return source.arrayBuffer();
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Unable to load parquet: ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

export async function loadParquetRows(source: File | string): Promise<ParquetRow[]> {
  const file = await sourceToArrayBuffer(source);
  return parquetReadObjects({ file, compressors }) as Promise<ParquetRow[]>;
}

export async function loadTextSource(source: File | string): Promise<string> {
  if (source instanceof File) {
    return source.text();
  }
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Unable to load URDF: ${response.status} ${response.statusText}`);
  }
  return response.text();
}
