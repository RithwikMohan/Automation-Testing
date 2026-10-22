/**
 * Extracts safe, bounded, structured information from a loaded Playwright page in a strictly read-only manner.
 * Never executes user-provided code, never clicks, never types, never submits forms.
 */
export async function extractPageData(page, targetUrl) {
  let urlOrigin = ''
  try {
    urlOrigin = new URL(targetUrl).origin
  } catch {}

  const rawData = await page.evaluate((origin) => {
    // Helper to safely truncate strings
    const truncate = (str, max) => (typeof str === 'string' ? str.trim().slice(0, max) : '')

    // 1. Page title
    const title = truncate(document.title, 200)

    // 2. Meta description
    const metaDescEl = document.querySelector('meta[name="description"], meta[property="og:description"]')
    const metaDescription = metaDescEl ? truncate(metaDescEl.getAttribute('content'), 500) : null

    // 3. Headings (h1, h2, h3)
    const headings = []
    const headingEls = document.querySelectorAll('h1, h2, h3')
    for (let i = 0; i < Math.min(headingEls.length, 30); i++) {
      const el = headingEls[i]
      const text = truncate(el.innerText || el.textContent, 150)
      if (text) {
        headings.push({
          level: parseInt(el.tagName.slice(1), 10),
          text,
        })
      }
    }

    // 4. Discover links (bounded to 50)
    const links = []
    const seenHrefs = new Set()
    const anchorEls = document.querySelectorAll('a[href]')
    for (let i = 0; i < anchorEls.length && links.length < 50; i++) {
      const a = anchorEls[i]
      const href = a.getAttribute('href')
      if (!href || href.startsWith('javascript:') || href.startsWith('#')) continue

      let fullHref = href
      let isSameOrigin = false
      try {
        const parsed = new URL(href, document.baseURI)
        // Only accept http / https links
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
        fullHref = parsed.origin + parsed.pathname
        if (parsed.search) fullHref += parsed.search
        isSameOrigin = parsed.origin === origin
      } catch {
        continue
      }

      if (seenHrefs.has(fullHref)) continue
      seenHrefs.add(fullHref)

      const text = truncate(a.innerText || a.textContent || a.getAttribute('aria-label') || fullHref, 100)
      links.push({
        text: text || fullHref,
        href: fullHref,
        isSameOrigin,
      })
    }

    // 5. Read-only form summaries
    const forms = []
    let hasPasswordField = false
    const formEls = document.querySelectorAll('form')
    for (let i = 0; i < Math.min(formEls.length, 10); i++) {
      const form = formEls[i]
      const inputs = form.querySelectorAll('input, select, textarea')
      const fields = []
      let formHasPassword = false

      for (let j = 0; j < Math.min(inputs.length, 15); j++) {
        const inp = inputs[j]
        const type = (inp.getAttribute('type') || inp.tagName.toLowerCase()).toLowerCase()
        const name = truncate(inp.getAttribute('name') || inp.getAttribute('id') || `field_${j}`, 50)
        const placeholder = truncate(inp.getAttribute('placeholder'), 80)
        if (type === 'password') {
          formHasPassword = true
          hasPasswordField = true
        }
        fields.push({
          name,
          type,
          placeholder: placeholder || undefined,
        })
      }

      forms.push({
        action: truncate(form.getAttribute('action'), 200) || null,
        method: (form.getAttribute('method') || 'GET').toUpperCase(),
        fieldCount: inputs.length,
        fields,
        hasPasswordField: formHasPassword,
      })
    }

    // Also check standalone password inputs outside forms
    if (!hasPasswordField) {
      hasPasswordField = Boolean(document.querySelector('input[type="password"]'))
    }

    // 6. Interactive counts
    const buttonCount = document.querySelectorAll('button, input[type="button"], input[type="submit"]').length
    const linkCount = anchorEls.length
    const inputCount = document.querySelectorAll('input, textarea, select').length
    const selectCount = document.querySelectorAll('select').length

    // 7. Auth detection heuristic
    const bodyText = (document.body?.innerText || '').slice(0, 3000).toLowerCase()
    const hasAuthText = /sign in|log in|login|user name|username|password|sso|authenticate/i.test(bodyText)
    const isAuthRequired = hasPasswordField || (hasAuthText && (buttonCount > 0 || inputCount > 0))

    return {
      title,
      metaDescription,
      headings,
      links,
      forms,
      interactiveElements: {
        buttonCount,
        linkCount,
        inputCount,
        selectCount,
      },
      hasPasswordField,
      isAuthRequired,
    }
  }, urlOrigin)

  const status = rawData.isAuthRequired ? 'AUTH_REQUIRED' : 'SUCCESS'

  return {
    status,
    title: rawData.title,
    metaDescription: rawData.metaDescription,
    headings: rawData.headings,
    links: rawData.links,
    forms: rawData.forms,
    interactiveElements: rawData.interactiveElements,
    authDetected: rawData.isAuthRequired,
  }
}
