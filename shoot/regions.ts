// What differs between a before and an after screenshot, as boxes on the after picture.
import type { Browser } from 'playwright-core'
import type { Region } from '../review/types'
import { existsSync, readFileSync } from 'node:fs'

export interface Pixels { width: number, height: number, data: Uint8ClampedArray }

// Self-contained, the shoot's browser running it from its source. 8px cells with two pixels differing make boxes, a growth's push-down is matched against the before picture shifted, and touching boxes merge down to a dozen at most.
export function regionsOf(before: Pixels, after: Pixels, threshold = 32): { regions: Region[], grew: number } {
  const CELL = 8
  const GAP = 2
  const MAX = 12
  const grew = after.height - before.height
  const width = Math.min(before.width, after.width)
  const cols = Math.ceil(width / CELL)
  const rows = Math.ceil(after.height / CELL)
  const counts = new Uint16Array(cols * rows)
  const same = (x: number, y: number, by: number) => {
    if (by < 0 || by >= before.height)
      return false

    const a = (y * after.width + x) * 4
    const b = (by * before.width + x) * 4

    return Math.abs(after.data[a]! - before.data[b]!) <= threshold && Math.abs(after.data[a + 1]! - before.data[b + 1]!) <= threshold && Math.abs(after.data[a + 2]! - before.data[b + 2]!) <= threshold
  }

  for (let y = 0; y < after.height; y++) {
    for (let x = 0; x < width; x++) {
      if (!same(x, y, y) && (grew === 0 || !same(x, y, y - grew)))
        counts[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]!++
    }
  }

  const seen = new Uint8Array(cols * rows)
  const regions: Region[] = []

  for (let start = 0; start < counts.length; start++) {
    if (counts[start]! < 2 || seen[start])
      continue

    const queue = [start]
    let [x0, y0, x1, y1] = [cols, rows, 0, 0]

    seen[start] = 1

    while (queue.length) {
      const cell = queue.pop()!
      const cx = cell % cols
      const cy = Math.floor(cell / cols)

      ;[x0, y0, x1, y1] = [Math.min(x0, cx), Math.min(y0, cy), Math.max(x1, cx), Math.max(y1, cy)]

      for (let ny = Math.max(0, cy - GAP); ny <= Math.min(rows - 1, cy + GAP); ny++) {
        for (let nx = Math.max(0, cx - GAP); nx <= Math.min(cols - 1, cx + GAP); nx++) {
          const next = ny * cols + nx

          if (counts[next]! >= 2 && !seen[next]) {
            seen[next] = 1
            queue.push(next)
          }
        }
      }
    }

    const x = x0 * CELL
    const y = y0 * CELL

    regions.push({ x, y, width: Math.min(width, (x1 + 1) * CELL) - x, height: Math.min(after.height, (y1 + 1) * CELL) - y })
  }

  const union = (a: Region, b: Region): Region => {
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)

    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
  }
  const touch = (a: Region, b: Region) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  const area = (r: Region) => r.width * r.height
  // the merge to make next: a touching pair first, else past MAX the one adding least area
  const cost = (a: Region, b: Region) => {
    if (touch(a, b))
      return 0

    return regions.length > MAX ? area(union(a, b)) - area(a) - area(b) : null
  }

  for (;;) {
    let best: { i: number, j: number, c: number } | null = null

    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length && best?.c !== 0; j++) {
        const c = cost(regions[i]!, regions[j]!)

        if (c !== null && (!best || c < best.c))
          best = { i, j, c }
      }
    }

    if (!best)
      break

    regions[best.i] = union(regions[best.i]!, regions[best.j]!)
    regions.splice(best.j, 1)
  }

  return { regions: regions.toSorted((a, b) => a.y - b.y || a.x - b.x), grew }
}

// What differs between two PNGs: the browser decodes them, then runs the region finder from its source on their pixels.
export async function regionsIn(browser: Browser, before: string, after: string): Promise<{ regions: Region[], grew: number }> {
  const page = await browser.newPage()
  const url = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`

  try {
    return await page.evaluate(async ([a, b, source]) => {
      const pixels = async (src: string) => {
        const img = new Image()

        img.src = src
        await img.decode()

        const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
        const context = canvas.getContext('2d')!

        context.drawImage(img, 0, 0)

        return context.getImageData(0, 0, canvas.width, canvas.height)
      }
      // eslint-disable-next-line no-new-func
      const find = new Function(`return (${source})`)() as typeof regionsOf

      return find(await pixels(a), await pixels(b))
    }, [url(before), url(after), regionsOf.toString()] as const)
  }
  finally {
    await page.close()
  }
}

// A pair's regions, or null when a side is missing or does not decode: a capture the finder cannot read still records.
export async function regionsOfPair(browser: Browser, before: string, after: string): Promise<{ regions: Region[], grew: number } | null> {
  if (!existsSync(before) || !existsSync(after))
    return null

  try {
    return await regionsIn(browser, before, after)
  }
  catch {
    return null
  }
}
