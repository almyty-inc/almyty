import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'

// 404 for unknown *authenticated* routes. Rendered inside the
// DashboardLayout so an authed user who typo'd a URL or followed a
// stale link gets a real "not found" instead of the dashboard
// silently loading (which read as "my page vanished"). Unauthenticated
// visitors never reach this — the layout redirects them to login first.
export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="We couldn't find the page you were looking for. It may have moved, or the link may be out of date."
        action={
          <Button asChild>
            <Link to="/dashboard">Back to dashboard</Link>
          </Button>
        }
      />
    </div>
  )
}
