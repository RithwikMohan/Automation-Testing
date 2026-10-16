import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { findTimesheetControl, gridEvidenceFromHtml, gridIsAccessible, waitForTimesheetGrid } from './timesheetNavigation.mjs'

test('finds and clicks My Timesheet from an APEX-like menu', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setContent('<button id="t_Button_navControl">Menu</button><nav hidden><a href="/observed-timesheet">My Timesheet</a></nav><script>t_Button_navControl.onclick=()=>document.querySelector("nav").hidden=false</script>')
  const link = await findTimesheetControl(page)
  assert.ok(link)
  assert.equal(await link.innerText(), 'My Timesheet')
  await browser.close()
})

test('finds the observed home1 route when the menu label is generic', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setContent('<button id="t_Button_navControl">Menu</button><nav hidden><a href="/ords/r/app/home1?session=secret">Home</a></nav><script>t_Button_navControl.onclick=()=>document.querySelector("nav").hidden=false</script>')
  const link = await findTimesheetControl(page)
  assert.ok(link)
  assert.equal(await link.getAttribute('href'), '/ords/r/app/home1?session=secret')
  await browser.close()
})

test('does not select the application brand before a sidebar route', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setContent('<a href="/ords/r/app/home">timesheet application</a><button id="t_Button_navControl">Menu</button><nav hidden><a href="/ords/r/app/home1?session=secret">Home</a></nav><script>t_Button_navControl.onclick=()=>document.querySelector("nav").hidden=false</script>')
  const link = await findTimesheetControl(page)
  assert.ok(link)
  assert.equal(await link.innerText(), 'Home')
  await browser.close()
})

test('returns null when the navigation control is missing', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setContent('<main>Authenticated home</main>')
  assert.equal(await findTimesheetControl(page, '#missing-menu'), null)
  await browser.close()
})

test('times out when the timesheet grid is unavailable', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setContent('<main>My Timesheet is loading</main>')
  assert.equal(await waitForTimesheetGrid(page, 50, 10), null)
  await browser.close()
})

test('verifies date headers, project rows, hour cells and disabled cells', () => {
  const evidence = gridEvidenceFromHtml('<section><h2>Weekly Timesheet</h2><div>Project</div><div>MON 12-Oct</div><div>TUE 13-Oct</div><div>WED 14-Oct</div><div>THU 15-Oct</div><div>FRI 16-Oct</div><div>SAT 17-Oct</div><div>SUN 18-Oct</div><div>Project Alpha</div><button>Delete</button><button>Delete</button><button>Delete</button><div>2</div><div>0</div><div disabled>Leave</div></section>')
  assert.equal(gridIsAccessible(evidence), true)
  assert.equal(evidence.projectRows, 3)
  assert.ok(evidence.disabledCells > 0)
})

test('verifies an APEX-style weekly grid without a table element', async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.setContent(`
    <section>
      <h2>Weekly Timesheet</h2>
      <div>Project</div>
      <div>MON 12-Oct</div><div>TUE 13-Oct</div><div>WED 14-Oct</div>
      <div>THU 15-Oct</div><div>FRI 16-Oct</div><div>SAT 17-Oct</div><div>SUN 18-Oct</div>
      <div>cloud spm</div><button>Delete</button><input value="2"><input value="0"><div>L</div><input value="3">
      <div>zoho application</div><button>Delete</button><input value="0">
      <div>project R</div><button>Delete</button><input value="3">
    </section>
  `)
  const evidence = await waitForTimesheetGrid(page, 100, 10)
  assert.ok(evidence)
  assert.equal(evidence.grids, 1)
  assert.ok(evidence.dateHeaders >= 7)
  assert.equal(evidence.projectRows, 3)
  assert.ok(evidence.hourCells > 0)
  await browser.close()
})
