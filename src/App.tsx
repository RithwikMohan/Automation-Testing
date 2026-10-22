import { useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity, AlertTriangle, ArrowUpRight, BarChart3, Bell, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, CloudUpload, FileSpreadsheet, Film, Gauge, GitBranch, LayoutDashboard, Menu, Play, Plus, Search, Settings as SettingsIcon, ShieldCheck, Sparkles, TrendingDown, TrendingUp, Upload, Users, X, Zap } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

type Page = 'overview' | 'upload' | 'runs' | 'run-detail' | 'recordings' | 'reports' | 'settings'
type Status = 'Passed' | 'Failed' | 'Running' | 'Pending' | 'Partial'
type Validation = 'READY' | 'INVALID' | 'PROJECT MISMATCH' | 'EXCEEDS LIMIT' | 'NEEDS DATA' | 'UPDATED' | 'UPDATE FAILED' | 'UPDATE IN PROGRESS' | 'VERIFICATION FAILED'
type Row = { id: string; username: string; date: string; hours: number; workdescription: string; existing: number | null; validation: Validation; error?: string }
type RunCase = { row_number: number; case_id: string | null; username_masked: string | null; requested_date: string | null; project: string | null; requested_hours: number | null; status: string; message: string | null; current_hours: number | null; updated_hours: number | null; artifacts?: RunArtifact[] }
type RunArtifact = { kind: string; content_type: string; url: string }
type Run = { id: string; file: string; created: string; total: number; passed: number; failed: number; skipped: number; duration: string; status: Status; cases?: RunCase[]; artifacts?: RunArtifact[] }

const chartData: { day: string; passed: number; failed: number }[] = []
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'upload', label: 'Upload Test Cases', icon: CloudUpload },
  { id: 'runs', label: 'Test Runs', icon: GitBranch },
  { id: 'recordings', label: 'Recordings', icon: Film },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
] as const

