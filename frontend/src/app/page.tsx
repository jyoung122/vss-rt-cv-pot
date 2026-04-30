'use client'

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'

import UploadButton from '@/components/upload-button'
import VideoPlayer from '@/components/video-player'
import EventFeed from '@/components/event-feed'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface VideoState {
  videoId: string
  playbackUrl: string
}

export default function DashboardPage() {
  const [videoState, setVideoState] = useState<VideoState | null>(null)
  const [resetKey, setResetKey] = useState(0)

  const apiUrl = ''
  const wsUrl =
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`
      : ''

  const handleUpload = (result: VideoState) => {
    setVideoState(result)
    setResetKey((prev) => prev + 1)
  }

  const handleReset = async () => {
    try {
      await fetch(`${apiUrl}/api/reset`, { method: 'POST' })
    } catch (err) {
      console.warn('Reset endpoint not available:', err)
    }
    setVideoState(null)
    setResetKey((prev) => prev + 1)
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upload</CardTitle>
          </CardHeader>
          <CardContent>
            <UploadButton onUpload={handleUpload} />
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <VideoPlayer
              playbackUrl={videoState?.playbackUrl || null}
              wsUrl={wsUrl}
              resetKey={resetKey}
            />
          </CardContent>
        </Card>
      </div>

      <div className="lg:col-span-1">
        <Card className="flex h-full flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="text-base">Events</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              title="Clear video and events"
              className="h-7 gap-1 text-xs"
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          </CardHeader>
          <CardContent className="flex-1">
            <EventFeed wsUrl={wsUrl} resetKey={resetKey} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
