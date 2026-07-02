import { useEffect } from 'react'
import { useParams } from 'react-router-dom'

import { LoadingSpinner } from '@/components/ui/loading-spinner'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

/**
 * Landing route for referral share links (`/r/<code>`).
 *
 * The attribution cookie must live on the API origin (that is where the
 * register call is sent, with credentials), so we hand the browser off to
 * the backend attribute endpoint. It sets the httpOnly cookie and 302s
 * back to the register page.
 */
export function ReferralRedirectPage() {
  const { code } = useParams<{ code: string }>()

  useEffect(() => {
    const target = code
      ? `${API_BASE_URL}/referrals/attribute/${encodeURIComponent(code)}`
      : '/auth/register'
    window.location.replace(target)
  }, [code])

  return (
    <div className="min-h-screen flex items-center justify-center">
      <LoadingSpinner />
    </div>
  )
}
