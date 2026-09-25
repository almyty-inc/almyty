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
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import { formatFileSize } from './constants'
import type { AgentFile } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'

interface FilesTabProps {
  agentId: string
  files: AgentFile[]
  /**
   * The files query lives on the agent detail page, so the failure has to be
   * handed down: without it a fetch that failed rendered the same "no files
   * uploaded yet" line as an agent that genuinely has none, and the user
   * re-uploaded files that were already there.
   */
  error?: unknown
  onRetry?: () => void
}

export function FilesTab({ agentId, files, error, onRetry }: FilesTabProps) {
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
      errorNotif('Upload Failed', getApiErrorMessage(err, 'Failed to upload file'))
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
              Upload file
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <QueryError error={error} onRetry={onRetry} title="Couldn't load files" />
        ) : files.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No files uploaded yet"
            description="Upload a file and this agent can read it during a run — a spec, a price list, a sample payload."
            action={
              <Button onClick={() => fileInputRef.current?.click()} disabled={uploadFileMutation.isPending}>
                <Upload className="h-4 w-4 mr-2" />
                Upload file
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Uploaded by</TableHead>
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
                        aria-label={`Download ${file.name}`}
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
