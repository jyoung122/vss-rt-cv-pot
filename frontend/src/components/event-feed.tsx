'use client'

import { useEffect, useRef, useState } from 'react'
import { Circle } from 'lucide-react'

interface DetectionObject {
  type: string
  id: string
  bbox: {
    topleftx: number
    toplefty: number
    bottomrightx: number
    bottomrighty: number
  }
}

interface DisplayEvent {
  id: string
  timestamp: string
  sensorId: string
  objects: DetectionObject[]
}

interface EventFeedProps {
  wsUrl: string
  resetKey: number
}

export default function EventFeed({ wsUrl, resetKey }: EventFeedProps) {
  const [events, setEvents] = useState<DisplayEvent[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    setEvents([])
    setIsConnected(false)

    const connectWebSocket = () => {
      try {
        const ws = new WebSocket(`${wsUrl}/ws/events`)

        ws.onopen = () => {
          setIsConnected(true)
          console.log('WebSocket connected')
        }

        ws.onmessage = (event) => {
          try {
            // DeepStream MDX broker sends a single field "metadata" whose value is a JSON string.
            const wrapper = JSON.parse(event.data) as { metadata?: string }
            if (!wrapper.metadata) return
            const data = JSON.parse(wrapper.metadata) as {
              id?: string
              ['@timestamp']?: string
              sensorId?: string
              objects?: string[]
            }
            const objects: DetectionObject[] = (data.objects || []).map((line) => {
              // Format: id|x1|y1|x2|y2|class|#|||||||confidence
              const parts = line.split('|')
              return {
                id: parts[0] || '',
                type: parts[5] || 'unknown',
                bbox: {
                  topleftx: parseFloat(parts[1]) || 0,
                  toplefty: parseFloat(parts[2]) || 0,
                  bottomrightx: parseFloat(parts[3]) || 0,
                  bottomrighty: parseFloat(parts[4]) || 0,
                },
              }
            })
            const timestamp = data['@timestamp'] || new Date().toISOString()
            const newEvent: DisplayEvent = {
              id: `${data.id || ''}-${Date.now()}`,
              timestamp,
              sensorId: data.sensorId || '',
              objects,
            }

            // Stick to top only if the user is already near the top — otherwise leave their scroll alone.
            const el = scrollContainerRef.current
            const stickToTop = !el || el.scrollTop < 40
            setEvents((prevEvents) => {
              const updated = [newEvent, ...prevEvents]
              return updated.slice(0, 100)
            })
            if (stickToTop && el) {
              el.scrollTop = 0
            }
          } catch (err) {
            console.error('Failed to parse event:', err, event.data)
          }
        }

        ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          setIsConnected(false)
        }

        ws.onclose = () => {
          setIsConnected(false)
          console.log('WebSocket disconnected')
          // Reconnect with 3s backoff
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000)
        }

        wsRef.current = ws
      } catch (err) {
        console.error('Failed to connect WebSocket:', err)
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000)
      }
    }

    connectWebSocket()

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [wsUrl, resetKey])

  return (
    <div className="flex flex-col h-full space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300">Detection Events</h2>
        <div className="flex items-center gap-2">
          <Circle
            size={10}
            className={isConnected ? 'fill-green-500 text-green-500' : 'fill-red-500 text-red-500'}
          />
          <span className="text-xs text-gray-400">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-[300px] max-h-[70vh] overflow-y-auto space-y-1 bg-gray-950 rounded border border-gray-800 p-3"
      >
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Waiting for events...
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="text-xs text-gray-300 font-mono border-l border-gray-700 pl-2 py-1 hover:bg-gray-900 transition-colors"
            >
              <div className="text-gray-500">{event.timestamp}</div>
              <div className="text-gray-400">
                Sensor: <span className="text-cyan-400">{event.sensorId}</span>
              </div>
              {event.objects.length > 0 ? (
                <div className="mt-1 space-y-0.5">
                  {event.objects.map((obj) => (
                    <div key={`${obj.id}`} className="text-gray-300">
                      <span className="text-green-400">{obj.type}</span>
                      {' | '}
                      <span className="text-yellow-400">ID: {obj.id}</span>
                      {' | '}
                      <span className="text-blue-400">
                        ({Math.round(obj.bbox.topleftx)}, {Math.round(obj.bbox.toplefty)}) - ({Math.round(obj.bbox.bottomrightx)}, {Math.round(obj.bbox.bottomrighty)})
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-gray-500">No objects detected</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
