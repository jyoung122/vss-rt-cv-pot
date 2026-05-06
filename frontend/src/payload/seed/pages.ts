export const pages = [
  {
    title: 'Home',
    slug: 'home',
    _status: 'published',
    blocks: [
      {
        blockType: 'hero',
        eyebrow: 'AIMS by Synch Solutions',
        headline: 'Roadway intelligence at the speed of incident.',
        subhead:
          'Upload camera footage, detect collisions, pedestrian impacts, and traffic anomalies automatically — then review every event on an interactive timeline.',
        cta: {
          label: 'Open Knowledge Base',
          href: '/docs',
        },
        align: 'center',
      },
      {
        blockType: 'featureGrid',
        headline: 'Everything you need to monitor roadway safety',
        intro: 'AIMS covers the full operator workflow from footage ingestion through incident review.',
        columns: '4',
        features: [
          {
            icon: 'Camera',
            title: 'Uploads',
            description:
              'Drag-and-drop MP4 or MKV footage and let AIMS run detection automatically. Results are ready in minutes.',
            href: '/uploads',
          },
          {
            icon: 'Activity',
            title: 'Live Ops',
            description:
              'Monitor live detection events as they stream from the perception pipeline — no manual review needed.',
            href: '/live',
          },
          {
            icon: 'AlertTriangle',
            title: 'Incidents',
            description:
              'Review rule-detected incidents with severity ratings, confidence scores, and optional VLM verdicts.',
            href: '/incidents',
          },
          {
            icon: 'Settings',
            title: 'Rules',
            description:
              'Fine-tune detection thresholds or build custom behavioral rules to match your operational priorities.',
            href: '/rules',
          },
        ],
      },
      {
        blockType: 'cta',
        headline: 'Ready to dig in?',
        subhead:
          'Browse the Knowledge Base for step-by-step guides, concept explanations, and a full glossary of AIMS terms.',
        primaryCta: {
          label: 'Read the docs',
          href: '/docs',
        },
        tone: 'accent',
      },
    ],
  },
]
