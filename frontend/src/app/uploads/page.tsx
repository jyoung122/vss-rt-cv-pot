'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Loader2,
  Play,
  Trash2,
  Upload as UploadIcon,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'

type UploadItem = {
  video_id: string
  filename: string
  size_bytes: number
  uploaded_at: string
  playback_url: string
}

const ACCEPT = '.mp4,.mkv'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function formatTime(iso: string) {
  const d = new Date(iso)
  const now = Date.now()
  const diff = (now - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function UploadsPage() {
  const [items, setItems] = useState<UploadItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{
    name: string
    pct: number
  } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<UploadItem | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/uploads', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(data.uploads ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load uploads')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleUpload = useCallback(
    async (file: File) => {
      setError(null)
      setUploading(true)
      setUploadProgress({ name: file.name, pct: 0 })

      try {
        // Use XHR so we can show real upload progress.
        const result = await new Promise<unknown>((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', '/api/upload')
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              setUploadProgress({
                name: file.name,
                pct: Math.round((e.loaded / e.total) * 100),
              })
            }
          }
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText))
              } catch (e) {
                reject(e)
              }
            } else {
              reject(new Error(`Upload failed: HTTP ${xhr.status}`))
            }
          }
          xhr.onerror = () => reject(new Error('Network error'))
          const fd = new FormData()
          fd.append('file', file)
          xhr.send(fd)
        })
        // result discarded — refresh re-reads the canonical list
        void result
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed')
      } finally {
        setUploading(false)
        setUploadProgress(null)
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [refresh],
  )

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleUpload(file)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!ACCEPT.split(',').some((ext) => file.name.toLowerCase().endsWith(ext))) {
      setError(`Only ${ACCEPT} accepted`)
      return
    }
    void handleUpload(file)
  }

  const handleDelete = async (item: UploadItem) => {
    try {
      const res = await fetch(`/api/uploads/${item.video_id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`Delete failed: HTTP ${res.status}`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setPendingDelete(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            onChange={onPickFile}
            className="hidden"
            disabled={uploading}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
            disabled={uploading}
            className={cn(
              'flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/30 px-6 py-10 transition-colors',
              'hover:border-primary/60 hover:bg-muted/50',
              'disabled:cursor-not-allowed disabled:opacity-60',
              dragActive && 'border-primary bg-primary/5',
            )}
          >
            {uploading ? (
              <>
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <div className="text-sm font-medium">
                  Uploading {uploadProgress?.name}…
                </div>
                {uploadProgress && (
                  <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${uploadProgress.pct}%` }}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <UploadIcon className="size-6 text-muted-foreground" />
                <div className="text-sm font-medium">
                  Drop a clip here or click to choose
                </div>
                <div className="text-xs text-muted-foreground">
                  .mp4 or .mkv · max 500MB
                </div>
              </>
            )}
          </button>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <X className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">History</CardTitle>
          <Badge variant="secondary" className="font-mono">
            {items.length}
          </Badge>
        </CardHeader>
        <Separator />
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-6 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No uploads yet. Drop a clip above to get started.
            </div>
          ) : (
            <ScrollArea className="max-h-[60vh]">
              <ul className="divide-y divide-border">
                {items.map((item) => (
                  <li
                    key={item.video_id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40"
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <CheckCircle2 className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {item.filename}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{formatBytes(item.size_bytes)}</span>
                        <span>·</span>
                        <span>{formatTime(item.uploaded_at)}</span>
                        <span>·</span>
                        <span className="font-mono text-[11px]">
                          {item.video_id}
                        </span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPreviewUrl(item.playback_url)}
                      title="Preview"
                    >
                      <Play className="size-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPendingDelete(item)}
                      title="Delete"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!previewUrl}
        onOpenChange={(open) => {
          if (!open) setPreviewUrl(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
          </DialogHeader>
          {previewUrl && (
            <video
              src={previewUrl}
              controls
              autoPlay
              className="w-full rounded-md bg-black"
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this upload?</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            <span className="font-mono">{pendingDelete?.filename}</span> will be
            permanently removed from the server.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && handleDelete(pendingDelete)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
