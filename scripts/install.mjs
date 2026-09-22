// dsh-enter-keymap: link the plugin into a DSH profile.
//
// The supported route is the official command:
//   dsh plugin --profile web add "link:<absolute-plugin-path>"
// On this machine `dsh plugin` fails with ERR_PNPM_UNEXPECTED_STORE (pnpm store
// detection inside the DSH launcher layout), so this script performs the same
// three steps by hand, idempotently:
//   1. a junction in the profile's node_modules pointing at this plugin;
//   2. a `link:` dependency entry plus the package name in dsh.profile.bundles;
//   3. a schemastery junction inside the plugin so the host half can resolve it.
//
// Why step 3 is needed: the Cordis loader imports the plugin's real path, so the
// host half resolves bare imports from the plugin directory upward - not from the
// profile. The plugin therefore needs its own node_modules entry for schemastery
// (which the profile already has).
//
// Usage:
//   node scripts/install.mjs [--profile web] [--profile-dir <path>] [--plugin-dir <path>]

import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(readFlag('--plugin-dir') ?? join(here, '..'))
const profileName = readFlag('--profile') ?? 'web'
const profileDir = resolve(
  readFlag('--profile-dir') ??
    (process.env.DSH_HOME
      ? join(process.env.DSH_HOME, 'profiles', profileName)
      : fail('profile directory unknown: set DSH_HOME or pass --profile-dir')),
)

/**
 * Read one `--flag value` argument.
 * @param {string} name - Flag name.
 * @returns {string | undefined} The value, when present.
 */
function readFlag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * Print a fatal message and stop.
 * @param {string} message - What went wrong.
 * @returns {never} Never returns.
 */
function fail(message) {
  console.error(`dsh-enter-keymap install: ${message}`)
  process.exit(1)
}

if (!existsSync(profileDir)) fail(`profile directory does not exist: ${profileDir}`)

const packageName = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).name
if (typeof packageName !== 'string' || packageName === '') fail(`no package name in ${pluginDir}/package.json`)

console.log(`plugin:  ${pluginDir}`)
console.log(`package: ${packageName}`)
console.log(`profile: ${profileDir}`)

// 1. node_modules junction (directory link; `junction` is the non-elevated
//    directory-link type on Windows, `dir` elsewhere).
const nodeModules = join(profileDir, 'node_modules')
const linkPath = join(nodeModules, packageName)
rmSync(linkPath, { recursive: true, force: true })
symlinkSync(pluginDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`  [1/3] link: ${linkPath} -> ${pluginDir}`)

// 2. package.json: link dependency + profile bundle entry.
const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const before = JSON.stringify(manifest)
manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies[packageName] = `link:${pluginDir}`
const bundles = manifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(packageName)) bundles.push(packageName)
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = { ...(manifest.dsh.profile ?? {}), bundles }
if (JSON.stringify(manifest) === before) {
  console.log('  [2/3] package.json already up to date')
} else {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`  [2/3] package.json: dependencies.${packageName} + bundles`)
}

// 3. schemastery junction for the host half.
const schemaSource = join(nodeModules, 'schemastery')
if (existsSync(schemaSource)) {
  const ownModules = join(pluginDir, 'node_modules')
  const schemaLink = join(ownModules, 'schemastery')
  rmSync(schemaLink, { recursive: true, force: true })
  symlinkSync(schemaSource, schemaLink, process.platform === 'win32' ? 'junction' : 'dir')
  console.log('  [3/3] schemastery link ready')
} else {
  console.warn('  [3/3] no schemastery under the profile; the host half may fail to import')
}

console.log('\nDone. Restart the DSH instance and reload the page to activate.')
