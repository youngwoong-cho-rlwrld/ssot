import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ cluster: string; id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Job ${id} videos`,
  };
}

export default function JobVideosLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