function maskUser(value: string) { return value.length <= 3 ? '••••' : `${value.slice(0, 2)}•••${value.slice(-2)}` }
function normalizeDate(value: string) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const dayFirst = value.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/)
  if (!iso && !dayFirst) return null
  const year = iso ? iso[1] : dayFirst![3]
  const month = iso ? iso[2] : dayFirst![2]
  const day = iso ? iso[3] : dayFirst![1]
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}` ? null : `${year}-${month}-${day}`
}
function validate(row: Record<string, string>, index: number): Row {
  const username = row.username || row['user name'] || ''
  const date = row.date || ''
  const requestedHours = row.hours || row['log time'] || ''
  const description = row.workdescription || row['work description'] || ''
  const hours = Number(requestedHours)
  const existing: number | null = null
  let validation: Validation = 'READY'; let error = ''
  if (!username || !date || !requestedHours || !description || !Number.isFinite(hours) || hours <= 0) { validation = 'INVALID'; error = 'Required fields must be present and hours must be greater than zero.' }
  else if (!normalizeDate(date)) { validation = 'INVALID'; error = 'Date must use YYYY-MM-DD or DD-MM-YYYY format.' }
  else if (existing === null) { validation = 'NEEDS DATA'; error = 'Existing logged hours are unavailable; this case cannot be verified.' }
  else if (existing + hours > 8) { validation = 'EXCEEDS LIMIT'; error = `Projected total is ${(existing + hours).toFixed(1)}h, above the 8h daily limit.` }
  return { id: `TC-${String(index + 1).padStart(3, '0')}`, username: username || 'unknown', date: date || '—', hours, workdescription: description || '—', existing, validation, error }
}

function StatusBadge({ status }: { status: string }) { return <span className={`badge badge-${status.toLowerCase().replaceAll(' ', '-')}`}>{status === 'Passed' && <Check size={12} />}{status}</span> }
function ValidationBadge({ value }: { value: Validation }) { return <span className={`badge validation-${value.toLowerCase().replaceAll(' ', '-')}`}>{value}</span> }
function Metric({ icon: Icon, label, value, trend, color }: { icon: typeof Activity; label: string; value: string; trend: string; color: string }) { return <motion.div whileHover={{ y: -4 }} className="metric card"><div className={`metric-icon ${color}`}><Icon size={19} /></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-trend"><ArrowUpRight size={13} /> {trend}</div></motion.div> }
function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div> }

function App() {
  const [page, setPage] = useState<Page>('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [runs, setRuns] = useState<Run[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [fileName, setFileName] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [isReadOnlyValidating, setIsReadOnlyValidating] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [selectedRun, setSelectedRun] = useState<Run>()
  const [search, setSearch] = useState('')
  const [recordingOpen, setRecordingOpen] = useState(false)
  const [selectedRecording, setSelectedRecording] = useState<Artifact>()
  const [autoUpdateOnUpload, setAutoUpdateOnUpload] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const validRows = rows.filter(r => r.validation === 'READY')
  const filteredRuns = runs.filter(r => `${r.id} ${r.file}`.toLowerCase().includes(search.toLowerCase()))
  useEffect(() => {
    fetch('http://localhost:8787/api/runs')
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Unable to load persisted runs.')))
      .then(setRuns)
      .catch(error => console.error(error))
    fetch('http://localhost:8787/api/config')
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Unable to load automation configuration.')))
      .then(config => setAutoUpdateOnUpload(config.auto_update_on_upload === true))
      .catch(error => console.error(error))
  }, [])

  const navigate = (next: Page) => { setPage(next); setSidebarOpen(false) }
  const refreshRuns = async () => {
    const response = await fetch('http://localhost:8787/api/runs')
    if (!response.ok) throw new Error('Unable to refresh persisted runs.')
    setRuns(await response.json())
  }
  const processUpload = async (sourceCsv = csvText, sourceFileName = fileName) => {
    if (!sourceCsv || isProcessing) return
    setIsProcessing(true)
    try {
      const response = await fetch('http://localhost:8787/api/v1/oracle/timesheet/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csvText: sourceCsv, caseId: sourceFileName }),
      })
      const payload = await response.json()
      const results = new Map<number, { status: string; message?: string; current_hours?: number; updated_hours?: number }>((payload.per_row || []).map((item: { row_number: number; status: string; message?: string; current_hours?: number; updated_hours?: number }) => [item.row_number, item]))
      setRows(current => current.map((row, index) => {
        const item = results.get(index + 2)
        if (!item) return row
        const currentHours = typeof item.current_hours === 'number' && Number.isFinite(item.current_hours) ? item.current_hours : row.existing
        return {
          ...row,
          existing: currentHours,
          validation: item.status as Validation,
          error: item.message,
        }
      }))
      if (!response.ok && payload.status !== 'UPDATE FAILED') throw new Error(payload.message || payload.error || 'Automation failed.')
      await refreshRuns()
      if (payload.status === 'UPDATE FAILED' || payload.status === 'INVALID') alert(payload.message || 'No cases were updated.')
      else navigate('runs')
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Automation failed.')
    } finally {
      setIsProcessing(false)
    }
  }
  const selectFile = async (file?: File) => {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv') || file.size > 25 * 1024 * 1024) { alert('Please choose a CSV file smaller than 25 MB.'); return }
    const text = await file.text()
    setCsvText(text)
    Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, complete: result => {
      setRows(result.data.map(validate))
      setFileName(file.name)
      navigate('upload')
      if (autoUpdateOnUpload) {
        window.setTimeout(() => processUpload(text, file.name), 0)
      }
    } })
  }
  const validateReadOnly = async () => {
    if (!csvText || isReadOnlyValidating) return
    setIsReadOnlyValidating(true)
    try {
      const response = await fetch('http://localhost:8787/api/v1/oracle/timesheet/read-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csvText }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Read-only validation failed.')
      type ReadOnlyResult = { row_number: number; status: Validation; message?: string; current_hours?: number }
      const results = new Map<number, ReadOnlyResult>((payload.per_row || []).map((item: ReadOnlyResult) => [item.row_number, item]))
      setRows(current => current.map((row, index) => {
        const item = results.get(index + 2)
        if (!item) return row
        const currentHours = typeof item.current_hours === 'number' && Number.isFinite(item.current_hours) ? item.current_hours : null
        const hasCurrentHours = currentHours !== null
        return {
          ...row,
          validation: item.status === 'READY' && !hasCurrentHours ? 'NEEDS DATA' : item.status,
          existing: currentHours,
          error: item.status === 'READY' && !hasCurrentHours ? 'Current hours were not returned; this case cannot be verified.' : item.message,
        }
      }))
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Read-only validation failed.')
    } finally {
      setIsReadOnlyValidating(false)
    }
  }
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor" /></div><span>chronos</span><span className="brand-pill">BETA</span></div>
      <div className="workspace-switcher"><div className="workspace-avatar">D</div><div><small>WORKSPACE</small><strong>Demo environment</strong></div><ChevronDown size={15} /></div>
      <nav>{nav.map(item => <button key={item.id} className={page === item.id || (page === 'run-detail' && item.id === 'runs') ? 'nav-item active' : 'nav-item'} onClick={() => navigate(item.id)}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className="health"><span className="pulse-dot" />All systems nominal</div><div className="version">CHRONOS V0.1.0 · DEMO</div></div>
    </aside>
    <main className="main">
      <header className="topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu /></button><div className="crumb"><span>Demo Environment</span><ChevronRight size={14} /><strong>{page === 'run-detail' ? 'Run details' : nav.find(n => n.id === page)?.label}</strong></div><div className="top-actions"><div className="top-search"><Search size={16} /><input placeholder="Search anything..." /></div><button className="icon-button"><Bell size={18} /><span className="notification-dot" /></button><div className="top-user"><div className="user-avatar">RM</div><div><strong>Rithwik</strong><small>Administrator</small></div><ChevronDown size={14} /></div></div></header>
      <div className="content">
        <AnimatePresence mode="wait">{page === 'overview' && <Overview navigate={navigate} runs={runs} />}{page === 'upload' && <UploadPage rows={rows} fileName={fileName} fileRef={fileRef} selectFile={selectFile} setRows={setRows} setFileName={setFileName} validRows={validRows.length} processUpload={processUpload} isProcessing={isProcessing} validateReadOnly={validateReadOnly} isReadOnlyValidating={isReadOnlyValidating} autoUpdateOnUpload={autoUpdateOnUpload} />}{page === 'runs' && <RunsPage runs={filteredRuns} search={search} setSearch={setSearch} openRun={(run) => { setSelectedRun(run); navigate('run-detail') }} />}{page === 'run-detail' && selectedRun && <RunDetails run={selectedRun} back={() => navigate('runs')} />}{page === 'recordings' && <Recordings open={(recording) => { setSelectedRecording(recording); setRecordingOpen(true) }} />}{page === 'reports' && <Reports navigate={navigate} />}{page === 'settings' && <SettingsPage />}</AnimatePresence>
      </div>
    </main>
    <AnimatePresence>{recordingOpen && <VideoModal recording={selectedRecording} close={() => { setRecordingOpen(false); setSelectedRecording(undefined) }} />}</AnimatePresence>
  </div>
}

function Overview({ navigate, runs }: { navigate: (p: Page) => void; runs: Run[] }) {
  const totals = runs.reduce((summary, run) => {
    const runPartial = run.status === 'Partial'
    return {
      total: summary.total + run.total,
      passed: summary.passed + run.passed,
      failed: summary.failed + (runPartial ? 0 : run.failed),
      partial: summary.partial + (runPartial ? run.failed : 0),
    }
  }, { total: 0, passed: 0, failed: 0, partial: 0 })
  const pending = Math.max(0, totals.total - totals.passed - totals.failed - totals.partial)

  const completed = totals.passed + totals.failed
  const passRate = completed > 0 ? (totals.passed / completed) * 100 : 0

  const runDates = runs.map((r) => new Date(r.created).getTime())
  const latestDate = runDates.length > 0 ? new Date(Math.max(...runDates)) : null
  const sevenDaysAgo = latestDate ? new Date(latestDate.getTime() - 7 * 24 * 60 * 60 * 1000) : null
  const fourteenDaysAgo = latestDate ? new Date(latestDate.getTime() - 14 * 24 * 60 * 60 * 1000) : null

  const currentPeriodRuns = (latestDate && sevenDaysAgo) ? runs.filter((r) => new Date(r.created) >= sevenDaysAgo) : []
  const previousPeriodRuns = (latestDate && sevenDaysAgo && fourteenDaysAgo) ? runs.filter((r) => new Date(r.created) >= fourteenDaysAgo && new Date(r.created) < sevenDaysAgo) : []

  const currentCompleted = currentPeriodRuns.reduce((s, r) => s + r.passed + r.failed, 0)
  const currentPassed = currentPeriodRuns.reduce((s, r) => s + r.passed, 0)
  const currentRate = currentCompleted > 0 ? (currentPassed / currentCompleted) * 100 : 0

  const prevCompleted = previousPeriodRuns.reduce((s, r) => s + r.passed + r.failed, 0)
  const prevPassed = previousPeriodRuns.reduce((s, r) => s + r.passed, 0)
  const prevRate = prevCompleted > 0 ? (prevPassed / prevCompleted) * 100 : 0

  const trendChange = prevCompleted > 0 ? currentRate - prevRate : null

  const sparklineDays: Date[] = []
  if (latestDate) {
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(latestDate)
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      sparklineDays.push(d)
    }
  }

  const sparklineData = sparklineDays.map((d) => {
    const dayEnd = new Date(d.getTime() + 24 * 60 * 60 * 1000)
    const dayRuns = runs.filter((r) => {
      const rd = new Date(r.created)
      return rd >= d && rd < dayEnd
    })
    const passed = dayRuns.reduce((s, r) => s + r.passed, 0)
    const failed = dayRuns.reduce((s, r) => s + r.failed, 0)
    const dayCompleted = passed + failed
    return {
      date: d.toISOString().slice(0, 10),
      day: d.toLocaleDateString(undefined, { weekday: 'short' }),
      passed,
      failed,
      rate: dayCompleted > 0 ? (passed / dayCompleted) * 100 : 0
    }
  })
  return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
  <div className="hero"><div><div className="demo-label"><span className="pulse-dot" /> LIVE AUTOMATION DATA</div><h1>Good morning, Rithwik <span className="wave">✦</span></h1><p>Your timesheet automation command center.</p></div><div className="hero-actions"><button className="button button-secondary" onClick={() => navigate('runs')}>View test runs <ArrowUpRight size={16} /></button><button className="button button-primary" onClick={() => navigate('upload')}><Plus size={17} /> Upload test cases</button></div></div>
  <div className="metric-grid"><Metric icon={FileSpreadsheet} label="Total test cases" value={String(totals.total)} trend="Persisted results" color="violet" /><Metric icon={CheckCircle2} label="Passed" value={String(totals.passed)} trend={totals.total ? `${Math.round(totals.passed / totals.total * 100)}% pass rate` : 'No results yet'} color="cyan" /><Metric icon={AlertTriangle} label="Partial" value={String(totals.partial)} trend="Mixed-result runs" color="amber" /><Metric icon={AlertTriangle} label="Failed" value={String(totals.failed)} trend="Persisted failures" color="orange" /><Metric icon={Clock3} label="Pending" value={String(pending)} trend={pending ? 'Awaiting result' : 'No pending cases'} color="blue" /></div>
  <div className="grid-2">
  <section className="card reliability-card">
    <div className="card-heading">
      <div>
        <h2>Automation Reliability</h2>
        <p>Timesheet automation pass rate across all executed test cases.</p>
      </div>
    </div>
    <div className="reliability-content">
      {completed === 0 ? (
        <div className="reliability-empty">
          <Activity size={28} />
          <strong>No completed executions</strong>
          <p>Run test cases to see your automation success rate here.</p>
        </div>
      ) : (
        <>
          <div className="reliability-top">
            <div className="reliability-circle">
              <svg className="reliability-svg" width="200" height="200" viewBox="0 0 200 200">
                <defs>
                  <linearGradient id="reliability-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#10b981" />
                    <stop offset="100%" stopColor="#21d4d8" />
                  </linearGradient>
                </defs>
                <circle className="reliability-track" cx="100" cy="100" r="85" />
                <circle
                  className="reliability-progress"
                  cx="100"
                  cy="100"
                  r="85"
                  style={{
                    strokeDasharray: `${completed > 0 ? (passRate / 100) * 534 : 0} 534`,
                  }}
                />
              </svg>
              <div className="reliability-value">
                <span className="reliability-percent">{passRate.toFixed(1)}%</span>
                <span className="reliability-label">Automation success rate</span>
              </div>
            </div>
            <div className="reliability-summary">
              <div className="summary-stat">
                <div className="summary-value passed">{totals.passed}</div>
                <div className="summary-label">Passed</div>
              </div>
              <div className="summary-stat">
                <div className="summary-value failed">{totals.failed}</div>
                <div className="summary-label">Failed</div>
              </div>
              <div className="summary-stat">
                <div className="summary-value completed">{completed}</div>
                <div className="summary-label">Completed</div>
              </div>
              {totals.partial > 0 && (
                <div className="summary-stat partial">
                  <div className="summary-value partial">{totals.partial}</div>
                  <div className="summary-label">Partial</div>
                </div>
              )}
              {pending > 0 && (
                <div className="summary-stat">
                  <div className="summary-value">{pending}</div>
                  <div className="summary-label">Pending</div>
                </div>
              )}
            </div>
          </div>
          <div className="reliability-trend">
            <div className="trend-header">
              <div className="trend-title">
                <Clock3 size={13} />
                <span>7-Day Reliability Trend</span>
              </div>
              {trendChange !== null ? (
                <div className="trend-indicator">
                  <div className={`trend-value ${trendChange >= 0 ? 'trend-up' : 'trend-down'}`}>
                    {trendChange >= 0 ? '+' : ''}{trendChange.toFixed(1)} pts
                    {trendChange >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                  </div>
                  <span className="trend-label">vs previous period</span>
                </div>
              ) : (
                <div className="trend-indicator trend-empty">
                  <span className="trend-label">Not enough historical data</span>
                </div>
              )}
            </div>
            <div className="sparkline-wrap">
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={sparklineData} margin={{ top: 10, right: 12, left: -22, bottom: 0 }}>
                  <defs>
                    <linearGradient id="sparkline-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1b243b" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#707c97' }} axisLine={{ stroke: '#1b243b' }} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#707c97' }} axisLine={{ stroke: '#1b243b' }} tickLine={false} unit="%" />
                  <Tooltip
                    content={({ active, payload }: { active?: boolean; payload?: any[] }) => {
                      if (active && payload && payload[0]) {
                        const d = payload[0].payload
                        return (
                          <div className="recharts-tooltip">
                            <div style={{ fontWeight: 600, color: '#e8ebf5' }}>{d.day} ({d.date})</div>
                            <div style={{ color: '#10b981', fontSize: 11 }}>Passed: {d.passed}</div>
                            <div style={{ color: '#ef4444', fontSize: 11 }}>Failed: {d.failed}</div>
                            <div style={{ color: '#21d4d8', fontSize: 11, fontWeight: 600 }}>Rate: {d.rate.toFixed(1)}%</div>
                          </div>
                        )
                      }
                      return null
                    }}
                  />
                  <Area type="monotone" dataKey="rate" fill="url(#sparkline-gradient)" stroke="#10b981" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  </section><section className="card activity-card"><div className="card-heading"><div><h2>Latest activity</h2><p>Persisted automation runs</p></div></div>{runs.length ? <div className="activity-list">{runs.slice(0, 4).map(run => <ActivityItem key={run.id} icon={run.status === 'Failed' ? AlertTriangle : CheckCircle2} color={run.status === 'Failed' ? 'orange' : run.status === 'Partial' ? 'amber' : 'cyan'} title={`${run.status} run`} detail={`${run.file} · ${run.total} cases`} time={new Date(run.created).toLocaleString()} />)}</div> : <div className="empty-recordings"><Activity size={28} /><strong>No activity yet</strong><span>Processed runs will appear here.</span></div>}</section></div>
  <section className="card runs-card"><div className="card-heading"><div><h2>Recent test runs</h2><p>Monitor your latest simulated executions</p></div><button className="text-button" onClick={() => navigate('runs')}>View all runs <ArrowUpRight size={14} /></button></div><RunsTable runs={runs.slice(0, 3)} openRun={(r) => navigate('run-detail')} /></section>
</motion.div> }
function ActivityItem({ icon: Icon, color, title, detail, time }: { icon: typeof Activity; color: string; title: string; detail: string; time: string }) { return <div className="activity-item"><div className={`activity-icon ${color}`}><Icon size={15} /></div><div><strong>{title}</strong><span>{detail}</span></div><time>{time}</time></div> }

function UploadPage({ rows, fileName, fileRef, selectFile, setRows, setFileName, validRows, processUpload, isProcessing, validateReadOnly, isReadOnlyValidating, autoUpdateOnUpload }: { rows: Row[]; fileName: string; fileRef: React.RefObject<HTMLInputElement>; selectFile: (file?: File) => void; setRows: (r: Row[]) => void; setFileName: (s: string) => void; validRows: number; processUpload: () => void; isProcessing: boolean; validateReadOnly: () => void; isReadOnlyValidating: boolean; autoUpdateOnUpload: boolean }) {
  const [drag, setDrag] = useState(false); const [filter, setFilter] = useState('All')
  const clear = () => { setRows([]); setFileName('') }
  return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><PageHeader eyebrow="WORKFLOW / 01" title="Upload test cases" description="Upload a CSV and process every row through the backend automation workflow." action={rows.length > 0 && <button className="button button-secondary" onClick={clear}><X size={16} /> Remove file</button>} />
    {!rows.length ? <div className={`dropzone ${drag ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); selectFile(e.dataTransfer.files[0]) }}><div className="drop-icon"><Upload size={28} /></div><h2>Drop your test cases here</h2><p>Upload a CSV file to start backend processing.</p><button className="button button-primary" onClick={() => fileRef.current?.click()}><FolderIcon /> Browse files</button><input ref={fileRef} hidden type="file" accept=".csv,text/csv" onChange={e => selectFile(e.target.files?.[0])} /><small><FileSpreadsheet size={14} /> CSV only · Max 25 MB</small><div className="security-note"><ShieldCheck size={15} /> Credentials are sent only to the local backend and are never persisted.</div></div> : <><div className="upload-summary card"><div className="file-icon"><FileSpreadsheet size={23} /></div><div className="file-info"><strong>{fileName}</strong><span>{rows.length} test cases · Processed by the backend</span></div><div className="summary-stat"><span>READY</span><strong>{validRows}</strong></div><div className="summary-stat danger"><span>NEEDS REVIEW</span><strong>{rows.length - validRows}</strong></div><button className="button button-secondary" onClick={() => fileRef.current?.click()}>Replace</button><button className="button button-secondary" onClick={validateReadOnly} disabled={isReadOnlyValidating || isProcessing}>{isReadOnlyValidating ? 'Validating read-only…' : 'Validate against Oracle (read-only)'}</button>    {!autoUpdateOnUpload && <button className="button button-primary" onClick={() => processUpload()} disabled={isProcessing}>{isProcessing ? 'Processing…' : 'Process uploaded cases'}</button>}{autoUpdateOnUpload && <span className="security-note">Automatic processing is enabled.</span>}</div><input ref={fileRef} hidden type="file" accept=".csv,text/csv" onChange={e => selectFile(e.target.files?.[0])} /><section className="card preview-card"><div className="card-heading"><div><div className="eyebrow">VALIDATION PREVIEW</div><h2>Test case review</h2><p>Every backend result is shown here, including rejected and failed cases.</p></div><div className="filter-tabs">{['All', 'READY', 'Needs review'].map(v => <button className={filter === v ? 'selected' : ''} onClick={() => setFilter(v)} key={v}>{v}</button>)}</div></div><div className="table-wrap"><table><thead><tr><th>Test case</th><th>Username</th><th>Target date</th><th>Existing hours</th><th>Requested</th><th>Projected</th><th>Status</th></tr></thead><tbody>{rows.filter(r => filter === 'All' || (filter === 'READY' ? r.validation === 'READY' : r.validation !== 'READY')).map(row => <tr key={row.id}><td><strong>{row.id}</strong></td><td className="mono">{maskUser(row.username)}</td><td>{row.date}</td><td>{row.existing === null ? <span className="muted">Unavailable</span> : `${row.existing.toFixed(1)}h`}</td><td>{row.hours || '—'}h</td><td>{row.existing === null ? '—' : `${(row.existing + row.hours).toFixed(1)}h`}</td><td><ValidationBadge value={row.validation} /><small className="row-error">{row.error}</small></td></tr>)}</tbody>    </table></div></section></>}</motion.div>
}
function FolderIcon() { return <FileSpreadsheet size={17} /> }

