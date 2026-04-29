'use client'

import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'

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

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080'

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsLoading(true)
    setError(null)

    try {
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
      onUpload({
        videoId: data.videoId,
        playbackUrl: data.playbackUrl,
      })

      // Reset input
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      console.error('Upload error:', err)
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
