/**
 * The app icon a desktop build wears, as the branding page prepares it:
 * a PNG, JPG or WebP chosen here becomes one square PNG before it is
 * uploaded, because the desktop packager takes a PNG and nothing else.
 * The image is fitted inside the square, never cropped.
 */

/** What can be chosen: the image types the files module takes that a browser can draw. */
export const APP_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

/** The largest image that can be chosen; the server keeps the same ceiling on what it builds with. */
export const APP_ICON_MAX_BYTES = 4 * 1024 * 1024

/** The desktop packager wants at least this many pixels on a side (macOS asks for 512). */
export const APP_ICON_SIDE = 512

export class AppIconError extends Error {}

/** Why a chosen file cannot be the icon, before anything is read; null when it can. */
export function appIconProblem(file: Pick<File, 'type' | 'size'>): string | null {
  if (!(APP_ICON_TYPES as readonly string[]).includes(file.type)) return 'Use a PNG, JPG or WebP image.'
  if (file.size > APP_ICON_MAX_BYTES) return 'Use an image under 4 MB.'
  return null
}

/** Where the image sits inside the square: fitted, centered. */
export function fitInSquare(width: number, height: number, side = APP_ICON_SIDE): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(side / width, side / height)
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  return { x: Math.round((side - w) / 2), y: Math.round((side - h) / 2), width: w, height: h }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new AppIconError('That image could not be read.'))
    img.src = url
  })
}

/** The chosen image as a square PNG of APP_ICON_SIDE pixels. */
export async function toSquarePng(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const { naturalWidth: width, naturalHeight: height } = img
    if (Math.min(width, height) < APP_ICON_SIDE) {
      throw new AppIconError(`Use an image at least ${APP_ICON_SIDE} pixels wide and tall.`)
    }
    const canvas = document.createElement('canvas')
    canvas.width = APP_ICON_SIDE
    canvas.height = APP_ICON_SIDE
    const context = canvas.getContext('2d')
    if (!context) throw new AppIconError('This browser cannot prepare the icon.')
    const box = fitInSquare(width, height)
    context.drawImage(img, box.x, box.y, box.width, box.height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new AppIconError('This browser cannot prepare the icon.'))), 'image/png'),
    )
  } finally {
    URL.revokeObjectURL(url)
  }
}
