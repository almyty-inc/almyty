/* Standard shadcn Skeleton primitive.
 *
 * Used as a loading placeholder shape across list pages and
 * detail panels. Prefer skeletons over spinners — they reduce
 * layout shift when real content arrives and give the user a
 * sense of the page structure before data loads.
 */
import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
}

export { Skeleton }
