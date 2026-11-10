// A preset for `review shoot`, to copy as ~/.config/herdr-mods/presets/<project>.ts: how to reach, log into and wait for one project's stack, and what to run when a checkout changes it.
// The login account goes in ~/.config/herdr-mods/.env, which `review shoot` loads before the preset runs.
import type { Page } from 'herdr-mods/shoot/types'
import process from 'node:process'
import { AppError, definePreset } from 'herdr-mods/shoot/types'

// A page is ready once the framework has mounted: a click landing before that hits markup nothing listens to yet.
async function mounted(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('#app')?.hasAttribute('data-v-app'), undefined, { timeout: 45_000 })
}

export default definePreset({
  // The stack's base URL, from the name of its folder (`wt add <task>` names it after the task)
  url: task => `https://${task}.shop.localhost`,

  async login({ page, url }) {
    const { SHOOT_SHOP_USERNAME, SHOOT_SHOP_PASSWORD } = process.env

    if (!SHOOT_SHOP_USERNAME || !SHOOT_SHOP_PASSWORD)
      throw new Error('set SHOOT_SHOP_USERNAME and SHOOT_SHOP_PASSWORD in ~/.config/herdr-mods/.env, an account of the stack database')

    await page.goto(`${url}/login`)
    await mounted(page)
    await page.getByLabel('Email').fill(SHOOT_SHOP_USERNAME)
    await page.getByLabel('Password', { exact: true }).fill(SHOOT_SHOP_PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(target => !target.pathname.endsWith('/login'))
  },

  async ready(page) {
    await mounted(page)

    // An AppError says the revision itself is broken, so the shot fails without the retries a slow stack gets
    if (await page.locator('vite-error-overlay').count())
      throw new AppError('the app does not build')
  },

  // Run from the stack folder after a checkout that changed one of the paths, in this order
  hooks: [
    { repo: 'shop', paths: ['package-lock.json'], run: 'docker compose exec -T app npm ci' },
    { repo: 'shop', paths: ['migrations/'], run: 'docker compose exec -T app npm run migrate' },
  ],

  // How long the dev server gets to pick a checkout up before the first page loads
  settle: 2000,

  // The browser's language, when the app or its labels are not in English
  locale: 'en-GB',
})
