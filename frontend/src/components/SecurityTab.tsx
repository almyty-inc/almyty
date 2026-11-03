import React, { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Shield, Lock } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { authApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'

export function SecurityTab() {
  const { success, error } = useNotifications()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // The same query the Profile page reads. `hasPassword` is false for an
  // account made by single sign-on or SCIM; `emailVerified` is true once
  // the address is confirmed.
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['user-profile'],
    queryFn: () => authApi.getProfile(),
  })
  const known = profile as { hasPassword?: boolean; emailVerified?: boolean; email?: string } | undefined
  const noPassword = known?.hasPassword === false
  const emailVerified = known?.emailVerified === true
  const email = known?.email

  // Setting a first password goes through the same emailed link as a
  // forgotten one; confirming it marks the account as having a password.
  const setPasswordLink = useMutation({
    mutationFn: () => authApi.forgotPassword(email as string),
  })

  // The button under "Email verification" had no handler at all, while
  // the identical action in the top-of-page banner worked. Someone who
  // never dismissed the banner would never find the working one.
  const resendVerification = useMutation({
    mutationFn: () => authApi.resendVerification(),
  })

  const changePasswordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      authApi.changePassword(data),
    onSuccess: () => {
      success('Password changed', 'Your password has been updated successfully.')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    },
    onError: (err: any) => {
      error('Failed to change password', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const handleChangePassword = () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      error('All fields required', 'Please fill in all password fields.')
      return
    }

    if (newPassword !== confirmPassword) {
      error('Passwords do not match', 'Please ensure the new passwords match.')
      return
    }

    if (newPassword.length < 8) {
      error('Password too short', 'Password must be at least 8 characters long.')
      return
    }

    changePasswordMutation.mutate({
      currentPassword,
      newPassword,
    })
  }

  return (
    <div className="space-y-6">
      {/* An account made by single sign-on or SCIM has no password, so a
          form asking for the current one is a dead end. It gets the one way
          to set a password the product has: the reset link, by email. */}
      {noPassword ? (
        <Card data-testid="no-password">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Password
            </CardTitle>
            <CardDescription>
              None set. You sign in through your organization&apos;s single sign-on.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              To sign in with a password as well, we can email you a link to set one.
            </p>
            <Button
              variant="outline"
              data-testid="set-password-link"
              disabled={!email || setPasswordLink.isPending || setPasswordLink.isSuccess}
              onClick={() => setPasswordLink.mutate()}
            >
              {setPasswordLink.isPending ? 'Sending...' : 'Email me a link to set a password'}
            </Button>
            {setPasswordLink.isSuccess && (
              <p data-testid="set-password-sent" className="text-xs text-emerald-600 dark:text-emerald-400">
                Link sent to {email}. It works for one hour.
              </p>
            )}
            {setPasswordLink.isError && (
              <p data-testid="set-password-error" className="text-xs text-red-600 dark:text-red-400">
                {getApiErrorMessage(setPasswordLink.error, 'Could not send the link')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : profileLoading ? null : (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Change password
          </CardTitle>
          <CardDescription>
            Update your account password
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              placeholder="Enter your current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          
          <div>
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              placeholder="Enter a new password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          
          <div>
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              placeholder="Confirm your new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>

          <div className="flex justify-end">
            <Button 
              onClick={handleChangePassword}
              disabled={changePasswordMutation.isPending}
            >
              {changePasswordMutation.isPending ? 'Updating...' : 'Update password'}
            </Button>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Session Management */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Active sessions
          </CardTitle>
          <CardDescription>
            Manage your active login sessions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <div className="font-medium">Current session</div>
                <div className="text-sm text-muted-foreground">
                  This browser • Active now
                </div>
              </div>
              <div className="text-green-600 text-xs">Current</div>
            </div>
          </div>
          
          <div className="mt-4 pt-4 border-t">
            {/* "Revoke All Other Sessions" was here with no handler, under
                the promise "This will sign you out of all other devices".
                It signed nobody out of anything, and there is no endpoint
                behind it -- /auth has logout and nothing that revokes
                other sessions. A security control that reports nothing and
                does nothing is worse than an absent one, because someone
                who suspects a compromise believes they have acted. */}
            <p className="text-xs text-muted-foreground">
              Signing out elsewhere is not supported yet. To cut off another device, change your password: existing
              sessions are issued against your current credentials.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Account Security Info */}
      <Card>
        <CardHeader>
          <CardTitle>Account security</CardTitle>
          <CardDescription>
            Your account security status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Email verification</div>
                <div className="text-sm text-muted-foreground">
                  {emailVerified ? 'Your email address is confirmed.' : 'Verify your email for better security'}
                </div>
              </div>
              {/* Offering to send a verification email for an address that
                  is already verified invites a pointless click and reads as
                  if something were still missing. */}
              {emailVerified ? (
                <Badge variant="success" data-testid="email-verified">Verified</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="send-verification"
                  disabled={resendVerification.isPending}
                  onClick={() => resendVerification.mutate()}
                >
                  {resendVerification.isPending ? 'Sending...' : 'Send verification'}
                </Button>
              )}
            </div>

            {/* Said out loud: a button that does its work silently is only
                marginally better than one that does nothing, because the
                person cannot tell the difference. */}
            {resendVerification.isSuccess && (
              <p data-testid="verification-sent" className="text-xs text-emerald-600 dark:text-emerald-400">
                Verification email sent. Check your inbox.
              </p>
            )}
            {resendVerification.isError && (
              <p data-testid="verification-error" className="text-xs text-red-600 dark:text-red-400">
                {getApiErrorMessage(resendVerification.error, 'Could not send the verification email')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
