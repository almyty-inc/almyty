// How a new capture differs from the published image: the share of pixels
// that changed and the box around them, and a picture of where (changed
// pixels red over a faded copy of the new one). Decoding and comparing run
// in the browser the walks already use, so nothing else is installed.
import { readFileSync, writeFileSync } from 'node:fs'
import type { Browser } from '@playwright/test'

export interface Difference {
  same: boolean
  /** Sizes differ: nothing else is compared. */
  sizes?: [string, string]
  /** Share of pixels that differ by more than the tolerance, 0 to 1. */
  changed: number
  box?: { x: number; y: number; width: number; height: number }
}

const dataUrl = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`

export async function compare(browser: Browser, published: string, captured: string, diffFile?: string, tolerance = 24): Promise<Difference> {
  const page = await browser.newPage()
  try {
    const result = await page.evaluate(async ([a, b, tol, wantDiff]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src })
      const [ia, ib] = await Promise.all([load(a as string), load(b as string)])
      if (ia.width !== ib.width || ia.height !== ib.height) return { sizes: [`${ia.width}x${ia.height}`, `${ib.width}x${ib.height}`], changed: 1 }
      const pixels = (img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d')!; x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height) }
      const pa = pixels(ia), pb = pixels(ib)
      const out = new ImageData(ia.width, ia.height)
      let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
      for (let i = 0; i < pa.data.length; i += 4) {
        const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]))
        if (d > (tol as number)) {
          n++
          const p = i / 4, x = p % ia.width, y = Math.floor(p / ia.width)
          if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y
          out.data.set([255, 0, 0, 255], i)
        } else {
          const g = 255 - (255 - (pb.data[i] + pb.data[i + 1] + pb.data[i + 2]) / 3) * 0.25
          out.data.set([g, g, g, 255], i)
        }
      }
      let diff: string | undefined
      if (wantDiff && n) { const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height; c.getContext('2d')!.putImageData(out, 0, 0); diff = c.toDataURL('image/png') }
      return { changed: n / (ia.width * ia.height), box: n ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : undefined, diff }
    }, [dataUrl(published), dataUrl(captured), tolerance, Boolean(diffFile)] as const)
    if (diffFile && 'diff' in result && result.diff) writeFileSync(diffFile, Buffer.from(result.diff.split(',')[1], 'base64'))
    return { same: result.changed === 0, changed: result.changed, ...('sizes' in result ? { sizes: result.sizes as [string, string] } : {}), ...('box' in result && result.box ? { box: result.box } : {}) }
  } finally { await page.close() }
}
