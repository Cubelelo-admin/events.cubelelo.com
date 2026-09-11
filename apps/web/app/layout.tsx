import type { Metadata } from "next";
import { Suspense } from "react";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { ThemeProvider } from "@/features/theme/ThemeProvider";
import { NavBar } from "@/features/layout/NavBar";
import { Footer } from "@/features/layout/Footer";
import { PageProgressBar } from "@/features/layout/PageProgressBar";
import { ToastProvider } from "@/components/ui/Toast";
import { AnimatedBackground } from "@/components/AnimatedBackground";
import { Analytics } from "@/components/Analytics";

const sans = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

// Lets every route below hand generateMetadata() a relative OG image path
// (a competition banner, a profile avatar) and have it resolve to a real
// absolute URL — required for social previews to work at all.
const SITE_URL = process.env.APP_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Cubelelo Events",
    template: "%s · Cubelelo Events",
  },
  description:
    "Online speedcubing competitions — register, solve scrambles under timed conditions, and climb the rankings.",
  openGraph: {
    siteName: "Cubelelo Events",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${sans.variable} ${mono.variable}`}>
      <body className="flex h-full flex-col pt-14 overflow-hidden">
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <AnimatedBackground />
              <Suspense fallback={null}>
                <PageProgressBar />
                <Analytics />
              </Suspense>
              <NavBar />
              <div className="relative z-[1] flex flex-1 flex-col overflow-y-auto [will-change:scroll-position]">
                {children}
                <Footer />
              </div>
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
