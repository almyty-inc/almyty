import { cn } from '@/lib/utils'

/**
 * The almyty mark: the hollow lightning bolt on its own, as docs/brand/logo.md
 * specifies for app chrome. The dark rounded tile (`almyty-icon-48.svg`) is the
 * favicon badge and does not belong next to the wordmark.
 *
 * width/height attributes give it an intrinsic size that holds even with no
 * CSS applied (e.g. rrweb session replays), so it never balloons.
 */
export function AlmytyMark({ className, label }: { className?: string; label?: string }) {
  return (
    <img
      src="/almyty-mark.svg"
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      width={26}
      height={30}
      className={cn('block h-8 w-auto shrink-0', className)}
    />
  )
}
