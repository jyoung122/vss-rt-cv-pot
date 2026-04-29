'use client'

interface VideoPlayerProps {
  playbackUrl: string | null
}

export default function VideoPlayer({ playbackUrl }: VideoPlayerProps) {
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
        <video
          src={playbackUrl}
          controls
          autoPlay
          loop
          className="w-full rounded border border-gray-800"
        />
      )}
    </div>
  )
}
