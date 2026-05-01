'use client'

import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'

import { createLogger } from '@/lib/logger'

const log = createLogger('components.upload-button')

interface UploadResult {
  videoId: string
  playbackUrl: string
}

interface UploadButtonProps {
  onUpload: (result: UploadResult) => void
}

export default function UploadButton({ onUpload }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apiUrl = ''

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsLoading(true)
    setError(null)

    try {
      log.info('upload.client.start', { filename: file.name, size_bytes: file.size })
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(`${apiUrl}/api/upload`, {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`)
      }

      const data = await response.json()
      log.info('upload.client.complete', { video_id: data.video_id, status_code: response.status })
      onUpload({
        videoId: data.video_id,
        playbackUrl: `${apiUrl}${data.playback_url}`,
      })

      // Reset input
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      log.error('upload.client.error', { error: err })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mkv"
        onChange={handleFileSelect}
        className="hidden"
        disabled={isLoading}
      />

      <button
        onClick={() => inputRef.current?.click()}
        disabled={isLoading}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white rounded font-medium transition-colors"
      >
        <Upload size={18} />
        {isLoading ? 'Uploading...' : 'Upload Video'}
      </button>

      {error && (
        <div className="px-3 py-2 bg-red-900/30 border border-red-700 text-red-200 rounded text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
