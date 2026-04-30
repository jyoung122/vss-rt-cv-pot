'use client'

import BboxOverlay from './bbox-overlay'

interface VideoPlayerProps {
  playbackUrl: string | null
  wsUrl: string
  resetKey: number
}

export default function VideoPlayer({ playbackUrl, wsUrl, resetKey }: VideoPlayerProps) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-gray-300">Video Playback</h2>

      {!playbackUrl ? (
        <div className="w-full aspect-video bg-gray-900 rounded flex items-center justify-center border border-gray-800">
          <span className="text-gray-500 text-center px-4">
            Upload a video to begin
          </span>
        </div>
      ) : (
        <div className="relative w-full">
          <video
            src={playbackUrl}
            controls
            autoPlay
            loop
            className="w-full rounded border border-gray-800 block"
          />
          <BboxOverlay wsUrl={wsUrl} resetKey={resetKey} />
        </div>
      )}
    </div>
  )
}
