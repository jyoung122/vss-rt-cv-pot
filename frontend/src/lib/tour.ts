import type { DriveStep } from 'driver.js'

export type TourPage = 'dashboard' | 'uploads' | 'detail' | 'incidents'

interface AimsTourStep extends DriveStep {
  page: TourPage
}

const STEPS: AimsTourStep[] = [
  // Dashboard
  {
    page: 'dashboard',
    element: '[data-tour="kpi-grid"]',
    popover: {
      title: 'Analytics overview',
      description:
        'KPIs pulled from real upload data — events indexed, analyzed footage, and incident counts update as new videos are processed.',
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
    element: '[data-tour="recent-uploads"]',
    popover: {
      title: 'Recent uploads',
      description: 'Jump straight to any recently processed video. Click a row to open the full detail view.',
      side: 'left',
    },
  },
  // Uploads list
  {
    page: 'uploads',
    element: '[data-tour="uploads-list"]',
    popover: {
      title: 'Upload queue',
      description: 'Every ingested video with its processing status. Click a row to open the timeline and incident analysis.',
    },
  },
  // Upload detail
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
  // Incidents catalog
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

const PAGE_PATHS: Record<TourPage, string> = {
  dashboard: '/',
  uploads: '/uploads',
  detail: '/uploads',
  incidents: '/incidents',
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
          navigate(PAGE_PATHS[STEPS[nextCrossPageIndex].page])
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
