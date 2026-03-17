import React, { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Shield, Lock, Key, AlertTriangle } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { authApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

export function SecurityTab() {
  const { success, error } = useNotifications()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Change password mutation
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
      error('Failed to change password', err.response?.data?.message || 'Please try again.')
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
      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Change Password
          </CardTitle>
          <CardDescription>
            Update your account password
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              placeholder="Enter your current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          
          <div>
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              type="password"
              placeholder="Enter a new password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          
          <div>
            <Label htmlFor="confirm-password">Confirm New Password</Label>
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
              {changePasswordMutation.isPending ? 'Updating...' : 'Update Password'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Session Management */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Active Sessions
          </CardTitle>
          <CardDescription>
            Manage your active login sessions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <div className="font-medium">Current Session</div>
                <div className="text-sm text-muted-foreground">
                  This browser • Active now
                </div>
              </div>
              <div className="text-green-600 text-xs">Current</div>
            </div>
          </div>
          
          <div className="mt-4 pt-4 border-t">
            <Button variant="destructive" size="sm">
              <AlertTriangle className="h-3 w-3 mr-1" />
              Revoke All Other Sessions
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              This will sign you out of all other devices
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Account Security Info */}
      <Card>
        <CardHeader>
          <CardTitle>Account Security</CardTitle>
          <CardDescription>
            Your account security status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Email Verification</div>
                <div className="text-sm text-muted-foreground">
                  Verify your email for better security
                </div>
              </div>
              <Button variant="outline" size="sm">
                Send Verification
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Password Strength</div>
                <div className="text-sm text-muted-foreground">
                  Last changed recently
                </div>
              </div>
              <div className="text-green-600 text-sm">Good</div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}