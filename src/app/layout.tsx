import type { Metadata, Viewport } from "next";
import { Inter, Instrument_Serif } from "next/font/google";
import { SITE } from "@/config/tracks";
import "@/styles/globals.css";

// Self-hosted by next/font, so there is no Google Fonts request at runtime.

/** UI voice: small, quiet, gets out of the way. */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans-stack",
});

/**
 * Display voice. A high-contrast serif is doing the real work here — it is what
 * stops the page reading as a default-stack template, and it sits with the warm,
 * painterly illustration in a way a geometric sans never would.
 */
const display = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-display",
});

/** §34 — lightweight but intentional. */
export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: SITE.title,
  description: SITE.description,
  applicationName: SITE.name,
  openGraph: {
    type: "website",
    siteName: SITE.name,
    title: SITE.title,
    description: SITE.description,
    url: SITE.url,
  },
  twitter: {
    card: "summary_large_image",
    creator: SITE.twitter,
    title: SITE.title,
    description: SITE.description,
  },
  /**
   * Both declared explicitly.
   *
   * Setting `icons` at all overrides Next's app/icon.* file convention, so
   * naming only `apple` here silently emitted NO <link rel="icon"> and the tab
   * fell back to a default globe — the favicon existed and was served, but
   * nothing pointed at it.
   */
  icons: {
    icon: [
      { url: "/Favicon.png", type: "image/png" },
    ],
    shortcut: "/Favicon.png",
    apple: "/Favicon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // §23 — enables env(safe-area-inset-*) so the player clears the home bar.
  viewportFit: "cover",
  themeColor: "#08080a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
