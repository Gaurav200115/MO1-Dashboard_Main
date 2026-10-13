import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-archivo",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nifty 200 Desk",
  description: "Sector-segmented fundamentals for the Nifty 200, with results tracking.",
};

/**
 * Applies the stored theme before first paint so the page never flashes the
 * wrong ground. Dark is the default: anything that is not an explicit "light" or
 * "system" resolves to it, and if this script never runs at all the stylesheet's
 * unstamped `:root` is dark too, so the failure mode is dark rather than light.
 */
const themeBootstrap = `
try {
  var t = localStorage.getItem("n200-theme");
  document.documentElement.setAttribute("data-theme", t === "light" || t === "system" ? t : "dark");
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
