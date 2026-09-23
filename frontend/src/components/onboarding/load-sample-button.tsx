import { Button } from '@/components/ui/button'

interface LoadSampleButtonProps {
  pending: boolean
  disabled?: boolean
  onClick: () => void
}

/**
 * The secondary "Load the Petstore sample" action empty states offer.
 *
 * One component so the four empty states that offer it show the same
 * button: it was copied per page with `text-cyan-400` only, which is
 * the dark-mode cyan and reads washed out on the light theme (the brand
 * light cyan is cyan-600).
 */
export function LoadSampleButton({ pending, disabled, onClick }: LoadSampleButtonProps) {
  return (
    <Button
      variant="outline"
      className="border-cyan-600/30 text-cyan-600 hover:bg-cyan-500/10 hover:text-cyan-700 dark:border-cyan-500/30 dark:text-cyan-400 dark:hover:text-cyan-300"
      onClick={onClick}
      disabled={pending || disabled}
    >
      {pending ? 'Loading…' : 'Load the Petstore sample'}
    </Button>
  )
}
