import { expect, test } from '@playwright/test'

// Plumbing, not product: `next dev` answers, the page it lands on renders (after
// any redirect, such as to a login page), and nothing throws in the browser.
// Next's own dev elements are left out, so its dev indicator alone does not pass.
test('root renders on next dev', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const response = await page.goto('/')
  expect(response?.status()).toBeLessThan(400)
  const content = page.locator('body > :not(script, nextjs-portal, next-route-announcer)')
  await expect(content.filter({ visible: true }).first()).toBeVisible()
  expect(errors).toEqual([])
})
