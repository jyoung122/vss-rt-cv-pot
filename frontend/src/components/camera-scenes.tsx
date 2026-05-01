'use client'

// ─── Shared camera scene components ──────────────────────────────────────────
// Extracted from live/page.tsx so the event detail page can reuse them.

export type Scene = 'highway' | 'intersection' | 'roundabout' | 'wrongway' | 'stalled' | 'flood'

const ROAD = '#1f242d'
const LANE = '#d8c985'

export function CarShape({ x, y, w = 22, h = 12, color = '#4a9', rot = 0, alert: hasAlert = false }: {
  x: number; y: number; w?: number; h?: number
  color?: string; rot?: number; alert?: boolean
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
      {hasAlert && (
        <rect x={-w/2-4} y={-h/2-4} width={w+8} height={h+8}
          fill="none" stroke="#ff5a4b" strokeWidth="1.2" strokeDasharray="3 2" />
      )}
      <rect x={-w/2} y={-h/2} width={w} height={h} rx="2" fill={color} />
      <rect x={-w/2+2} y={-h/2+2} width={w-4} height={h-4} rx="1" fill="rgba(0,0,0,0.25)" />
      <rect x={w/2-3} y={-h/2+1} width={2} height={h-2} fill="rgba(255,255,255,0.15)" />
    </g>
  )
}

export function HighwayScene({ t }: { t: number }) {
  const cars = [
    { lane: 0, offset: (t * 60) % 400, color: '#d5d8dd' },
    { lane: 0, offset: (t * 60 + 140) % 400, color: '#2a3140' },
    { lane: 1, offset: (t * 45) % 400, color: '#7a2424' },
    { lane: 1, offset: (t * 45 + 180) % 400, color: '#4b5260' },
    { lane: 2, offset: (t * 70 + 60) % 400, color: '#c4c8cf' },
    { lane: 2, offset: (t * 70 + 220) % 400, color: '#1f4a6e' },
  ]
  return (
    <svg viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}>
      <defs>
        <linearGradient id="sky-hw" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1a2030" />
          <stop offset="1" stopColor="#0a0d14" />
        </linearGradient>
      </defs>
      <rect width="400" height="225" fill="url(#sky-hw)" />
      <rect y="30" width="400" height="30" fill="#121722" />
      <polygon points="0,225 400,225 280,60 120,60" fill={ROAD} />
      {[0, 1, 2].map((i) => (
        <g key={i} opacity="0.85">
          {Array.from({ length: 8 }).map((_, j) => {
            const y = 65 + j * 22
            const p = j / 8
            const xc = 120 + (i + 0.5) * (160/3) * (1 - p * 0.3)
            const w = 3 + p * 2
            const h = 6 + p * 4
            return <rect key={j} x={xc - w/2} y={y} width={w} height={h} fill={LANE} opacity={0.4 + p * 0.5} />
          })}
        </g>
      ))}
      {cars.map((c, i) => {
        const p = c.offset / 400
        const topX = 120 + (c.lane + 0.5) * (160/3)
        const botX = -40 + (c.lane + 0.5) * (480/3)
        const x = topX + (botX - topX) * p
        const y = 60 + 165 * p
        const s = 0.35 + p * 0.9
        return <CarShape key={i} x={x} y={y} w={22*s} h={12*s} color={c.color} />
      })}
    </svg>
  )
}

export function IntersectionScene({ t }: { t: number }) {
  return (
    <svg viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="400" height="225" fill="#0d1118" />
      <rect x="0" y="90" width="400" height="60" fill={ROAD} />
      <rect x="170" y="0" width="60" height="225" fill={ROAD} />
      {Array.from({ length: 12 }).map((_, i) =>
        <rect key={`h${i}`} x={i*36+10} y={119} width={14} height={2} fill={LANE} opacity="0.7" />
      )}
      {Array.from({ length: 6 }).map((_, i) =>
        <rect key={`v${i}`} x={199} y={i*40+4} width={2} height={14} fill={LANE} opacity="0.7" />
      )}
      {Array.from({ length: 5 }).map((_, i) => (
        <g key={`cw${i}`}>
          <rect x={175+i*10} y={78} width={6} height={10} fill="#d8d4c8" opacity="0.5" />
          <rect x={175+i*10} y={152} width={6} height={10} fill="#d8d4c8" opacity="0.5" />
        </g>
      ))}
      <CarShape x={200+Math.sin(t)*0.5} y={160} w={20} h={12} color="#4a5568" />
      <CarShape x={200} y={178} w={20} h={12} color="#2a5a78" />
      <CarShape x={145} y={108} w={20} h={12} color="#7a3030" rot={90} />
      <CarShape x={115} y={108} w={20} h={12} color="#aaa" rot={90} />
      <CarShape x={(t*70)%440-20} y={130} w={22} h={12} color="#d8d4c8" rot={90} />
      <CarShape x={440-(t*60)%440} y={130} w={22} h={12} color="#6a7080" rot={-90} />
    </svg>
  )
}

