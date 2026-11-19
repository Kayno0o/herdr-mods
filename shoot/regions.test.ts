import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { chromium } from 'playwright-core'
import { regionsIn, regionsOf } from './regions'

// A white picture, with `paint` filling rectangles in a colour.
function picture(width: number, height: number, paint: [number, number, number, number, number][] = []) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)

  for (const [x0, y0, w, h, grey] of paint) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++)
        data.set([grey, grey, grey, 255], (y * width + x) * 4)
    }
  }

  return { width, height, data }
}

describe('regionsOf', () => {
  test('boxes each part that changed on the cell grid, apart when far from each other', () => {
    const { regions, grew } = regionsOf(picture(200, 100), picture(200, 100, [[10, 10, 20, 5, 0], [150, 60, 10, 10, 0]]))

    expect(regions).toEqual([{ x: 8, y: 8, width: 24, height: 8 }, { x: 144, y: 56, width: 16, height: 16 }])
    expect(grew).toBe(0)
  })

  test('takes two parts a cell or two apart for one, and leaves out a faint shade and a lone pixel', () => {
    const { regions } = regionsOf(picture(200, 100), picture(200, 100, [[10, 10, 5, 5, 0], [26, 10, 5, 5, 0], [100, 50, 30, 30, 240], [180, 90, 1, 1, 0]]))

    expect(regions).toEqual([{ x: 8, y: 8, width: 24, height: 8 }])
  })

  test('a section that grew is boxed alone, what it pushed down being found lower', () => {
    const before = picture(100, 120, [[0, 0, 100, 20, 0], [0, 80, 100, 10, 100]])
    const after = picture(100, 150, [[0, 0, 100, 20, 0], [0, 40, 100, 30, 50], [0, 110, 100, 10, 100]])
    const { regions, grew } = regionsOf(before, after)

    expect(grew).toBe(30)
    expect(regions).toEqual([{ x: 0, y: 40, width: 100, height: 32 }])
  })

  test('takes a box inside another for one', () => {
    const ring: [number, number, number, number, number][] = [[0, 0, 160, 4, 0], [0, 156, 160, 4, 0], [0, 0, 4, 160, 0], [156, 0, 4, 160, 0]]
    const { regions } = regionsOf(picture(300, 200), picture(300, 200, [...ring, [78, 78, 4, 4, 0]]))

    expect(regions).toEqual([{ x: 0, y: 0, width: 160, height: 160 }])
  })

  test('a page that reflowed comes out as a dozen boxes at most, covering every change', () => {
    const dots: [number, number, number, number, number][] = Array.from({ length: 30 }, (_, i) => [(i % 6) * 100, Math.floor(i / 6) * 100, 4, 4, 0])
    const { regions } = regionsOf(picture(600, 500), picture(600, 500, dots))

    expect(regions.length).toBe(12)
    for (const [x, y] of dots)
      expect(regions.some(r => r.x <= x && r.y <= y && r.x + r.width >= x + 4 && r.y + r.height >= y + 4)).toBe(true)
  })

  test('says nothing changed on two same pictures, and runs the same from its own source, as the browser does', () => {
    const same = picture(64, 64, [[5, 5, 10, 10, 0]])
    // eslint-disable-next-line no-new-func
    const copy = new Function(`return (${regionsOf.toString()})`)() as typeof regionsOf

    expect(regionsOf(same, same).regions).toEqual([])
    expect(copy(picture(64, 64), same)).toEqual(regionsOf(picture(64, 64), same))
  })
})

test('finds the regions of two PNGs the browser decodes, as `shoot` keeps them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-regions-'))
  const browser = await chromium.launch()

  try {
    const page = await browser.newPage({ viewport: { width: 300, height: 200 } })
    const shot = async (html: string, file: string) => {
      await page.setContent(`<body style="margin:0;background:#fff">${html}</body>`)
      await page.screenshot({ path: join(dir, file) })
    }

    await shot('<div style="position:absolute;left:40px;top:40px;width:40px;height:16px;background:#000"></div>', 'before.png')
    await shot('<div style="position:absolute;left:40px;top:40px;width:80px;height:16px;background:#000"></div>', 'after.png')

    expect(await regionsIn(browser, join(dir, 'before.png'), join(dir, 'after.png'))).toEqual({ regions: [{ x: 80, y: 40, width: 40, height: 16 }], grew: 0 })
  }
  finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
