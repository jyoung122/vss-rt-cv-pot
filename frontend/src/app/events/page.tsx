import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata = { title: 'Events — SSI AIMS' }

export default function EventsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Events</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Live and historical detection events. Wiring to the WS bridge follows
        the dashboard rebuild.
      </CardContent>
    </Card>
  )
}
