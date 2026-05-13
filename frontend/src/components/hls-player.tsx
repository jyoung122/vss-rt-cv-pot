"use client"

import { useEffect, useRef } from "react"
import Hls from "hls.js"

interface HlsPlayerProps {
  src: string
  className?: string
  muted?: boolean
}

export function HlsPlayer({ src, className, muted = true }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    // Safari plays HLS natively; Chrome/Firefox need hls.js.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src
      return
    }

    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDuration: 1.5,
        liveMaxLatencyDuration: 6,
        maxBufferLength: 8,
        enableWorker: true,
      })
      hls.loadSource(src)
      hls.attachMedia(video)
      return () => {
        hls.destroy()
      }
    }
    return
  }, [src])

  return (
    <video
      ref={videoRef}
      className={className}
      autoPlay
      muted={muted}
      playsInline
      controls={false}
    />
  )
}
