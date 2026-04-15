import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "X Bookmark Harvester",
  description: "Harvest X bookmarks into an Obsidian vault",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
