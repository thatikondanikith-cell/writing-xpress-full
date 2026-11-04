import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Writing Xpress - Academic Writing Support",
  description: "Professional academic writing support platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
