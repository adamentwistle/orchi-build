import { expect, test } from '@playwright/test'

// Plumbing, not product: the app loads through the Wails bridge, React mounts,
// and the Go bindings are present. Errors thrown by Wails' own injected bridge
// script are ignored: in v2.15 its "disconnected" overlay throws on mount in a
// plain browser while the bridge itself still connects.
test('root renders through the Wails bridge', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => {
    if (!e.stack?.includes('/wails/ipc.js')) errors.push(e.message)
  })
  await page.goto('/')
  await expect(page.locator('#root > *').first()).toBeVisible()
  expect(await page.evaluate(() => Object.keys((window as any).go ?? {}))).not.toHaveLength(0)
  expect(errors).toEqual([])
})