export function WrongWayScene({ t: _ }: { t: number }) {
  return (
    <svg viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="400" height="225" fill="#0a0f18" />
      <polygon points="0,225 400,225 280,40 120,40" fill={ROAD} />
      <rect x="198" y="40" width="4" height="185" fill="#8a7a30" opacity="0.6" />
      <CarShape x={160} y={120} w={18} h={10} color="#7a7f88" />
      <CarShape x={155} y={170} w={22} h={12} color="#4a5260" />
      <CarShape x={240} y={180} w={22} h={12} color="#c93a2b" rot={180} alert />
    </svg>
  )
}

export function StalledScene({ t: _ }: { t: number }) {
  return (
    <svg viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="400" height="225" fill="#0a0f18" />
      <polygon points="0,225 400,225 280,50 120,50" fill={ROAD} />
      <polygon points="80,200 90,200 86,185 84,185" fill="#e09222" />
      <rect x="82" y="192" width="6" height="1.5" fill="#fff" opacity="0.7" />
      <CarShape x={105} y={175} w={26} h={14} color="#b8371e" alert />
      <polygon points="75,175 85,175 80,165" fill="none" stroke="#ff5a4b" strokeWidth="1.5" />
      <CarShape x={200} y={150} w={22} h={12} color="#c8ccd2" />
      <CarShape x={260} y={120} w={18} h={10} color="#2e4560" />
    </svg>
  )
}

export function RoundaboutScene({ t }: { t: number }) {
  const angle = t * 40
  return (
    <svg viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="400" height="225" fill="#0a0f18" />
      <circle cx="200" cy="112" r="95" fill={ROAD} />
      <circle cx="200" cy="112" r="55" fill="#14202a" stroke={LANE} strokeWidth="1" strokeDasharray="3 4" opacity="0.7" />
      <circle cx="200" cy="112" r="30" fill="#1a3328" />
      <rect x="0" y="95" width="105" height="34" fill={ROAD} />
      <rect x="295" y="95" width="105" height="34" fill={ROAD} />
      <rect x="183" y="0" width="34" height="20" fill={ROAD} />
      <rect x="183" y="205" width="34" height="20" fill={ROAD} />
      {([0, 90, 180, 270] as const).map((a, i) => {
        const rad = (angle + a) * Math.PI / 180
        return (
          <CarShape key={i}
            x={200 + Math.cos(rad) * 75} y={112 + Math.sin(rad) * 75}
            w={20} h={11}
            color={['#d5d8dd', '#4a5260', '#7a3030', '#2e4560'][i]}
            rot={(angle + a + 90) % 360}
          />
        )
      })}
    </svg>
  )
}

export function FloodScene({ t }: { t: number }) {
  return (
    <svg viewBox="0 0 400 225" preserveAspectRatio="xMidYMid slice"
      style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="400" height="225" fill="#0a0f18" />
      <polygon points="0,225 400,225 280,50 120,50" fill={ROAD} />
      <polygon points="0,225 400,225 340,140 60,140" fill="#1d4a6e" opacity="0.65" />
      {Array.from({ length: 5 }).map((_, i) => (
        <path key={i}
          d={`M ${30+i*70} ${160+i*8} q 30 ${-4+Math.sin(t+i)*2} 60 0`}
          stroke="#6da7c8" strokeWidth="1" fill="none" opacity="0.7" />
      ))}
      <CarShape x={180} y={190} w={24} h={12} color="#3a4a5a" alert />
      <polygon points="310,110 325,95 340,110 325,125" fill="#e09222" />
      <text x="325" y="114" fontFamily="monospace" fontSize="12" textAnchor="middle" fontWeight="700" fill="#14202a">!</text>
    </svg>
  )
}

export function CameraScene({ scene, t }: { scene: Scene; t: number }) {
  if (scene === 'highway')      return <HighwayScene t={t} />
  if (scene === 'intersection') return <IntersectionScene t={t} />
  if (scene === 'roundabout')   return <RoundaboutScene t={t} />
  if (scene === 'wrongway')     return <WrongWayScene t={t} />
  if (scene === 'stalled')      return <StalledScene t={t} />
  if (scene === 'flood')        return <FloodScene t={t} />
  return <HighwayScene t={t} />
}
