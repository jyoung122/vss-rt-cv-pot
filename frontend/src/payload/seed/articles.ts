// Minimal Payload v3 lexical richText body shape.
// Each article uses paragraph nodes only — editors can enrich via /admin.
function body(...paragraphs: string[]) {
  return {
    root: {
      type: 'root',
      format: '' as const,
      indent: 0,
      version: 1,
      children: paragraphs.map((text) => ({
        type: 'paragraph',
        format: '' as const,
        indent: 0,
        version: 1,
        children: [
          {
            type: 'text',
            format: 0,
            style: '',
            mode: 'normal' as const,
            detail: 0,
            text,
            version: 1,
          },
        ],
        textFormat: 0,
        textStyle: '',
        direction: 'ltr' as const,
      })),
      direction: 'ltr' as const,
    },
  }
}

export const articles = [
  // ── Getting Started ──────────────────────────────────────────────────────────

  {
    title: 'Welcome to AIMS',
    slug: 'welcome-to-aims',
    categorySlug: 'getting-started',
    order: 1,
    excerpt:
      'AIMS (AI Monitoring System) by Synch Solutions gives traffic operators real-time visibility into what is happening on the road — without watching every camera manually. Upload a video clip and AIMS detects vehicles, pedestrians, and bicycles, flags incidents automatically, and lets you review every event on an interactive timeline.',
    body: body(
      'AIMS (AI Monitoring System) by Synch Solutions gives traffic operators real-time visibility into what is happening on the road — without watching every camera manually. Upload a video clip and AIMS detects vehicles, pedestrians, and bicycles, flags incidents automatically, and lets you review every event on an interactive timeline.',
      'The system is designed for non-technical operators. You do not need to understand machine learning or computer vision to use it. If you can read a spreadsheet and watch a video, you can use AIMS.',
      'The main sections of the app are: Uploads (where you bring in video footage), Incidents (where you configure and review flagged events), and the upload detail page (where you scrub the timeline and inspect individual detections). This Knowledge Base covers each section in detail.',
      'If you are new, start with "Quick Start: Your First Upload" to get footage into the system, then come back here for deeper explanations of each feature.'
    ),
    _status: 'published',
  },

  {
    title: 'Quick Start: Your First Upload',
    slug: 'quick-start-your-first-upload',
    categorySlug: 'getting-started',
    order: 2,
    excerpt:
      'Getting footage into AIMS takes less than a minute. Navigate to the Uploads section, drag your video file onto the upload area (or click Browse to select it), optionally add a note about what the footage shows, and click Upload. AIMS accepts MP4 and MKV files.',
    body: body(
      'Getting footage into AIMS takes less than a minute. Navigate to the Uploads section, drag your video file onto the upload area (or click Browse to select it), optionally add a note about what the footage shows, and click Upload. AIMS accepts MP4 and MKV files.',
      'Once the upload completes, AIMS queues the video for processing. A progress indicator on the Uploads list shows you where the video is in the pipeline — Queued, Processing, or Done. Processing time depends on clip length; a 5-minute clip typically takes 1–2 minutes.',
      'After processing finishes, click the video row to open the detail page. You will see a colour-coded timeline scrubber at the top showing detection bands for every tracked object. Click any band to jump the video player to that moment.',
      'The AI prompt field (the text area below the upload form) is optional. You can describe the camera location, known hazards, or anything else that might help during a review. This text is stored with the upload and visible on the detail page.',
      'Supported formats: MP4 (.mp4) and Matroska (.mkv). Maximum file size depends on your deployment configuration — check with your system administrator if you receive an error on large files.'
    ),
    _status: 'published',
  },

  // ── Concepts ─────────────────────────────────────────────────────────────────

  {
    title: 'How AIMS Processes a Video',
    slug: 'how-aims-processes-a-video',
    categorySlug: 'concepts',
    order: 1,
    excerpt:
      'When you upload a video, AIMS runs it through a multi-stage computer vision pipeline. The system detects and tracks every moving object frame by frame, streams those raw detections into a database, and then applies a set of behavioral rules to identify incidents worth your attention.',
    body: body(
      'When you upload a video, AIMS runs it through a multi-stage computer vision pipeline. The system detects and tracks every moving object frame by frame, streams those raw detections into a database, and then applies a set of behavioral rules to identify incidents worth your attention.',
      'Detection: The video is decoded and fed into a deep learning model (RT-DETR / TrafficCamNet) that identifies objects in each frame — Cars, People, and Bicycles — along with a bounding box (the rectangle around each object) and a confidence score (how certain the model is).',
      'Tracking: Detected objects are linked across frames by a tracker. Each continuous object trajectory receives a unique Track ID, so the system can follow a car from the moment it enters the frame to the moment it leaves.',
      'Indexing: Track detections are written to the database in real time as the video is processed. This is what fills the timeline scrubber on the detail page.',
      'Incident analysis: Once all events are indexed, you can trigger an analysis pass (or it runs automatically). The rule pack examines every track\'s motion history — velocity, overlap with other tracks, stationarity — and flags incidents when the data matches a known pattern. See "Detection Rules: How They Work" for details on each rule.',
      'You do not need to trigger a re-analysis after adjusting threshold settings — just re-click the Analyze button on the detail page to apply the new values to already-processed footage.'
    ),
    _status: 'published',
  },

  {
    title: 'Detection Rules: How They Work',
    slug: 'detection-rules-how-they-work',
    categorySlug: 'concepts',
    order: 2,
    excerpt:
      'AIMS uses four built-in behavioral rules to detect incidents automatically. Each rule examines the motion history of detected tracks and fires when the data matches a specific pattern. Rules are not simple threshold triggers — they look at sequences of events over time.',
    body: body(
      'AIMS uses four built-in behavioral rules to detect incidents automatically. Each rule examines the motion history of detected tracks and fires when the data matches a specific pattern.',
      'Vehicle Collision (vehicle_collision) — Severity: High. Fires when two vehicle tracks show sustained bounding-box overlap followed by a simultaneous velocity collapse and an extended stationary period. Both vehicles must show a velocity drop above the configured threshold within the co-stop window of the overlap, then stay stationary together for the required duration. This rule targets rear-end and intersection collisions.',
      'Pedestrian Impact (ped_impact) — Severity: High. Fires when a car and a person track maintain sustained centroid proximity, and then the pedestrian stops moving or disappears from the scene within one second after the proximity window ends. The person track must drop below 5 pixels per second or terminate for the rule to trigger.',
      'Stationary Vehicle (stationary_vehicle) — Severity: Medium. Fires when a vehicle that was previously moving has remained stopped in-lane or on the shoulder for an extended period. To filter out parked cars, the track must have exceeded the prior-motion threshold at some earlier point in the clip before it qualifies.',
      'Mass Stop / Traffic Jam (mass_stop) — Severity: Medium. Fires when four or more distinct vehicle tracks each show a sudden velocity drop above the configured threshold within the same short time window. This captures sudden traffic arrests — a cascade of braking that can indicate a downstream collision or road blockage.',
      'Each rule has configurable thresholds — the numeric parameters that control how sensitive it is. You can adjust these on the Incidents page. Lower thresholds catch more events (potentially more false positives); higher thresholds are more selective. After adjusting, re-analyze your footage to see the effect.'
    ),
    _status: 'published',
  },

  {
    title: 'Glossary of AIMS Terms',
    slug: 'glossary-of-aims-terms',
    categorySlug: 'concepts',
    order: 3,
    excerpt:
      'A reference list of the terms used throughout the AIMS interface and this Knowledge Base. Bookmark this page if you are new to computer vision monitoring.',
    body: body(
      'Event: A single detection record — one object seen in one frame. An event records the object class (Car, Person, Bicycle), bounding box coordinates, confidence score, timestamp, and which Track it belongs to.',
      'Incident: A rule-detected behavioral pattern that spans multiple events over time — for example, a collision or a stationary vehicle. Incidents are created by the AIMS rule pack when the motion data matches a known hazard pattern. Each incident has a severity (High, Medium, or Low), a time range, and the Track IDs involved.',
      'Track: The continuous trajectory of a single object through the video. Every object the system detects is assigned a Track ID the first time it appears; subsequent detections of the same physical object in later frames are grouped under that ID. A track may span hundreds of frames.',
      'Rule: A named behavioral detector. AIMS ships with four rules: vehicle_collision, ped_impact, stationary_vehicle, and mass_stop. Each rule has configurable thresholds that control its sensitivity.',
      'Severity: A classification of how serious an incident is. AIMS uses three levels — High (collision-class events, immediate risk to life), Medium (stalled traffic, congestion risk), and Low (informational).',
      'Camera: In AIMS, a camera corresponds to a sensor ID in the detection pipeline. Each upload is associated with a camera/sensor source. Future versions will support multi-camera live feeds alongside uploaded clips.',
      'Threshold: A numeric parameter that controls how sensitive a detection rule is. For example, the minimum overlap area required before the vehicle_collision rule starts watching two tracks, or the minimum speed drop ratio that counts as a "velocity collapse". Thresholds are adjustable per-rule on the Incidents page.',
      'Confidence: The probability score the detection model assigns to each object sighting — a number between 0 and 1 (often shown as a percentage). Higher confidence means the model is more certain it correctly identified the object class. Low-confidence detections are not filtered out by default; the rule pack sees all of them.',
      'VLM Verdict: An optional secondary validation layer powered by a Vision-Language Model (such as Cosmos-Reason 2 or an OpenAI-compatible endpoint). After the rule pack flags an incident, the VLM examines a short video clip around the event and returns a written verdict — Confirmed, Rejected, or Pending — along with a reasoning summary. VLM validation must be enabled in the deployment configuration.'
    ),
    _status: 'published',
  },

  // ── Using AIMS ───────────────────────────────────────────────────────────────

  {
    title: 'Building a Custom Rule',
    slug: 'building-a-custom-rule',
    categorySlug: 'using-aims',
    order: 1,
    excerpt:
      'The AIMS rule builder lets you combine detection conditions to create custom incident triggers. In three steps — pick your object types, define the triggering condition, and set the severity — you can build a rule that fires on patterns specific to your camera locations or operational priorities.',
    body: body(
      'The AIMS rule builder lets you combine detection conditions to create custom incident triggers. Navigate to the Rules section and click "New Rule" to open the three-step builder.',
      'Step 1: Object filter. Select which object classes this rule should watch — Cars, People, Bicycles, or any combination. You can also restrict the rule to a specific detection zone if your camera has pre-defined regions.',
      'Step 2: Condition. Define what the selected objects must do to trigger the rule. Current condition types include: sustained proximity (two objects stay close for a minimum duration), velocity drop (an object\'s speed falls below a threshold), and stationary duration (an object stops moving for longer than a set period).',
      'Step 3: Severity and label. Give the rule a name that will appear in the Incidents list, and assign a severity level (High, Medium, or Low). High-severity rules surface in the dashboard KPIs and trigger VLM validation first when the queue is under load.',
      'Note: in v1, the match preview shown in the rule builder uses sample data; live preview against your camera footage is on the roadmap.',
      'After saving, the rule is active immediately. Re-analyze any existing upload to apply your new rule to already-processed footage — the analysis endpoint is idempotent and will not create duplicate incidents for rules that already fired.'
    ),
    _status: 'published',
  },

  {
    title: 'Incident Catalog and Thresholds',
    slug: 'incident-catalog-and-thresholds',
    categorySlug: 'using-aims',
    order: 2,
    excerpt:
      'The Incidents page shows you all four built-in detection rules and lets you fine-tune the numeric thresholds that control each rule\'s sensitivity. Select a rule in the left panel to see its description, trigger logic, and editable threshold fields. Changes take effect on the next analyze run.',
    body: body(
      'The Incidents page is split into two panels. The left panel lists all four active detection rules with their current severity and whether thresholds have been customized from their defaults. Click any rule to open its configuration on the right.',
      'The right panel shows the rule\'s description, trigger logic (in plain language), and a list of editable threshold fields. Each field shows its label, units, and acceptable range. Change any value and click "Save changes" — the system stores your new thresholds immediately.',
      'To revert all fields for a rule to their factory defaults, click "Reset to defaults". The reset is immediate and cannot be undone from the UI (you can re-apply your values manually).',
      'Threshold changes apply on the next analyze run, not retroactively to already-stored incidents. To see the effect of a threshold change on existing footage, open the upload\'s detail page and click Analyze again.',
      'The "custom" badge next to a rule name means that rule has at least one threshold that differs from the default. This badge is informational only — customized rules are not treated differently by the system.',
      'API access: for scripted deployments, thresholds can be read and updated via the REST API. GET /api/incidents/catalog returns the full schema and current values for all rules. PUT /api/rules/{rule_id}/thresholds accepts a JSON body with the new values. POST /api/rules/{rule_id}/thresholds/reset restores defaults.'
    ),
    _status: 'published',
  },

  {
    title: 'Reading the Incident Timeline',
    slug: 'reading-the-incident-timeline',
    categorySlug: 'using-aims',
    order: 3,
    excerpt:
      'The detail page for each upload gives you a frame-by-frame view of every detection and incident in the clip. The timeline scrubber at the top, the Scenarios tab, and the Events tab work together to help you understand what happened and when.',
    body: body(
      'Open any upload from the Uploads list to reach the detail page. The page has three main areas: the video player, the timeline scrubber below it, and the tabbed panel on the right.',
      'Timeline scrubber: The scrubber shows colour-coded bands that represent object tracks across the full duration of the clip. Each band corresponds to one Track — the horizontal extent of the band is the time range the object was visible, and the colour indicates its class (Cars are one colour, People another, Bicycles a third). Click any point on the scrubber to seek the video to that moment.',
      'Incident bands appear as a separate layer above the track bands, coloured by severity — red for High, amber for Medium. Hovering over an incident band shows a tooltip with the rule name and confidence. Clicking seeks to the start of the incident.',
      'Scenarios tab: This tab lists every incident the rule pack detected in the clip, grouped by rule. Each card shows the rule name, severity badge, confidence score, time range, and the Track IDs involved. Expand a card to read the VLM verdict and reasoning (if VLM validation is enabled). The "Jump to" button seeks the video and highlights the relevant tracks.',
      'Events tab: This tab shows every individual detection event grouped by Track ID. For each track you can see the object class, maximum confidence seen across all frames, total duration the track was active, and the bounding box coordinates of the first detection. Click a track row to seek the video to the track\'s first appearance.',
      'Use the Scenarios tab for incident review and the Events tab when you need to verify a specific detection or investigate why a rule did or did not fire on a particular track.'
    ),
    _status: 'published',
  },
]
