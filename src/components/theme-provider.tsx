"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * next-themes renders an inline <script> that sets the theme class before first paint. The server
 * renders it as a normal script. When React renders the document on the client instead (Next sends an
 * empty error shell for a notFound() thrown during the server render, and the client builds the whole
 * tree), React 19 warns about creating a script element, which shows as a dev overlay issue (VEC-138).
 * On the client the tag is marked as a data block, which React doesn't warn about; it would never run
 * there anyway. suppressHydrationWarning covers the type difference when a server-rendered page hydrates.
 */
const scriptProps =
  typeof window === "undefined" ? undefined : ({ type: "application/json", suppressHydrationWarning: true } as const);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange scriptProps={scriptProps}>
      {children}
    </NextThemesProvider>
  );
}
