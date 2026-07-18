"use client";

import { MantineProvider, localStorageColorSchemeManager } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { theme } from "./theme";

// Follow the shared <ssot-theme-toggle>, which persists "light"/"dark" under
// localStorage("ssot-theme") and sets data-mantine-color-scheme on <html>.
// Reading the same key here keeps Mantine's own color scheme in sync so it
// never overrides the toggle's attribute on hydration.
const colorSchemeManager = localStorageColorSchemeManager({ key: "ssot-theme" });

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider
        theme={theme}
        defaultColorScheme="light"
        colorSchemeManager={colorSchemeManager}
      >
        {children}
      </MantineProvider>
    </QueryClientProvider>
  );
}
