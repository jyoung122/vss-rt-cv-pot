import type { DriveStep } from 'driver.js'

export type TourPage = 'dashboard' | 'uploads' | 'detail' | 'incidents'

interface AimsTourStep extends DriveStep {
  page: TourPage
}

const STEPS: AimsTourStep[] = [
  // ── Sidebar orientation (dashboard page, sidebar always visible) ──────────
  {
    page: 'dashboard',
    element: '[data-tour="sidebar"]',
    popover: {
      title: 'Navigation sidebar',
      description:
        'This sidebar is your primary navigation. It collapses to icon-only mode to give more space to the content — hover the edge or click the toggle to expand it.',
      side: 'right',
    },
  },
  {
    page: 'dashboard',
    element: '[data-tour="sidebar-nav"]',
    popover: {
      title: 'Four main sections',
      description:
        'Dashboard · Uploads · Incidents · Events. We\'ll walk through each one. The active page is always highlighted in the sidebar.',
      side: 'right',
    },
  },
  // ── Dashboard content ─────────────────────────────────────────────────────
  {
    page: 'dashboard',
    element: '[data-tour="kpi-grid"]',
    popover: {
      title: 'Analytics overview',
      description:
        'KPIs pulled from real upload data — events indexed, analyzed footage, and incident counts update as new videos are processed.',
      side: 'bottom',
    },
  },
  {
    page: 'dashboard',
    element: '[data-tour="kpi-vlm"]',
    popover: {
      title: 'VLM-confirmed incidents',
      description:
        'Cosmos-Reason2-2B validates every rule-detected incident and provides written reasoning. This tile counts the ones the model confirmed.',
      side: 'bottom',
    },
  },
  {
    page: 'dashboard',
    element: '[data-tour="trend-map"]',
    popover: {
      title: 'Detection trends & hotspots',
      description:
        'Daily detection volume by object type on the left; a density heatmap of high-activity intersections on the right.',
      side: 'top',
    },
  },
  {
    page: 'dashboard',
    element: '[data-tour="breakdown"]',
    popover: {
      title: 'Event breakdowns',
      description:
        'Three slices of the same detection data: by object class, by corridor, and by severity.',
      side: 'top',
    },
  },
  {
    page: 'dashboard',
    element: '[data-tour="heatmap-rules"]',
    popover: {
      title: 'Activity patterns & detection rules',
      description:
        'The heatmap shows when events happen across the week. The rules panel lists active detection rules, their trigger volumes, and false-positive rates.',
      side: 'top',
    },
  },
  {
    page: 'dashboard',
    element: '[data-tour="recent-uploads"]',
    popover: {
      title: 'Recent uploads',
      description:
        'Jump straight to any recently processed video. Click a row to open the full detail view.',
      side: 'top',
    },
  },
  // ── Transition: sidebar → Uploads ─────────────────────────────────────────
  {
    page: 'dashboard',
    element: '[data-tour="nav-uploads"]',
    popover: {
      title: 'Uploads section',
      description:
        'Click Uploads in the sidebar to manage ingested videos and kick off analysis. Next, we\'ll take you there.',
      side: 'right',
    },
  },
  // ── Uploads list ──────────────────────────────────────────────────────────
  {
    page: 'uploads',
    element: '[data-tour="nav-uploads"]',
    popover: {
      title: 'You\'re in Uploads',
      description: 'Every video you ingest appears here. The sidebar always shows which section is active.',
      side: 'right',
    },
  },
  {
    page: 'uploads',
    element: '[data-tour="uploads-list"]',
    popover: {
      title: 'Upload queue',
      description: 'Every ingested video with its processing status. Click a row to open the timeline scrubber and incident analysis.',
      side: 'top',
    },
  },
  // ── Upload detail ─────────────────────────────────────────────────────────
  {
    page: 'detail',
    element: '[data-tour="scrubber"]',
    popover: {
      title: 'Timeline scrubber',
      description:
        'Colour-coded bands show object tracks and incident severity across the clip. Click any band to seek the video to that moment.',
      side: 'top',
    },
  },
  {
    page: 'detail',
    element: '[data-tour="tab-events"]',
    popover: {
      title: 'Events tab',
      description: 'Every detection event: object class, bounding box, confidence, and timestamp — grouped by track.',
      side: 'left',
    },
  },
  {
    page: 'detail',
    element: '[data-tour="tab-scenarios"]',
    popover: {
      title: 'Scenarios tab',
      description:
        'Rule-detected incidents with VLM verdicts. Filter by Confirmed / Rejected / Pending. Expand any card for the model\'s reasoning and confidence.',
      side: 'left',
    },
  },
  // ── Transition: sidebar → Incidents ───────────────────────────────────────
  {
    page: 'detail',
    element: '[data-tour="nav-incidents"]',
    popover: {
      title: 'Incidents section',
      description:
        'The Incidents catalog gives you a cross-upload view of every flagged event. Next stop.',
      side: 'right',
    },
  },
  // ── Incidents catalog ─────────────────────────────────────────────────────
  {
    page: 'incidents',
    element: '[data-tour="nav-incidents"]',
    popover: {
      title: 'You\'re in Incidents',
      description: 'Use the sidebar to jump between sections at any time.',
      side: 'right',
    },
  },
  {
    page: 'incidents',
    element: '[data-tour="incidents-catalog"]',
    popover: {
      title: 'Incidents catalog',
      description: 'Cross-upload view of every flagged incident, organised by rule. Select a rule to see its thresholds and all matched events.',
      side: 'right',
    },
  },
]

