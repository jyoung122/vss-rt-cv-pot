import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata = { title: 'Uploads — SSI AIMS' }

export default function UploadsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Uploads</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Upload history will live here. Coming next commit.
      </CardContent>
    </Card>
  )
}
