import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'VSS RT-CV POT',
  description: 'Real-time Computer Vision Perception on Tape',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
