import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceWorker } from "@/components/service-worker";
import { ZoomLock } from "@/components/zoom-lock";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Vector", template: "%s · Vector" },
  description: "Issues and feature requests for small software teams.",
  applicationName: "Vector",
  // Home-screen web app on iOS (VEC-153). "default" keeps content below the status bar in standalone mode.
  appleWebApp: { capable: true, title: "Vector", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // Next 16 only emits mobile-web-app-capable for appleWebApp.capable; older iOS still reads the apple- name.
  other: { "apple-mobile-web-app-capable": "yes" },
};

// No zoom on mobile (VEC-154). iOS Safari ignores user-scalable in a tab, so ZoomLock and the
// pointer:coarse rules in globals.css cover pinch, double-tap and input-focus zoom there.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Browser chrome / status bar tint per theme (VEC-153); matches --background in globals.css.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="h-full">
        <ZoomLock />
        <ServiceWorker />
        <ThemeProvider>
          <TooltipProvider delayDuration={400}>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
