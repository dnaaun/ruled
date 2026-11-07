// End-to-end: build output served by `vite preview`, import a real Anki package through the UI,
// then study a card from it. Run with `npm run build && npm run e2e`.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// require() so a globally installed Playwright (NODE_PATH) works too
const { chromium } = createRequire(import.meta.url)('playwright')

const root = fileURLToPath(new URL('../..', import.meta.url))
const fixture = fileURLToPath(new URL('../fixtures/sample.apkg', import.meta.url))
const port = 4179
const shots = process.env.E2E_SHOTS // optional directory for screenshots

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], detached: true })
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes(String(port)) && resolve())
  server.on('exit', (c) => reject(new Error(`vite preview exited (${c})`)))
  setTimeout(() => reject(new Error('vite preview did not start')), 20_000)
})

const fail = (msg) => { throw new Error(msg) }
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // the app must work offline: no request may leave the preview server
  page.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== 'localhost' && u.protocol.startsWith('http')) errors.push(`external request: ${r.url()}`) })
  await page.goto(`http://localhost:${port}/`)

  const chooser = page.waitForEvent('filechooser')
  await page.locator('.welcome').getByRole('button', { name: 'Import from Anki' }).click()
  await page.getByRole('button', { name: 'Choose file…' }).click()
  await (await chooser).setFiles(fixture)
  await page.getByText('Moved in.').waitFor({ timeout: 20_000 })
  const facts = await page.locator('.anki-facts .fact').allInnerTexts()
  console.log('summary:', facts.map((f) => f.replace(/\n/g, ' ')).join(' | '))
  const want = ['2 NEW STACKS', '6 NOTES ADDED', '9 CARDS ADDED', '7 REVIEWS']
  for (const w of want) if (!facts.some((f) => f.replace(/\s+/g, ' ').toUpperCase() === w)) fail(`missing "${w}" in summary`)
  if (shots) await page.screenshot({ path: `${shots}/anki-summary.png` })

  await page.getByRole('button', { name: 'Done' }).click()
  const stacks = await page.locator('.stack h3').allInnerTexts()
  console.log('stacks:', stacks)
  if (stacks.join() !== 'Geography,Languages::French') fail(`unexpected stacks ${stacks}`)
  if (shots) await page.screenshot({ path: `${shots}/anki-stacks.png` })

  // the French stack has a learning card that is due; study it
  await page.locator('.stack', { hasText: 'Languages::French' }).click()
  await page.getByRole('button', { name: /Study now/ }).click()
  await page.locator('.content, .card').first().waitFor()
  await page.keyboard.press('Space')
  const body = await page.locator('body').innerText()
  if (!/hello|cat|chat|bonjour/.test(body)) fail('study screen does not show an imported card')
  if (shots) await page.screenshot({ path: `${shots}/anki-study.png` })

  console.log('studied a card')
  // re-import is a merge
  await page.goto(`http://localhost:${port}/#/`)
  const chooser2 = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import from Anki' }).click()
  await page.getByRole('button', { name: 'Choose file…' }).click()
  await (await chooser2).setFiles(fixture)
  await page.getByText('Moved in.').waitFor({ timeout: 20_000 })
  if (!(await page.getByText('already here').isVisible())) fail('re-import did not report a no-op merge')

  console.log('re-import merged')
  // data survives a reload (IndexedDB)
  await page.reload()
  const after = await page.locator('.stack').count()
  if (after !== 2) fail(`expected 2 stacks after reload, got ${after}`)

  if (errors.length) fail(`page errors:\n${errors.join('\n')}`)
  console.log('e2e: anki import OK')
} finally {
  await browser.close()
  try { process.kill(-server.pid) } catch { server.kill() }
}
