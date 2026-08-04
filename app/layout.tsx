import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Naskh Studio — Arabic + English PDF editor",
  description: "A structured PDF editor proof of concept for native, scanned, Arabic, and English documents.",
  openGraph: {
    title: "Naskh Studio",
    description: "Arabic + English PDF editing",
    images: ["/og.png"],
  },
  twitter: { card: "summary_large_image", title: "Naskh Studio", description: "Arabic + English PDF editing", images: ["/og.png"] },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
