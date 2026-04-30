import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata = { title: 'Settings — SSI AIMS' }

export default function SettingsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Configuration and preferences. Placeholder for v1.
      </CardContent>
    </Card>
  )
}