const STORAGE_KEY = 'aims:tour:v1'

const STATIC_PAGE_PATHS: Record<Exclude<TourPage, 'detail'>, string> = {
  dashboard: '/',
  uploads: '/uploads',
  incidents: '/incidents',
}

async function resolvePagePath(page: TourPage): Promise<string> {
  if (page !== 'detail') return STATIC_PAGE_PATHS[page]
  try {
    const res = await fetch('/api/uploads', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      const first = data.uploads?.[0]
      if (first?.video_id) return `/uploads/${first.video_id}`
    }
  } catch {
    // fall through to uploads list
  }
  return '/uploads'
}

function readProgress(): number | 'done' | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    if (raw === 'done') return 'done'
    const parsed = JSON.parse(raw)
    return typeof parsed?.step === 'number' ? parsed.step : null
  } catch {
    return null
  }
}

function writeProgress(step: number) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ step }))
}

function clearProgress() {
  localStorage.removeItem(STORAGE_KEY)
}

export function hasSeenTour(): boolean {
  return readProgress() === 'done'
}

export function markTourDone() {
  localStorage.setItem(STORAGE_KEY, 'done')
}

async function launchDriver(startIndex: number, navigate: (path: string) => void) {
  // Lazy-load driver.js so it doesn't bloat the initial bundle
  const { driver } = await import('driver.js')

  const currentPage = STEPS[startIndex].page
  const pageSteps = STEPS.filter((s) => s.page === currentPage)
  const nextCrossPageIndex = STEPS.findIndex((s, i) => i > startIndex + (pageSteps.length - 1) && s.page !== currentPage)

  const d = driver({
    showProgress: true,
    animate: true,
    popoverClass: 'aims-tour-popover',
    overlayOpacity: 0.45,
    steps: pageSteps.map(({ element, popover }) => ({ element, popover })),
    onNextClick: (_el, _step, opts) => {
      const isLastOnPage = opts.state.activeIndex === pageSteps.length - 1
      if (isLastOnPage) {
        if (nextCrossPageIndex !== -1) {
          writeProgress(nextCrossPageIndex)
          d.destroy()
          void resolvePagePath(STEPS[nextCrossPageIndex].page).then(navigate)
        } else {
          markTourDone()
          d.destroy()
        }
      } else {
        d.moveNext()
      }
    },
    onDestroyStarted: () => {
      // User closed the tour manually
      clearProgress()
      d.destroy()
    },
  })

  d.drive()
}

export function startTour(navigate: (path: string) => void) {
  writeProgress(0)
  launchDriver(0, navigate)
}

export function resumeTourIfNeeded(page: TourPage, navigate: (path: string) => void) {
  const progress = readProgress()
  if (progress === null || progress === 'done') return
  const expectedPage = STEPS[progress]?.page
  if (expectedPage === page) {
    launchDriver(progress, navigate)
  }
}
