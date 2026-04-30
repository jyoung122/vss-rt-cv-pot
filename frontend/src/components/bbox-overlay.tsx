'use client'

import { useEffect, useRef } from 'react'

// Source video resolution — bboxes from DeepStream are in this coordinate space.
const SRC_W = 1280
const SRC_H = 720

const CLASS_COLORS: Record<string, string> = {
  car: '#3b82f6',
  person: '#22c55e',
  bicycle: '#f59e0b',
  road_sign: '#ec4899',
}

interface Box {
  id: string
  type: string
  x1: number
  y1: number
  x2: number
  y2: number
}

interface BboxOverlayProps {
  wsUrl: string
  resetKey: number
}

export default function BboxOverlay({ wsUrl, resetKey }: BboxOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<NodeJS.Timeout | null>(null)
  const boxesRef = useRef<Box[]>([])
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = SRC_W
    canvas.height = SRC_H

    const draw = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, SRC_W, SRC_H)
      ctx.lineWidth = 3
      ctx.font = '16px monospace'
      ctx.textBaseline = 'top'
      for (const b of boxesRef.current) {
        const color = CLASS_COLORS[b.type] || '#a3a3a3'
        ctx.strokeStyle = color
        const w = b.x2 - b.x1
        const h = b.y2 - b.y1
        ctx.strokeRect(b.x1, b.y1, w, h)
        const label = `${b.type}#${b.id}`
        const labelW = ctx.measureText(label).width + 6
        ctx.fillStyle = color
        ctx.fillRect(b.x1, Math.max(0, b.y1 - 18), labelW, 18)
        ctx.fillStyle = '#000'
        ctx.fillText(label, b.x1 + 3, Math.max(0, b.y1 - 17))
      }
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)

    const connect = () => {
      try {
        const ws = new WebSocket(`${wsUrl}/ws/events`)
        ws.onmessage = (event) => {
          try {
            const wrapper = JSON.parse(event.data) as { metadata?: string }
            if (!wrapper.metadata) return
            const data = JSON.parse(wrapper.metadata) as { objects?: string[] }
            const next: Box[] = (data.objects || []).map((line) => {
              const p = line.split('|')
              return {
                id: p[0] || '',
                type: p[5] || 'unknown',
                x1: parseFloat(p[1]) || 0,
                y1: parseFloat(p[2]) || 0,
                x2: parseFloat(p[3]) || 0,
                y2: parseFloat(p[4]) || 0,
              }
            })
            boxesRef.current = next
          } catch {
            // ignore malformed
          }
        }
        ws.onclose = () => {
          boxesRef.current = []
          reconnectRef.current = setTimeout(connect, 3000)
        }
        ws.onerror = () => {
          boxesRef.current = []
        }
        wsRef.current = ws
      } catch {
        reconnectRef.current = setTimeout(connect, 3000)
      }
    }
    connect()

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (wsRef.current) wsRef.current.close()
      boxesRef.current = []
    }
  }, [wsUrl, resetKey])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  )
}
