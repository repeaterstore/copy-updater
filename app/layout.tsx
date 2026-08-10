import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Copy Updater",
  description: "Propose, review and approve page copy against a real snapshot.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