function RunsTable({ runs, openRun }: { runs: Run[]; openRun: (r: Run) => void }) { return <div className="table-wrap"><table><thead><tr><th>Run ID</th><th>CSV filename</th><th>Cases</th><th>Passed</th><th>Failed</th><th>Duration</th><th>Status</th><th /></tr></thead><tbody>{runs.map(r => <tr key={r.id}><td><button className="link-button mono" onClick={() => openRun(r)}>{r.id}</button></td><td><FileSpreadsheet size={14} className="inline-icon" />{r.file}</td><td>{r.total}</td><td className="success-text">{r.passed}</td><td className="danger-text">{r.failed}</td><td>{r.duration}</td><td><StatusBadge status={r.status} /></td><td><button className="row-action" onClick={() => openRun(r)}><ChevronRight size={16} /></button></td></tr>)}</tbody></table></div> }
function RunsPage({ runs, search, setSearch, openRun }: { runs: Run[]; search: string; setSearch: (s: string) => void; openRun: (r: Run) => void }) {
  const [statusFilter, setStatusFilter] = useState<Status | 'All runs'>('All runs')
  const filtered = runs.filter(r => {
    const matchStatus = statusFilter === 'All runs' || r.status === statusFilter
    const matchSearch = `${r.id} ${r.file}`.toLowerCase().includes(search.toLowerCase())
    return matchStatus && matchSearch
  })
  const statusCounts = {
    'All runs': runs.length,
    Passed: runs.filter(r => r.status === 'Passed').length,
    Failed: runs.filter(r => r.status === 'Failed').length,
    Partial: runs.filter(r => r.status === 'Partial').length,
    Pending: runs.filter(r => r.status === 'Pending').length,
  }
  return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><PageHeader eyebrow="EXECUTION HISTORY" title="Test runs" description="Inspect simulated automation runs and their outcomes." action={<button className="button button-primary"><Plus size={16} /> New run</button>} /><div className="toolbar card"><div className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by run ID or filename..." /></div><div className="filter-tabs">{Object.entries(statusCounts).map(([label, count]) => <button key={label} className={statusFilter === (label as Status | 'All runs') ? 'selected' : ''} onClick={() => setStatusFilter(label as Status | 'All runs')}>{label} <span className="badge-count">{count}</span></button>)}</div><button className="select-button"><CalendarDays size={15} /> Any date <ChevronDown size={14} /></button></div><section className="card runs-card"><div className="card-heading"><div><h2>All test runs</h2><p>{filtered.length} runs in demo history</p></div><button className="more-button">•••</button></div><RunsTable runs={filtered} openRun={openRun} /></section></motion.div> }
function RunDetails({ run, back }: { run: Run; back: () => void }) { const cases = run.cases || []; return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><button className="back-button" onClick={back}>← Back to test runs</button><PageHeader eyebrow={`RUN / ${run.id}`} title={run.file} description={`${run.created} · Persisted automation run`} action={<StatusBadge status={run.status} />} /><div className="metric-grid compact"><Metric icon={FileSpreadsheet} label="Total cases" value={String(run.total)} trend="Processed" color="violet" /><Metric icon={CheckCircle2} label="Passed" value={String(run.passed)} trend={run.total ? `${Math.round(run.passed / run.total * 100)}% pass rate` : 'No cases'} color="cyan" /><Metric icon={AlertTriangle} label="Failed" value={String(run.failed)} trend="Needs attention" color="orange" /><Metric icon={Clock3} label="Skipped" value={String(run.skipped)} trend={run.duration} color="blue" /></div><section className="card runs-card"><div className="card-heading"><div><h2>Test case results</h2><p>Each case includes artifacts captured for its isolated automation context.</p></div></div><div className="table-wrap"><table><thead><tr><th>Test case</th><th>Username</th><th>Target date</th><th>Project</th><th>Status</th><th>Artifacts</th><th>Message</th></tr></thead><tbody>{cases.map(c => <tr key={`${run.id}-${c.row_number}`}><td><strong>{c.case_id || `Row ${c.row_number}`}</strong></td><td className="mono">{c.username_masked || '—'}</td><td>{c.requested_date || '—'}</td><td>{c.project || '—'}</td><td><span className="badge">{c.status}</span></td><td>{c.artifacts?.length ? c.artifacts.map(artifact => <a key={artifact.kind} className="link-button" href={`http://localhost:8787${artifact.url}`} target="_blank" rel="noreferrer">{artifact.kind}</a>) : '—'}</td><td>{c.message || '—'}</td></tr>)}</tbody></table></div></section></motion.div> }

function Recordings({ open }: { open: (recording?: Artifact) => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  useEffect(() => {
    Promise.all([
      fetch('http://localhost:8787/api/artifacts'),
      fetch('http://localhost:8787/api/runs'),
    ])
      .then(([artResp, runResp]) =>
        Promise.all([
          artResp.ok ? artResp.json() : [],
          runResp.ok ? runResp.json() : [],
        ])
      )
      .then(([artData, runData]) => {
        setArtifacts(artData)
        setRuns(runData)
      })
      .catch(() => {
        setArtifacts([])
        setRuns([])
      })
  }, [])
  const artifactWithFile = artifacts.map((a) => {
    const run = runs.find((r) => r.cases?.some((c) => c.case_id === a.caseId))
    return { ...a, fileName: run?.file || '—' }
  })
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader eyebrow="ARTIFACTS" title="Recordings" description="Review Playwright artifacts from read-only login validation." action={<button className="select-button">All recordings <ChevronDown size={14} /></button>} />
      <div className="info-banner"><CircleHelp size={17} /><span>Real Playwright recordings appear here when the backend is running. Demo placeholders are not presented as real artifacts.</span></div>
      <div className="recording-grid">
        {artifactWithFile.length ? (
          artifactWithFile.map((artifact, i) => (
            <motion.button whileHover={{ y: -5 }} className="recording-card card" key={artifact.artifactId} onClick={() => open(artifact)}>
              <div className={`video-thumb thumb-${i % 4}`}>
                {artifact.recordingAvailable && <div className="play-circle"><Play size={18} fill="currentColor" /></div>}
                <span>{artifact.recordingAvailable ? 'PLAYWRIGHT RECORDING' : 'NO VIDEO'}</span>
              </div>
              <div className="recording-meta">
                <div><strong>{artifact.caseId}</strong><span>{artifact.status}</span></div>
                <div className="artifact-file"><FileSpreadsheet size={12} /> {artifact.fileName}</div>
              </div>
              <span className="duration">{artifact.readOnly ? 'READ ONLY' : '—'}</span>
              <div className="recording-user">Artifact {artifact.artifactId.slice(0, 12)}…</div>
            </motion.button>
          ))
        ) : (
          <div className="empty-recordings card"><Film size={28} /><strong>No backend recordings found</strong><span>Run the backend validation service, then refresh this page.</span></div>
        )}
      </div>
    </motion.div>
  )
}
type Artifact = { artifactId: string; caseId: string; status: string; readOnly: boolean; recordingAvailable: boolean; videoUrl: string | null }
function VideoModal({ close, recording }: { close: () => void; recording?: Artifact }) { return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={close}><motion.div initial={{ y: 20 }} animate={{ y: 0 }} className="video-modal card" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">{recording?.readOnly ? 'READ-ONLY RECORDING' : 'DEMO RECORDING'} · {recording?.caseId || '—'}</div><h2>Recording preview</h2></div><button className="icon-button" onClick={close}><X size={18} /></button></div>{recording?.videoUrl ? <video className="real-video" controls autoPlay src={`http://localhost:8787${recording.videoUrl}`} /> : <div className="video-placeholder"><Film size={42} /><strong>Recording will be available when the Playwright worker is connected.</strong><span>No browser session or real Oracle account was accessed.</span></div>}<div className="timeline"><div><span className="timeline-dot cyan" /><b>Login validation</b><small>Read-only</small></div><div><span className="timeline-dot violet" /><b>Authentication result</b><small>{recording?.status || 'Unavailable'}</small></div><div><span className="timeline-dot orange" /><b>Timesheet changes</b><small>None</small></div></div></motion.div></motion.div> }
function Reports({ navigate }: { navigate: (p: Page) => void }) {
  const [runs, setRuns] = useState<Run[]>([])
  useEffect(() => {
    fetch('http://localhost:8787/api/runs')
      .then((response) => (response.ok ? response.json() : []))
      .then(setRuns)
      .catch(() => setRuns([]))
  }, [])
  const totalCases = runs.reduce((sum, r) => sum + r.total, 0)
  const totalPassed = runs.reduce((sum, r) => sum + r.passed, 0)
  const totalFailed = runs.reduce((sum, r) => sum + r.failed, 0)
  const passRate = totalCases > 0 ? Math.round((totalPassed / totalCases) * 100) : 0
  const chartData = runs.map((r) => ({
    name: r.id.slice(-8),
    passed: r.passed,
    partial: r.status === 'Partial' ? r.failed : 0,
    failed: r.status === 'Partial' ? 0 : r.failed,
  }))
  const partialRunCases = runs.filter((r) => r.status === 'Partial').reduce((s, r) => s + r.failed, 0)
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader eyebrow="ANALYTICS" title="Reports" description="Reports are generated from persisted automation results." />
      <div className="metric-grid">
        <Metric icon={FileSpreadsheet} label="Total runs" value={String(runs.length)} trend="Persisted executions" color="violet" />
        <Metric icon={CheckCircle2} label="Passed cases" value={String(totalPassed)} trend={totalCases ? `${passRate}% pass rate` : 'No results yet'} color="cyan" />
        <Metric icon={AlertTriangle} label="Failed cases" value={String(totalFailed)} trend={totalCases ? `${Math.round((totalFailed / totalCases) * 100)}% failure rate` : 'No results yet'} color="orange" />
        <Metric icon={Clock3} label="Runs" value={String(runs.length)} trend="Total executed" color="blue" />
      </div>
      <section className="card report-chart">
        <div className="card-heading">
          <div><h2>Results by run</h2><p>Passed / Partial / Failed breakdown</p></div>
        </div>
        <div className="chart-wrap">
          {runs.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="passed" fill="#22c55e" radius={[4, 4, 0, 0]} stackId="a" />
                <Bar dataKey="partial" fill="#f59e0b" radius={[4, 4, 0, 0]} stackId="a" />
                <Bar dataKey="failed" fill="#ef4444" radius={[4, 4, 0, 0]} stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-recordings"><BarChart3 size={28} /><strong>No report data yet</strong><span>Process a CSV to populate reports from PostgreSQL.</span></div>
          )}
        </div>
      </section>
      <section className="card report-chart">
        <div className="card-heading">
          <div><h2>Overall distribution</h2><p>Case outcomes across all runs</p></div>
        </div>
        <div className="chart-wrap">
          {totalCases > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={[
                    { name: 'Passed', value: totalPassed },
                    { name: 'Partial', value: partialRunCases },
                    { name: 'Failed', value: Math.max(0, totalFailed - partialRunCases) },
                  ]}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  <Cell fill="#22c55e" />
                  <Cell fill="#f59e0b" />
                  <Cell fill="#ef4444" />
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-recordings"><BarChart3 size={28} /><strong>No report data yet</strong><span>Process a CSV to populate reports from PostgreSQL.</span></div>
          )}
        </div>
      </section>
      <section className="card runs-card">
        <div className="card-heading">
          <div><h2>Recent runs</h2><p>Last 10 executed test runs</p></div>
          <button className="text-button" onClick={() => navigate('runs')}>View all <ArrowUpRight size={14} /></button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Run ID</th><th>CSV filename</th><th>Cases</th><th>Passed</th><th>Failed</th><th>Status</th></tr>
            </thead>
            <tbody>
              {runs.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id.slice(-12)}</td>
                  <td>{r.file}</td>
                  <td>{r.total}</td>
                  <td className="success-text">{r.passed}</td>
                  <td className="danger-text">{r.failed}</td>
                  <td><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </motion.div>
  )
}
function SettingsPage() { return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><PageHeader eyebrow="CONFIGURATION" title="Settings" description="Manage demo preferences. Real credentials are never stored here." /><div className="settings-grid"><section className="card settings-section"><h2>General</h2><p>Customize how Chronos looks and behaves.</p><label>Product name<input defaultValue="Chronos" /></label><label>Default date range<select><option>Last 7 days</option><option>Last 30 days</option></select></label><label>Theme preference<select><option>Dark (current)</option></select></label></section><section className="card settings-section"><h2>Automation preferences</h2><p>Defaults for simulated runs.</p><label>Default browser<select><option>Chromium</option></select></label><label>Recording preference<select><option>Capture when enabled</option><option>Always off</option></select></label><label>Retry count<select><option>2 retries</option><option>1 retry</option></select></label></section><section className="card settings-section"><h2>Oracle application</h2><p>Connection is reserved for a future backend.</p><label>Demo application URL<input defaultValue="https://demo.oracle-app.invalid" /></label><div className="connection-status"><span className="status-circle" />Not connected</div><div className="security-note"><ShieldCheck size={15} /> Credentials and authentication will be handled securely by the backend.</div></section><section className="card settings-section"><h2>Security & data</h2><p>Your local preview remains in memory only.</p><div className="security-list"><div><ShieldCheck size={16} /><span><strong>No credential persistence</strong><small>Passwords are never rendered, logged, or saved.</small></span></div><div><FileSpreadsheet size={16} /><span><strong>Local file retention</strong><small>Clearing the workflow removes raw CSV data.</small></span></div></div><button className="button button-danger">Clear demo data</button></section></div></motion.div> }

export default App
