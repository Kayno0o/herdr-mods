// What a scenario and a project preset give `review shoot`.
import type { Locator, Page } from 'playwright-core'

// for presets and scenarios, which sit in the config and reviews folders, where 'playwright-core' does not resolve
export type { Locator, Page }

export type ShotSide = 'before' | 'after'

export interface StepContext {
  page: Page
  side: ShotSide
  url: string
}

export interface ScenarioShot {
  label: string
  route: string
  steps?: (context: StepContext) => Promise<void>
  video?: boolean
  fullPage?: boolean
  viewport?: { width: number, height: number }
}

export interface Scenario {
  shots: ScenarioShot[]
}

export interface Hook {
  repo: string
  // Runs, from the stack directory, whenever a checkout changes a file under one of these paths.
  paths: string[]
  run: string
}

export interface Preset {
  url: (task: string) => string
  login: (context: { page: Page, url: string }) => Promise<void>
  ready: (page: Page) => Promise<void>
  hooks: Hook[]
  // How long the dev server gets to pick a checkout up before the page loads.
  settle: number
  // The browser's language, `fr-FR`, for an app or labels in another language than headless Chromium's English.
  locale?: string
}

export const definePreset = (preset: Preset): Preset => preset
export const defineScenario = (scenario: Scenario): Scenario => scenario

// The app itself failed on that revision and data, so loading it again would only fail the same way.
export class AppError extends Error {}
