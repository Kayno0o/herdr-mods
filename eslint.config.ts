import { defineConfig } from '@kaynooo/eslint'

export default defineConfig(
  {},
  // The mods follow Herdr's own style and are checked by `herdr-app check`
  { ignores: ['mods/**/*.js'] },
)
