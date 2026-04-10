/**
 * Files tab for the agent detail page. Lists uploaded files
 * with download support, and provides a file upload button.
 */
import React, { useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  FileText,
  Upload,
  Download,
  Loader2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { filesApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import { formatFileSize } from './constants'
import type { AgentFile } from '@/types'

interface FilesTabProps {
  agentId: string
  files: AgentFile[]
}

export function FilesTab({ agentId, files }: FilesTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      return filesApi.upload(file, agentId)
    },
    onSuccess: () => {
      success('File Uploaded', 'File has been uploaded.')
      queryClient.invalidateQueries({ queryKey: ['agent-files', agentId] })
    },
    onError: (err: any) => {
      errorNotif('Upload Failed', err?.response?.data?.message || err?.message || 'Failed to upload file')
    },
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Files</CardTitle>
            <CardDescription className="text-xs mt-1">
              Files uploaded for this agent
            </CardDescription>
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) {
                  uploadFileMutation.mutate(file)
                  e.target.value = ''
                }
              }}
            />
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadFileMutation.isPending}>
              {uploadFileMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              Upload File
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No files uploaded yet. Upload files to make them available to this agent.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Uploaded By</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((file) => (
                  <TableRow key={file.id}>
                    <TableCell className="text-sm font-medium">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        {file.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{file.mimeType}</TableCell>
                    <TableCell className="text-sm">{formatFileSize(file.size)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {file.uploadedBy?.slice(0, 8) || '--'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(file.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={async () => {
                          try {
                            const response = await filesApi.download(file.id)
                            const blob = new Blob([response.data])
                            const url = URL.createObjectURL(blob)
                            const a = document.createElement('a')
                            a.href = url
                            a.download = file.name
                            a.click()
                            URL.revokeObjectURL(url)
                          } catch (err: any) {
                            errorNotif('Download Failed', err?.message || 'Failed to download file')
                          }
                        }}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
