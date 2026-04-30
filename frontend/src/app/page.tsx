'use client'

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import UploadButton from '@/components/upload-button'
import VideoPlayer from '@/components/video-player'
import EventFeed from '@/components/event-feed'

interface VideoState {
  videoId: string
  playbackUrl: string
}

export default function Home() {
  const [videoState, setVideoState] = useState<VideoState | null>(null)
  const [resetKey, setResetKey] = useState(0)

  const apiUrl = ''
  const wsUrl = typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
    : ''

  const handleUpload = (result: VideoState) => {
    setVideoState(result)
    setResetKey((prev) => prev + 1)
  }

  const handleReset = async () => {
    try {
      await fetch(`${apiUrl}/api/reset`, {
        method: 'POST',
      })
    } catch (err) {
      console.warn('Reset endpoint not available:', err)
    }

    setVideoState(null)
    setResetKey((prev) => prev + 1)
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="text-sm font-light text-gray-400">
            VSS RT-CV — Perception POT
          </h1>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 space-y-4">
              <UploadButton onUpload={handleUpload} />
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
              <VideoPlayer
                playbackUrl={videoState?.playbackUrl || null}
                wsUrl={wsUrl}
                resetKey={resetKey}
              />
            </div>
          </div>

          {/* Right Column */}
          <div className="lg:col-span-1">
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 h-full flex flex-col space-y-3">
              <div className="flex justify-end">
                <button
                  onClick={handleReset}
                  title="Clear video and events"
                  className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 rounded transition-colors"
                >
                  <RotateCcw size={14} />
                  Reset
                </button>
              </div>

              <EventFeed wsUrl={wsUrl} resetKey={resetKey} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
