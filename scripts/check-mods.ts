#!/usr/bin/env bun
// Loads every mod once through `herdr-app check`, which type-checks its JS against the gpui-kit.d.ts it writes beside it and reports a missing export or a broken import.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const MODS = join(import.meta.dir, '..', 'mods')

if (!Bun.which('herdr-app')) {
  console.log('herdr-app is not installed here, the mods are left unchecked')
  process.exit(0)
}

let failed = 0

for (const mod of readdirSync(MODS, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const result = Bun.spawnSync(['herdr-app', 'check', join(MODS, mod.name)], { stdout: 'pipe', stderr: 'pipe' })

  if (result.exitCode === 0)
    continue

  failed++
  console.error(`${mod.name}:\n${result.stdout.toString()}${result.stderr.toString()}`)
}

process.exit(failed ? 1 : 0)
