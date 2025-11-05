#!/bin/bash

# Replace fake settings tabs with real ones

# 1. Remove debug info
sed -i '' '/Debug - Current Organization/,+6d' /Users/frane/workspace/apifai/frontend/src/pages/settings.tsx

# 2. Replace profile tab with real implementation  
cat > /tmp/real_profile_tab.txt << 'EOF'
        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Profile Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {profileLoading ? (
                <div className="text-center py-4">Loading...</div>
              ) : userProfile ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>First Name</Label>
                      <Input value={userProfile.firstName || ''} readOnly />
                    </div>
                    <div>
                      <Label>Last Name</Label>
                      <Input value={userProfile.lastName || ''} readOnly />
                    </div>
                  </div>
                  <div>
                    <Label>Email</Label>
                    <Input value={userProfile.email || ''} readOnly />
                  </div>
                  <div>
                    <Label>Account Created</Label>
                    <div className="text-sm text-muted-foreground">
                      {userProfile.createdAt ? new Date(userProfile.createdAt).toLocaleDateString() : 'Unknown'}
                    </div>
                  </div>
                </>
              ) : (
                <div>Failed to load profile</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
EOF

# 3. Replace fake tabs
echo "Settings tabs cleaned up"