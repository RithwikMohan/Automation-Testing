import { useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity, AlertTriangle, Archive, ArrowUpRight, BarChart3, Bell, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, CloudUpload, Compass, Copy, Edit3, ExternalLink, FileSpreadsheet, Film, GitBranch, Globe, Info, KeyRound, LayoutDashboard, List, Loader2, Menu, Play, Plus, Search, Settings as SettingsIcon, ShieldCheck, Sparkles, Tag, TrendingDown, TrendingUp, Upload, X, Zap } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { getRegisteredBaseUrl, MISSING_BASE_URL_MESSAGE } from './explorationTarget'
import { WorkflowBuilderModal } from './WorkflowBuilder'

type Page = 'overview' | 'upload' | 'runs' | 'run-detail' | 'recordings' | 'reports' | 'settings' | 'applications' | 'create-automation' | 'automations' | 'task-planner' | 'browser-tests' | 'hcm-hiring'
type Status = 'Passed' | 'Failed' | 'Running' | 'Pending' | 'Partial'
type Validation = 'READY' | 'INVALID' | 'PROJECT MISMATCH' | 'EXCEEDS LIMIT' | 'NEEDS DATA' | 'UPDATED' | 'UPDATE FAILED' | 'UPDATE IN PROGRESS' | 'VERIFICATION FAILED'
type Row = { id: string; username: string; date: string; hours: number; workdescription: string; existing: number | null; validation: Validation; error?: string }
type RunCase = { row_number: number; case_id: string | null; username_masked: string | null; requested_date: string | null; project: string | null; requested_hours: number | null; status: string; message: string | null; current_hours: number | null; updated_hours: number | null; artifacts?: RunArtifact[] }
type RunArtifact = { kind: string; content_type: string; url: string }
type Run = { id: string; file: string; created: string; total: number; passed: number; failed: number; skipped: number; duration: string; status: Status; cases?: RunCase[]; artifacts?: RunArtifact[] }

// Phase 1 types
type Application = {
  id: string
  name: string
  base_url: string
  approved_resource_origins?: string[]
  approved_navigation_origins?: string[]
  description: string | null
  category: string | null
  environment: string
  auth_method: string
  credential_ref: string | null
  login_url: string | null
  notes: string | null
  status: string
  created_at: string
  updated_at: string
  task_count: number
}
type AutomationDefinition = {
  id: string
  application_id: string
  name: string
  description: string | null
  task_category: string
  task_instruction: string
  preconditions: Array<string | { id?: string; text: string }>
  expected_results: Array<string | { id?: string; text: string }>
  safety_settings: { read_only_preferred?: boolean; require_approval?: boolean; stop_on_ambiguity?: boolean; max_actions?: number }
  status: string
  created_at: string
  updated_at: string
  application_name?: string
}
type PlannedAction = { action: 'navigate_registered_app' | 'inspect_page' | 'find_visible_element' | 'extract_text' | 'verify_element'; description?: string }
type TaskPlan = { applicationId: string; applicationName: string; registeredBaseUrl: string; purpose: string; actions: PlannedAction[]; status: 'REVIEW_REQUIRED' }

type ExplorationResult = {
  id: string
  application_id: string
  target_url: string
  status: 'SUCCESS' | 'AUTH_REQUIRED' | 'SECURITY_BLOCKED' | 'TIMEOUT' | 'FAILED'
  title: string | null
  meta_description: string | null
  headings: Array<{ level: number; text: string }>
  links: Array<{ text: string; href: string; isSameOrigin: boolean }>
  forms: Array<{ action: string | null; method: string; fieldCount: number; fields: Array<{ name: string; type: string; placeholder?: string }>; hasPasswordField: boolean }>
  interactive_elements: { buttonCount: number; linkCount: number; inputCount: number; selectCount: number }
  auth_detected: boolean
  warnings: Array<string | { outcome: string; hostname?: string | null; port?: number | null; category?: string; topLevelNavigation?: boolean; reason?: string; explicitResourceEntryNeeded?: boolean }>
  audit_summary?: { mainDocumentStatus?: number | null; allowedResources?: number; blockedResources?: number; blockedByReason?: Record<string, number>; mainDocumentInspectable?: boolean; partial?: boolean }
  auditSummary?: { mainDocumentStatus?: number | null; allowedResources?: number; blockedResources?: number; blockedByReason?: Record<string, number>; mainDocumentInspectable?: boolean; partial?: boolean }
  duration_ms: number | null
  created_at: string
}

const ENVIRONMENTS = ['Development', 'Testing', 'Staging', 'Production']
const AUTH_METHODS = ['none', 'manual', 'credential_reference', 'other']
const APP_CATEGORIES = ['Productivity', 'E-commerce', 'Finance', 'Internal Tool', 'CRM', 'ERP', 'Development', 'HR', 'Support', 'Other']
const TASK_CATEGORIES = ['Navigation', 'Form filling', 'Data extraction', 'Data validation', 'Record creation', 'Record update', 'Search', 'Custom task']
const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787').replace(/\/$/, '')

const chartData: { day: string; passed: number; failed: number }[] = []
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'applications', label: 'Applications', icon: Globe },
  { id: 'browser-tests', label: 'Workflow Tests', icon: CheckCircle2 },
  { id: 'recordings', label: 'Recordings', icon: Film },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
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
function Metric({
  icon: Icon,
  label,
  value,
  trend,
  color,
}: {
  icon: typeof Activity
  label: string
  value: string
  trend: string
  color: string
}) {
  const colorGradients: Record<string, { bg: string; border: string; glow: string; text: string; iconBg: string }> = {
    violet: {
      bg: 'linear-gradient(135deg, rgba(155, 124, 255, 0.08) 0%, rgba(13, 20, 36, 0.95) 100%)',
      border: 'rgba(155, 124, 255, 0.25)',
      glow: 'rgba(155, 124, 255, 0.15)',
      text: '#c4b5fd',
      iconBg: 'rgba(155, 124, 255, 0.15)',
    },
    cyan: {
      bg: 'linear-gradient(135deg, rgba(33, 212, 216, 0.08) 0%, rgba(13, 20, 36, 0.95) 100%)',
      border: 'rgba(33, 212, 216, 0.25)',
      glow: 'rgba(33, 212, 216, 0.15)',
      text: '#21d4d8',
      iconBg: 'rgba(33, 212, 216, 0.15)',
    },
    orange: {
      bg: 'linear-gradient(135deg, rgba(244, 63, 94, 0.08) 0%, rgba(13, 20, 36, 0.95) 100%)',
      border: 'rgba(244, 63, 94, 0.25)',
      glow: 'rgba(244, 63, 94, 0.15)',
      text: '#fb7185',
      iconBg: 'rgba(244, 63, 94, 0.15)',
    },
    blue: {
      bg: 'linear-gradient(135deg, rgba(59, 130, 246, 0.08) 0%, rgba(13, 20, 36, 0.95) 100%)',
      border: 'rgba(59, 130, 246, 0.25)',
      glow: 'rgba(59, 130, 246, 0.15)',
      text: '#60a5fa',
      iconBg: 'rgba(59, 130, 246, 0.15)',
    },
    emerald: {
      bg: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(13, 20, 36, 0.95) 100%)',
      border: 'rgba(16, 185, 129, 0.25)',
      glow: 'rgba(16, 185, 129, 0.15)',
      text: '#34d399',
      iconBg: 'rgba(16, 185, 129, 0.15)',
    },
  }

  const theme = colorGradients[color] || colorGradients.cyan

  return (
    <motion.div
      whileHover={{ y: -4, borderColor: theme.text, boxShadow: `0 12px 28px ${theme.glow}` }}
      transition={{ duration: 0.2 }}
      className="metric card luxury-metric-card"
      style={{
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        borderRadius: 14,
        padding: '22px 24px',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: 140,
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.35)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -20,
          right: -20,
          width: 90,
          height: 90,
          borderRadius: '50%',
          background: theme.glow,
          filter: 'blur(28px)',
          pointerEvents: 'none',
        }}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#94a3b8',
          }}
        >
          {label}
        </span>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: theme.iconBg,
            border: `1px solid ${theme.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: theme.text,
            boxShadow: `0 2px 10px ${theme.glow}`,
          }}
        >
          <Icon size={19} />
        </div>
      </div>

      <div style={{ margin: '14px 0 10px 0', position: 'relative', zIndex: 1 }}>
        <div
          style={{
            fontSize: 34,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            color: '#f8fafc',
            lineHeight: 1.1,
          }}
        >
          {value}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative', zIndex: 1 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '4px 10px',
            borderRadius: 6,
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            fontSize: 12,
            fontWeight: 600,
            color: theme.text,
          }}
        >
          <ArrowUpRight size={13} />
          <span>{trend}</span>
        </div>
      </div>
    </motion.div>
  )
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) { return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div> }

function App() {
  const [page, setPage] = useState<Page>('overview')
  const [editingDefinition, setEditingDefinition] = useState<AutomationDefinition | null>(null)
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
    fetch(`${API}/api/runs`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Unable to load persisted runs.')))
      .then(setRuns)
      .catch(error => console.error(error))
    fetch(`${API}/api/config`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Unable to load automation configuration.')))
      .then(config => setAutoUpdateOnUpload(config.auto_update_on_upload === true))
      .catch(error => console.error(error))
  }, [])

  const navigate = (next: Page) => { if (next !== 'create-automation') setEditingDefinition(null); setPage(next); setSidebarOpen(false) }
  const refreshRuns = async () => {
    const response = await fetch(`${API}/api/runs`)
    if (!response.ok) throw new Error('Unable to refresh persisted runs.')
    setRuns(await response.json())
  }
  const processUpload = async (sourceCsv = csvText, sourceFileName = fileName) => {
    if (!sourceCsv || isProcessing) return
    setIsProcessing(true)
    try {
      const response = await fetch(`${API}/api/v1/oracle/timesheet/update`, {
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
        return { ...row, existing: currentHours, validation: item.status as Validation, error: item.message }
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
      if (autoUpdateOnUpload) { window.setTimeout(() => processUpload(text, file.name), 0) }
    } })
  }
  const validateReadOnly = async () => {
    if (!csvText || isReadOnlyValidating) return
    setIsReadOnlyValidating(true)
    try {
      const response = await fetch(`${API}/api/v1/oracle/timesheet/read-batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csvText }) })
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

  const activeNavId = page === 'run-detail' ? 'runs' : page

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Zap size={18} fill="currentColor" /></div><span>chronos</span><span className="brand-pill">BETA</span></div>
      <div className="workspace-switcher"><div className="workspace-avatar">D</div><div><small>WORKSPACE</small><strong>Demo environment</strong></div><ChevronDown size={15} /></div>
      <nav>{nav.map(item => <button key={item.id} className={activeNavId === item.id ? 'nav-item active' : 'nav-item'} onClick={() => navigate(item.id as Page)}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className="health"><span className="pulse-dot" />All systems nominal</div><div className="version">CHRONOS V0.1.0 · BETA</div></div>
    </aside>
    <main className="main">
      <header className="topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu /></button><div className="crumb"><span>Demo Environment</span><ChevronRight size={14} /><strong>{page === 'run-detail' ? 'Run details' : nav.find(n => n.id === page)?.label}</strong></div><div className="top-actions"><div className="top-search"><Search size={16} /><input placeholder="Search anything..." /></div><button className="icon-button"><Bell size={18} /><span className="notification-dot" /></button><div className="top-user"><div className="user-avatar">RM</div><div><strong>Rithwik</strong><small>Administrator</small></div><ChevronDown size={14} /></div></div></header>
      <div className="content">
        <AnimatePresence mode="wait">
          {page === 'overview' && <Overview navigate={navigate} runs={runs} />}
          {page === 'applications' && <ApplicationsPage navigate={navigate} />}
          {page === 'create-automation' && <CreateAutomationPage navigate={navigate} definition={editingDefinition} />}
          {page === 'automations' && <AutomationsPage navigate={navigate} onEdit={definition => { setEditingDefinition(definition); navigate('create-automation') }} />}
          {page === 'task-planner' && <TaskPlannerPage />}
          {page === 'browser-tests' && <BrowserTestsPage />}
          {page === 'hcm-hiring' && <OracleHcmHiringPage />}
          {page === 'upload' && <UploadPage rows={rows} fileName={fileName} fileRef={fileRef} selectFile={selectFile} setRows={setRows} setFileName={setFileName} validRows={validRows.length} processUpload={processUpload} isProcessing={isProcessing} validateReadOnly={validateReadOnly} isReadOnlyValidating={isReadOnlyValidating} autoUpdateOnUpload={autoUpdateOnUpload} />}
          {page === 'runs' && <RunsPage runs={filteredRuns} search={search} setSearch={setSearch} openRun={(run) => { setSelectedRun(run); navigate('run-detail') }} />}
          {page === 'run-detail' && selectedRun && <RunDetails run={selectedRun} back={() => navigate('runs')} />}
          {page === 'recordings' && <Recordings open={(recording) => { setSelectedRecording(recording); setRecordingOpen(true) }} />}
          {page === 'reports' && <Reports navigate={navigate} />}
          {page === 'settings' && <SettingsPage />}
        </AnimatePresence>
      </div>
    </main>
    <AnimatePresence>{recordingOpen && <VideoModal recording={selectedRecording} close={() => { setRecordingOpen(false); setSelectedRecording(undefined) }} />}</AnimatePresence>
  </div>
}

/* ============================================================
   PHASE 1: APPLICATIONS PAGE
   ============================================================ */

function authMethodLabel(m: string) {
  const map: Record<string, string> = { none: 'No auth', manual: 'Manual login', credential_reference: 'Credential ref', other: 'Other' }
  return map[m] || m
}
function envColor(e: string) {
  const map: Record<string, string> = { Production: 'orange', Staging: 'amber', Testing: 'cyan', Development: 'violet' }
  return map[e] || 'blue'
}

function ExplorationModal({ app, onClose }: { app: Application | null; onClose: () => void }) {
  const registeredBaseUrl = app ? getRegisteredBaseUrl(app) : ''
  const [targetUrl, setTargetUrl] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ExplorationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ExplorationResult[]>([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  useEffect(() => {
    if (app) {
      setTargetUrl(registeredBaseUrl)
      setResult(null)
      setError(null)
      setLoadingHistory(true)
      fetch(`${API}/api/v1/applications/${app.id}/explorations`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setHistory)
        .catch(() => {})
        .finally(() => setLoadingHistory(false))
    }
  }, [app, registeredBaseUrl])

  if (!app) return null

  const run = async () => {
    if (!registeredBaseUrl) {
      setError(MISSING_BASE_URL_MESSAGE)
      return
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`${API}/api/v1/applications/${app.id}/explore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetUrl: targetUrl.trim() || registeredBaseUrl }),
      })
      const data = await res.json()
      if (!res.ok && !data.status) {
        throw new Error(data.error || 'Exploration failed.')
      }
      setResult(data)
      fetch(`${API}/api/v1/applications/${app.id}/explorations`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setHistory)
        .catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Exploration failed.')
    } finally {
      setRunning(false)
    }
  }

  const badgeClass = (st: string) => {
    if (st === 'SUCCESS') return 'exploration-badge-success'
    if (st === 'AUTH_REQUIRED') return 'exploration-badge-auth'
    if (st === 'SECURITY_BLOCKED') return 'exploration-badge-blocked'
    if (st === 'PARTIAL') return 'exploration-badge-partial'
    return 'exploration-badge-timeout'
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} className="modal-panel modal-panel-wide card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <div className="eyebrow">PHASE 2.1 BROWSER EXPLORATION</div>
            <h2>Inspect {app.name}</h2>
          </div>
          <button className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="info-banner exploration-active" style={{ marginBottom: 14 }}>
          <ShieldCheck size={16} />
          <span><strong>Strictly Read-Only Inspection.</strong> Navigates through an enforced outbound proxy. Blocks loopback, private networks, cloud metadata, non-standard ports, and redirects. Never submits forms or modifies data.</span>
        </div>

        <div className="form-group" style={{ marginBottom: 14 }}>
          <label>Target navigation URL (primary origin or explicitly approved navigation origin)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder={registeredBaseUrl || 'Add a Base URL to this application first'}
              disabled={running || !registeredBaseUrl}
            />
            <button
              className="button button-primary"
              onClick={run}
              disabled={running || !registeredBaseUrl}
              style={{ minWidth: 160 }}
            >
              {running ? <><Loader2 size={15} className="spin" /> Inspecting…</> : <><Compass size={15} /> Inspect Website</>}
            </button>
          </div>
          {!registeredBaseUrl && <span className="field-error">{MISSING_BASE_URL_MESSAGE}</span>}
        </div>

        {error && (
          <div className="info-banner info-banner-error" style={{ marginBottom: 14 }}>
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        {/* Live Exploration Result */}
        {result && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ marginTop: 16 }}>
            <div className="exploration-meta-bar">
              <div>Status: <span className={`badge ${badgeClass(result.status)}`}>{result.status}</span></div>
              {result.duration_ms !== null && <div>Duration: <strong>{result.duration_ms}ms</strong></div>}
              {result.title && <div>Page Title: <strong>{result.title}</strong></div>}
              {result.auth_detected && (
                <div style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <KeyRound size={14} /> <strong>Auth Required / Login Detected</strong>
                </div>
              )}
            </div>

            {/* Warnings if any */}
            {result.warnings && result.warnings.length > 0 && (
              <div className="exploration-warning-box">
                <strong>Security & Network Audit:</strong>
                {(result.auditSummary || result.audit_summary) && <div>Main document: {(result.auditSummary || result.audit_summary)?.mainDocumentStatus ?? 'unavailable'} · Allowed requests: {(result.auditSummary || result.audit_summary)?.allowedResources ?? 0} · Blocked requests: {(result.auditSummary || result.audit_summary)?.blockedResources ?? 0}{(result.auditSummary || result.audit_summary)?.partial ? ' · Partial inspection' : ''}</div>}
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {result.warnings.map((w, idx) => <li key={idx}>{typeof w === 'string' ? w : `${w.outcome}: ${w.hostname || 'unknown host'}${w.port ? `:${w.port}` : ''} (${w.category || 'unknown'}${w.topLevelNavigation ? ', top-level navigation' : ''})${w.reason ? ` — ${w.reason}` : ''}${w.explicitResourceEntryNeeded ? ' — explicit resource origin approval required' : ''}`}</li>)}
                </ul>
              </div>
            )}

            {/* Metrics */}
            <div className="exploration-stat-grid">
              <div className="exploration-stat-card">
                <div className="exploration-stat-label">Buttons</div>
                <div className="exploration-stat-value">{result.interactive_elements?.buttonCount || 0}</div>
              </div>
              <div className="exploration-stat-card">
                <div className="exploration-stat-label">Links Found</div>
                <div className="exploration-stat-value">{result.interactive_elements?.linkCount || result.links?.length || 0}</div>
              </div>
              <div className="exploration-stat-card">
                <div className="exploration-stat-label">Form Inputs</div>
                <div className="exploration-stat-value">{result.interactive_elements?.inputCount || 0}</div>
              </div>
              <div className="exploration-stat-card">
                <div className="exploration-stat-label">Forms</div>
                <div className="exploration-stat-value">{result.forms?.length || 0}</div>
              </div>
            </div>

            {/* Headings */}
            {result.headings && result.headings.length > 0 && (
              <div className="exploration-details-group">
                <div className="exploration-details-title"><List size={14} /> Page Headings ({result.headings.length})</div>
                <div className="exploration-item-list">
                  {result.headings.map((h, i) => (
                    <div key={i} className="exploration-item-row">
                      <span>{h.text}</span>
                      <span className="tag-badge">H{h.level}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Forms detected */}
            {result.forms && result.forms.length > 0 && (
              <div className="exploration-details-group">
                <div className="exploration-details-title"><FileSpreadsheet size={14} /> Forms Detected ({result.forms.length})</div>
                <div className="exploration-item-list">
                  {result.forms.map((f, i) => (
                    <div key={i} className="exploration-item-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span className="tag-badge">{f.method}</span>
                        <span>Action: <code>{f.action || '(self)'}</code></span>
                        {f.hasPasswordField && <span className="tag-badge" style={{ color: '#fbbf24', borderColor: '#d97706' }}>Password Input</span>}
                      </div>
                      {f.fields && f.fields.length > 0 && (
                        <div style={{ fontSize: 11, color: '#64748b' }}>
                          Fields: {f.fields.map((fld) => `${fld.name} (${fld.type})`).join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Discovered Links */}
            {result.links && result.links.length > 0 && (
              <div className="exploration-details-group">
                <div className="exploration-details-title"><Globe size={14} /> Discovered Links ({result.links.length})</div>
                <div className="exploration-item-list">
                  {result.links.slice(0, 15).map((l, i) => (
                    <div key={i} className="exploration-item-row">
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>{l.text}</span>
                      <span className="tag-badge">{l.isSameOrigin ? 'Same Origin' : 'External'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* Previous Explorations History */}
        <div className="exploration-history-section">
          <div className="exploration-details-title"><Clock3 size={14} /> Prior Exploration History</div>
          {loadingHistory && <div style={{ fontSize: 12, color: '#64748b' }}>Loading history…</div>}
          {!loadingHistory && history.length === 0 && (
            <div style={{ fontSize: 12, color: '#64748b' }}>No prior explorations recorded for this application.</div>
          )}
          {!loadingHistory && history.length > 0 && (
            <div className="exploration-item-list" style={{ maxHeight: 150 }}>
              {history.map((item) => (
                <div key={item.id} className="exploration-item-row" style={{ cursor: 'pointer' }} onClick={() => setResult(item)}>
                  <div>
                    <strong>{item.title || item.target_url}</strong>
                    <div style={{ fontSize: 10, color: '#64748b' }}>{new Date(item.created_at).toLocaleString()} · {item.target_url}</div>
                  </div>
                  <span className={`badge ${badgeClass(item.status)}`}>{item.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}

type WorkflowCapture = { id: string; state: string; currentUrl?: string; workflowName?: string; actions?: Array<{ action: string; url?: string; locator?: { kind: string; role?: string; name?: string; value?: string }; locatorCandidates?: Array<{ kind: string; role?: string; name?: string; value?: string }>; dataKey?: string; credentialInput?: boolean; manualLoginSubmit?: boolean; sequence?: number; pageUrl?: string; element?: { tag?: string; inputType?: string } }>; fields?: Array<{ key: string; label: string; type: string; required?: boolean; credential?: boolean }>; diagnostics?: Array<string> }
function WorkflowCaptureModal({ app, onClose, onSaved }: { app: Application; onClose: () => void; onSaved: () => void }) {
  const [capture, setCapture] = useState<WorkflowCapture | null>(null)
  const captureIdRef = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [targetUrl, setTargetUrl] = useState(app.base_url)
  const [reuseSession, setReuseSession] = useState(false)
  const [reviewName, setReviewName] = useState('')
  const [reviewActions, setReviewActions] = useState<Array<{ captureIndex: number; include: boolean; locatorCandidateIndex: number }>>([])
  const [reviewVariables, setReviewVariables] = useState<Array<{ captureKey: string; key: string; label: string; required: boolean; include: boolean; credential?: boolean }>>([])
  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const poll = async (id: string) => {
      try {
        const response = await fetch(`${API}/api/workflow-recordings/${id}`)
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Unable to read workflow recording.')
        if (!disposed) { setCapture(data); timer = window.setTimeout(() => poll(id), 1000) }
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : 'Unable to read workflow recording.') }
    }
    setBusy(true)
    fetch(`${API}/api/applications/${app.id}/workflow-recordings`, { method: 'POST' })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to open recording browser.'); return data })
      .then((data) => { if (disposed) { fetch(`${API}/api/workflow-recordings/${data.id}`, { method: 'DELETE' }).catch(() => {}); return } captureIdRef.current = data.id; setCapture(data); poll(data.id) })
      .catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Unable to start workflow capture.') })
      .finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true; if (timer) window.clearTimeout(timer); if (captureIdRef.current) fetch(`${API}/api/workflow-recordings/${captureIdRef.current}`, { method: 'DELETE' }).catch(() => {}) }
  }, [app.id])
  const begin = async () => {
    if (!capture) return
    setBusy(true); setError('')
    try { const response = await fetch(`${API}/api/workflow-recordings/${capture.id}/begin`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not begin capture.'); setCapture(data) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not begin capture.') } finally { setBusy(false) }
  }
  const openTarget = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!capture) return
    setBusy(true); setError('')
    try { const response = await fetch(`${API}/api/workflow-recordings/${capture.id}/navigate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: targetUrl }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not open that URL.'); setCapture(data) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open that URL.') } finally { setBusy(false) }
  }
  const setCaptureState = async (operation: 'pause' | 'resume') => {
    if (!capture) return
    setBusy(true); setError('')
    try { const response = await fetch(`${API}/api/workflow-recordings/${capture.id}/${operation}`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `Could not ${operation} capture.`); setCapture(data) }
    catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${operation} capture.`) } finally { setBusy(false) }
  }
  const finish = async () => {
    if (!capture) return
    setBusy(true); setError('')
    try { const response = await fetch(`${API}/api/workflow-recordings/${capture.id}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reuseAuthenticatedSession: reuseSession }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not finish capture.'); setCapture(data); setReviewName(data.workflowName || `${app.name} recorded workflow`); setReviewActions((data.actions || []).map((_action: WorkflowCapture['actions'] extends Array<infer T> ? T : never, captureIndex: number) => ({ captureIndex, include: true, locatorCandidateIndex: 0 }))); setReviewVariables((data.fields || []).map((field: { key: string; label: string; required?: boolean; credential?: boolean }) => ({ captureKey: field.key, key: field.key, label: field.label, required: field.required !== false, include: true, credential: field.credential }))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save workflow.') } finally { setBusy(false) }
  }
  const saveReview = async () => {
    if (!capture) return
    setBusy(true); setError('')
    try { const response = await fetch(`${API}/api/workflow-recordings/${capture.id}/save`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: reviewName, actions: reviewActions, variables: reviewVariables }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not save workflow.'); captureIdRef.current = null; onSaved(); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save workflow.') } finally { setBusy(false) }
  }
  const setReviewVariableIncluded = (index: number, include: boolean) => {
    const variable = reviewVariables[index]
    if (!variable) return
    setReviewVariables((items) => items.map((item, i) => i === index ? { ...item, include } : item))
    if (!include) {
      const dependentActions = new Set((capture?.actions || []).filter((action) => action.dataKey === variable.captureKey).map((_action, captureIndex) => captureIndex))
      setReviewActions((items) => items.map((item) => dependentActions.has(item.captureIndex) ? { ...item, include: false } : item))
    }
  }
  const cancel = async () => { if (captureIdRef.current) { const id = captureIdRef.current; captureIdRef.current = null; await fetch(`${API}/api/workflow-recordings/${id}`, { method: 'DELETE' }).catch(() => {}) } onClose() }
  return <div className="modal-backdrop" onClick={cancel}><motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="modal-panel card" onClick={(event) => event.stopPropagation()}>
    <div className="modal-heading"><div><div className="eyebrow">WORKFLOW RECORDER</div><h2>Record {app.name}</h2></div><button className="icon-button" onClick={cancel}><X size={18} /></button></div>
    {error && <div className="info-banner info-banner-error"><AlertTriangle size={15} /><span>{error}</span></div>}
    <p>Open a public website here or follow links in the capture browser. Public HTTP(S) pages and their resources are checked through the security proxy; private/internal destinations still require explicit application approval. Chronos records field names and locators, never values typed during capture. A password CSV column can be included; values later added to that CSV are stored as test data and must be protected accordingly.</p>
    {capture && capture.state !== 'REVIEW_REQUIRED' && <form onSubmit={openTarget} className="workflow-target-navigation"><label htmlFor="workflow-target-url">Open URL in capture browser</label><div><input id="workflow-target-url" type="url" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://example.com" /><button className="button button-secondary" type="submit" disabled={busy}>Open</button></div></form>}
    {capture?.state === 'WAITING_FOR_MANUAL_LOGIN' && <><div className="browser-test-auth-prompt"><strong>Capture is recording the login workflow.</strong><span>Sign in in the browser, then return here and choose Continue capture after login. Values typed during capture are not stored; the reviewed workflow may add blank username/password columns to the CSV.</span><button className="button button-primary" disabled={busy} onClick={begin}>Continue capture after login</button></div><ol>{capture.actions?.map((action, index) => <li key={index}>{action.sequence || index + 1}. {action.action} · {action.url ? new URL(action.url).pathname : action.locator ? action.locator.name || action.locator.value || action.locator.kind : 'page transition'}{action.dataKey ? ` → ${action.dataKey}` : ''}</li>)}</ol>{capture.diagnostics?.map((diagnostic, index) => <div className="exploration-warning-box" key={index}>{diagnostic}</div>)}</>}
    {(capture?.state === 'CAPTURING' || capture?.state === 'PAUSED') && <><p><strong>{capture.state === 'PAUSED' ? 'Capture paused.' : 'Capture active.'}</strong> Complete the representative workflow, then review it.</p><ol>{capture.actions?.map((action, index) => <li key={index}>{action.sequence || index + 1}. {action.action} · {action.url ? new URL(action.url).pathname : action.locator ? action.locator.name || action.locator.value || action.locator.kind : 'page transition'}{action.dataKey ? ` → ${action.dataKey}` : ''}{action.element?.tag ? ` · ${action.element.tag}` : ''}</li>)}</ol>{capture.diagnostics?.map((diagnostic, index) => <div className="exploration-warning-box" key={index}>{diagnostic}</div>)}<div style={{ display: 'flex', gap: 8 }}><button className="button button-secondary" disabled={busy} onClick={() => setCaptureState(capture.state === 'PAUSED' ? 'resume' : 'pause')}>{capture.state === 'PAUSED' ? 'Resume capture' : 'Pause capture'}</button><button className="button button-primary" disabled={busy || !capture.actions?.length} onClick={finish}>{busy ? 'Finishing…' : 'Finish and review workflow'}</button></div><label className="browser-test-approve-check"><input type="checkbox" checked={reuseSession} onChange={(event) => setReuseSession(event.target.checked)} /> Keep this approved manual login available for test runs for 15 minutes (memory only)</label></>}
    {capture?.state === 'REVIEW_REQUIRED' && <><label>Workflow name<input value={reviewName} maxLength={120} onChange={(event) => setReviewName(event.target.value)} /></label><h3>Review captured actions</h3><div className="workflow-review-list">{reviewActions.map((review, index) => { const action = capture.actions?.[review.captureIndex]; if (!action) return null; return <div className="workflow-review-row" key={review.captureIndex}><label><input type="checkbox" checked={review.include} onChange={(event) => setReviewActions((items) => items.map((item) => item.captureIndex === review.captureIndex ? { ...item, include: event.target.checked } : item))} /> {action.sequence || index + 1}. {action.action}{action.credentialInput ? ' · password field (value not captured)' : action.manualLoginSubmit ? ' · manual login submit' : ''}</label><span>{action.element?.tag || 'element'}{action.pageUrl ? ` · ${new URL(action.pageUrl).pathname}` : action.url ? ` · ${new URL(action.url).pathname}` : ''}</span>{action.action !== 'navigate' && <select aria-label={`Locator for action ${review.captureIndex + 1}`} value={review.locatorCandidateIndex} onChange={(event) => setReviewActions((items) => items.map((item) => item.captureIndex === review.captureIndex ? { ...item, locatorCandidateIndex: Number(event.target.value) } : item))}>{(action.locatorCandidates || (action.locator ? [action.locator] : [])).map((candidate, candidateIndex) => <option key={candidateIndex} value={candidateIndex}>{candidate.kind}: {candidate.name || candidate.value}</option>)}</select>}</div>})}</div><h3>CSV variables</h3>{reviewVariables.map((variable, index) => <div className="workflow-review-row" key={variable.captureKey}><label><input type="checkbox" checked={variable.include} onChange={(event) => setReviewVariableIncluded(index, event.target.checked)} /> Include field</label><input aria-label="CSV column name" disabled={variable.credential} value={variable.key} onChange={(event) => setReviewVariables((items) => items.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} /><input aria-label="Field label" value={variable.label} onChange={(event) => setReviewVariables((items) => items.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} /><label><input type="checkbox" checked={variable.required} onChange={(event) => setReviewVariables((items) => items.map((item, i) => i === index ? { ...item, required: event.target.checked } : item))} /> Required</label></div>)}<div className="field-hint">Password values are not captured. If included, the downloaded CSV contains a blank password column that you fill in yourself. Excluding a field also removes the captured action that fills or selects it.</div><button className="button button-primary" disabled={busy} onClick={saveReview}>{busy ? 'Saving…' : 'Save workflow and generate CSV'}</button></>}
    {busy && !capture && <p>Opening isolated browser…</p>}
    <button className="button button-secondary" onClick={cancel} style={{ marginLeft: 8 }}>Cancel</button>
  </motion.div></div>
}

function ApplicationsPage({ navigate }: { navigate: (p: Page) => void }) {
  const [apps, setApps] = useState<Application[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [envFilter, setEnvFilter] = useState('')
  const [authFilter, setAuthFilter] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [editApp, setEditApp] = useState<Application | null>(null)
  const [detailApp, setDetailApp] = useState<Application | null>(null)
  const [exploreApp, setExploreApp] = useState<Application | null>(null)
  const [captureApp, setCaptureApp] = useState<Application | null>(null)
  const [builderApp, setBuilderApp] = useState<Application | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (envFilter) params.set('environment', envFilter)
      if (authFilter) params.set('authMethod', authFilter)
      const res = await fetch(`${API}/api/applications?${params}`)
      if (!res.ok) { const j = await res.json(); throw new Error(j.error || 'Failed to load applications.') }
      setApps(await res.json())
    } catch (e) { setError(e instanceof Error ? e.message : 'Unknown error') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [search, envFilter, authFilter])

  const archive = async (id: string, name: string) => {
    if (!confirm(`Archive "${name}"? It will be hidden from active lists.`)) return
    try {
      const res = await fetch(`${API}/api/applications/${id}/archive`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error || 'Archive failed.') }
      showToast(`"${name}" archived.`)
      load()
    } catch (e) { alert(e instanceof Error ? e.message : 'Archive failed.') }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader
        eyebrow="APPLICATION REGISTRY"
        title="Applications"
        description="Register and manage target web applications for automation."
        action={<button className="button button-primary" onClick={() => { setEditApp(null); setShowModal(true) }}><Plus size={16} /> Add Application</button>}
      />

      <div className="info-banner exploration-active" role="status">
        <ShieldCheck size={17} />
        <span><strong>Phase 2.1 Outbound Security Boundary Active.</strong> Bounded read-only inspection is enabled with destination domain enforcement, DNS pinning, and strict egress blocking for private networks, cloud metadata, and redirects.</span>
      </div>

      {/* Toolbar */}
      <div className="toolbar card">
        <div className="search-field">
          <Search size={16} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or URL…" />
        </div>
        <select className="filter-select" value={envFilter} onChange={e => setEnvFilter(e.target.value)}>
          <option value="">All environments</option>
          {ENVIRONMENTS.map(e => <option key={e} value={e}>{e}</option>)}
        </select>
        <select className="filter-select" value={authFilter} onChange={e => setAuthFilter(e.target.value)}>
          <option value="">All auth methods</option>
          {AUTH_METHODS.map(a => <option key={a} value={a}>{authMethodLabel(a)}</option>)}
        </select>
      </div>

      {/* Content */}
      {loading && (
        <div className="empty-recordings card"><Loader2 size={28} className="spin" /><strong>Loading applications…</strong></div>
      )}
      {error && (
        <div className="info-banner info-banner-error"><AlertTriangle size={17} /><span>{error}</span><button onClick={load}>Retry</button></div>
      )}
      {!loading && !error && apps.length === 0 && (
        <div className="empty-recordings card">
          <Globe size={36} />
          <strong>No applications registered yet</strong>
          <span>Register a web application to start building automation tasks.</span>
          <button className="button button-primary" style={{ marginTop: 8 }} onClick={() => { setEditApp(null); setShowModal(true) }}><Plus size={16} /> Add Application</button>
        </div>
      )}
      {!loading && !error && apps.length > 0 && (
        <div className="app-grid">
          {apps.map(app => (
            <motion.div key={app.id} whileHover={{ y: -3 }} className="app-card card">
              <div className="app-card-header">
                <div className="app-card-icon"><Globe size={20} /></div>
                <div className="app-card-title">
                  <button className="text-button" onClick={() => setDetailApp(app)}><strong>{app.name}</strong></button>
                  <span className={`env-badge env-${envColor(app.environment)}`}>{app.environment}</span>
                </div>
                <div className="app-card-actions">
                  <button className="icon-button-sm" title="Inspect website (Read-only)" onClick={() => setExploreApp(app)}><Compass size={14} /></button>
                  <button className="icon-button-sm" title="Edit" onClick={() => { setEditApp(app); setShowModal(true) }}><Edit3 size={14} /></button>
                  <button className="icon-button-sm" title="Archive" onClick={() => archive(app.id, app.name)}><Archive size={14} /></button>
                </div>
              </div>
              <span className="app-url"><Globe size={11} />{app.base_url}</span>
              {app.description && <p className="app-desc">{app.description}</p>}
              <div className="app-meta">
                {app.category && <span className="app-tag"><Tag size={11} />{app.category}</span>}
                <span className="app-tag"><ShieldCheck size={11} />{authMethodLabel(app.auth_method)}</span>
                <span className="app-tag"><GitBranch size={11} />{app.task_count} task{app.task_count !== 1 ? 's' : ''}</span>
              </div>
              <div className="app-footer">
                <span className="app-date">Updated {new Date(app.updated_at).toLocaleDateString()}</span>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="text-button" onClick={() => setBuilderApp(app)}><Edit3 size={12} style={{ marginRight: 3 }} /> Workflow builder</button>
                  <button className="text-button" onClick={() => setCaptureApp(app)}><Play size={12} style={{ marginRight: 3 }} /> Record workflow</button>
                  <button className="text-button" onClick={() => setExploreApp(app)}><Compass size={12} style={{ marginRight: 3 }} /> Inspect</button>
                  <button className="text-button" onClick={() => { navigate('create-automation') }}>+ New task</button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* Detail / Toast Modals */}
      <AnimatePresence>
        {detailApp && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={() => setDetailApp(null)}>
            <motion.div initial={{ y: 24 }} animate={{ y: 0 }} exit={{ y: 24 }} className="modal-panel card" onClick={e => e.stopPropagation()}>
              <div className="modal-heading">
                <div>
                  <div className="eyebrow">REGISTERED APPLICATION</div>
                  <h2>{detailApp.name}</h2>
                </div>
                <button className="icon-button" onClick={() => setDetailApp(null)}><X size={18} /></button>
              </div>
              <p><strong>Base URL:</strong> {detailApp.base_url}</p>
              <p><strong>Primary origin:</strong> {(() => { try { return new URL(detailApp.base_url).origin } catch { return detailApp.base_url } })()}</p>
              <p><strong>Approved resource origins:</strong> {(detailApp.approved_resource_origins || []).join(', ') || 'None (primary origin only)'}</p>
              <p><strong>Approved navigation origins:</strong> {(detailApp.approved_navigation_origins || []).join(', ') || 'None (primary origin only)'}</p>
              <p><strong>Environment:</strong> {detailApp.environment} · <strong>Status:</strong> {detailApp.status}</p>
              <p><strong>Authentication:</strong> {authMethodLabel(detailApp.auth_method)}</p>
              {detailApp.credential_ref && <p><strong>Credential reference:</strong> {detailApp.credential_ref}</p>}
              {detailApp.login_url && <p><strong>Login URL:</strong> {detailApp.login_url}</p>}
              {detailApp.category && <p><strong>Category:</strong> {detailApp.category}</p>}
              {detailApp.description && <p><strong>Description:</strong> {detailApp.description}</p>}
              {detailApp.notes && <p><strong>Notes:</strong> {detailApp.notes}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button className="button button-secondary" onClick={() => { const selected = detailApp; setDetailApp(null); setExploreApp(selected) }}>
                  <Compass size={14} /> Inspect website
                </button>
                <button className="button button-primary" onClick={() => { const selected = detailApp; setDetailApp(null); setEditApp(selected); setShowModal(true) }}>
                  Edit application
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
        {toast && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="toast">
            <CheckCircle2 size={16} /> {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Edit Form Modal */}
      <AnimatePresence>
        {showModal && (
          <AppFormModal
            app={editApp}
            onClose={() => setShowModal(false)}
            onSaved={() => { setShowModal(false); load(); showToast(editApp ? 'Application updated.' : 'Application registered.') }}
          />
        )}
      </AnimatePresence>

      {/* Phase 2.1 Exploration Modal */}
      <AnimatePresence>
        {exploreApp && (
          <ExplorationModal
            app={exploreApp}
            onClose={() => setExploreApp(null)}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>{captureApp && <WorkflowCaptureModal app={captureApp} onClose={() => setCaptureApp(null)} onSaved={() => showToast('Workflow saved. Download its CSV template in Rule-Based Tests.')} />}</AnimatePresence>
      <AnimatePresence>{builderApp && <WorkflowBuilderModal application={builderApp} onClose={() => setBuilderApp(null)} onOpenTests={() => { window.localStorage.setItem('chronos-workflow-application', builderApp.id); setBuilderApp(null); navigate('browser-tests') }} />}</AnimatePresence>
    </motion.div>
  )
}

function AppFormModal({ app, onClose, onSaved }: { app: Application | null; onClose: () => void; onSaved: () => void }) {
  const [originAudit, setOriginAudit] = useState<Array<{ origin_kind: string; action: string; origin: string; created_at: string }>>([])
  const [form, setForm] = useState({
    name: app?.name ?? '',
    baseUrl: app?.base_url ?? '',
    description: app?.description ?? '',
    category: app?.category ?? '',
    environment: app?.environment ?? 'Development',
    authMethod: app?.auth_method ?? 'none',
    credentialRef: app?.credential_ref ?? '',
    loginUrl: app?.login_url ?? '',
    notes: app?.notes ?? '',
    resourceOrigins: (app?.approved_resource_origins ?? []).join('\n'),
    navigationOrigins: (app?.approved_navigation_origins ?? []).join('\n'),
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

  useEffect(() => {
    if (!app) return
    fetch(`${API}/api/applications/${app.id}/origin-audit`).then((response) => response.ok ? response.json() : []).then(setOriginAudit).catch(() => setOriginAudit([]))
  }, [app])

  const set = (k: string, v: string) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => { const n = { ...e }; delete n[k]; return n }) }

  const clientValidate = () => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Name is required.'
    else if (form.name.trim().length > 100) e.name = 'Name must be ≤ 100 characters.'
    if (!form.baseUrl.trim()) e.baseUrl = 'Base URL is required.'
    else { try { const u = new URL(form.baseUrl.trim()); if (u.protocol !== 'http:' && u.protocol !== 'https:') e.baseUrl = 'Must be http or https.' } catch { e.baseUrl = 'Invalid URL format.' } }
    if (form.loginUrl.trim()) { try { const u = new URL(form.loginUrl.trim()); if (u.protocol !== 'http:' && u.protocol !== 'https:') e.loginUrl = 'Must be http or https.' } catch { e.loginUrl = 'Invalid URL format.' } }
    return e
  }

  const save = async () => {
    const e = clientValidate()
    if (Object.keys(e).length) { setErrors(e); return }
    setSaving(true); setApiError(null)
    try {
      const body = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        description: form.description.trim() || undefined,
        category: form.category || undefined,
        environment: form.environment,
        authMethod: form.authMethod,
        credentialRef: form.credentialRef.trim() || undefined,
        loginUrl: form.loginUrl.trim() || undefined,
        notes: form.notes.trim() || undefined,
        approvedResourceOrigins: form.resourceOrigins.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
        approvedNavigationOrigins: form.navigationOrigins.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      }
      const url = app ? `${API}/api/applications/${app.id}` : `${API}/api/applications`
      const method = app ? 'PATCH' : 'POST'
      const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed.')
      onSaved()
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Save failed.')
    } finally { setSaving(false) }
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={onClose}>
      <motion.div initial={{ y: 24 }} animate={{ y: 0 }} exit={{ y: 24 }} className="modal-panel card" onClick={e => e.stopPropagation()}>
        <div className="modal-heading">
          <div><div className="eyebrow">{app ? 'EDIT' : 'REGISTER'} APPLICATION</div><h2>{app ? `Edit: ${app.name}` : 'Add Application'}</h2></div>
          <button className="icon-button" onClick={onClose}><X size={18} /></button>
        </div>

        {apiError && <div className="info-banner info-banner-error"><AlertTriangle size={15} /><span>{apiError}</span></div>}

        <div className="form-grid">
          <div className="form-group form-full">
            <label>Application name <span className="required">*</span></label>
            <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Oracle HCM, Salesforce CRM" maxLength={100} />
            {errors.name && <span className="field-error">{errors.name}</span>}
          </div>
          <div className="form-group form-full">
            <label>Base URL <span className="required">*</span></label>
            <input value={form.baseUrl} onChange={e => set('baseUrl', e.target.value)} placeholder="https://app.example.com" />
            <div className="field-hint">Primary origin: {(() => { try { return new URL(form.baseUrl).origin } catch { return 'Enter a valid base URL' } })()}</div>
            {errors.baseUrl && <span className="field-error">{errors.baseUrl}</span>}
          </div>
          <div className="form-group form-full">
            <label>Approved resource origins</label>
            <textarea value={form.resourceOrigins} onChange={e => set('resourceOrigins', e.target.value)} placeholder={'https://static.example-cdn.com\nhttps://fonts.example.net'} rows={3} />
            <div className="field-hint">One HTTP or HTTPS origin per line. Allows page resources only; it does not allow navigation. Observed hosts are never approved automatically.</div>
          </div>
          <div className="form-group form-full">
            <label>Approved top-level navigation origins</label>
            <textarea value={form.navigationOrigins} onChange={e => set('navigationOrigins', e.target.value)} placeholder="https://login.identity-provider.example" rows={2} />
            <div className="field-hint">Use only for explicitly reviewed authentication or application navigation redirects. This permission is separate from resource origins.</div>
          </div>
          <div className="form-group">
            <label>Environment <span className="required">*</span></label>
            <select value={form.environment} onChange={e => set('environment', e.target.value)}>
              {ENVIRONMENTS.map(env => <option key={env} value={env}>{env}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Auth method <span className="required">*</span></label>
            <select value={form.authMethod} onChange={e => set('authMethod', e.target.value)}>
              {AUTH_METHODS.map(a => <option key={a} value={a}>{authMethodLabel(a)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Category</label>
            <select value={form.category} onChange={e => set('category', e.target.value)}>
              <option value="">— Select category —</option>
              {APP_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Login URL <span className="muted-label">(optional)</span></label>
            <input value={form.loginUrl} onChange={e => set('loginUrl', e.target.value)} placeholder="https://app.example.com/login" />
            {errors.loginUrl && <span className="field-error">{errors.loginUrl}</span>}
          </div>
          {form.authMethod === 'credential_reference' && (
            <div className="form-group form-full">
              <label>Credential reference <span className="muted-label">(opaque ID — no passwords)</span></label>
              <input value={form.credentialRef} onChange={e => set('credentialRef', e.target.value)} placeholder="e.g. vault/oracle-hcm-prod" />
              <div className="field-hint"><ShieldCheck size={12} /> Raw credentials are never stored. Provide only an opaque reference ID.</div>
            </div>
          )}
          <div className="form-group form-full">
            <label>Description <span className="muted-label">(optional)</span></label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)} placeholder="Brief description of this application…" rows={2} />
          </div>
          <div className="form-group form-full">
            <label>Notes <span className="muted-label">(optional)</span></label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Internal notes, special configuration, quirks…" rows={2} />
          </div>
        </div>

        {app && <section className="exploration-history-section" style={{ marginTop: 12 }}>
          <strong>Origin approval audit</strong>
          {originAudit.length === 0 ? <div className="field-hint">No origin approval changes recorded.</div> : <div className="exploration-item-list" style={{ maxHeight: 130 }}>
            {originAudit.map((entry, index) => <div className="exploration-item-row" key={`${entry.created_at}-${index}`}>
              <span>{entry.action === 'added' ? 'Added' : 'Removed'} {entry.origin_kind} origin: <code>{entry.origin}</code></span>
              <span className="tag-badge">{new Date(entry.created_at).toLocaleString()}</span>
            </div>)}
          </div>}
        </section>}

        <div className="modal-footer">
          <button className="button button-secondary" onClick={onClose}>Cancel</button>
          <button className="button button-primary" onClick={save} disabled={saving}>
            {saving ? <><Loader2 size={15} className="spin" /> Saving…</> : (app ? 'Update Application' : 'Register Application')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function TaskPlannerPage() {
  const [apps, setApps] = useState<Application[]>([])
  const [appsLoading, setAppsLoading] = useState(true)
  const [applicationId, setApplicationId] = useState('')
  const [instruction, setInstruction] = useState('')
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API}/api/applications`)
      .then(async response => {
        if (!response.ok) throw new Error('Unable to load registered applications.')
        return response.json() as Promise<Application[]>
      })
      .then(setApps)
      .catch(e => setError(e instanceof Error ? e.message : 'Unable to load registered applications.'))
      .finally(() => setAppsLoading(false))
  }, [])

  const generatePlan = async () => {
    if (!applicationId) { setError('Select a registered application.'); return }
    if (!instruction.trim()) { setError('Enter a task instruction.'); return }
    setLoading(true)
    setError(null)
    setPlan(null)
    setDecision(null)
    try {
      const response = await fetch(`${API}/api/applications/${applicationId}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Unable to generate a task plan.')
      setPlan(result as TaskPlan)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to generate a task plan.')
    } finally {
      setLoading(false)
    }
  }

  const actionLabel: Record<PlannedAction['action'], string> = {
    navigate_registered_app: 'Open the registered application Base URL',
    inspect_page: 'Inspect the current page',
    find_visible_element: 'Find a visible element',
    extract_text: 'Extract visible text',
    verify_element: 'Verify a visible element',
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader eyebrow="PHASE 2.2 · REVIEW ONLY" title="Task Planner" description="Describe a read-only inspection task and review Chronos’s structured plan." />
      <div className="info-banner exploration-active" role="status" style={{ marginBottom: 16 }}>
        <ShieldCheck size={16} />
        <span>Plans are limited to the selected registered application and read-only inspection actions. Approval records your decision in this screen only; it does not open a browser or execute the plan.</span>
      </div>
      <section className="card form-section">
        <div className="form-section-header"><div className="form-section-badge">1</div><div><h3>Describe the task</h3><p>Chronos will prepare a plan for your review.</p></div></div>
        <div className="form-grid">
          <div className="form-group form-full">
            <label>Registered application <span className="required">*</span></label>
            {appsLoading ? <div className="select-loading"><Loader2 size={14} className="spin" /> Loading applications…</div> : (
              <select value={applicationId} onChange={e => { setApplicationId(e.target.value); setPlan(null); setDecision(null); setError(null) }}>
                <option value="">— Select application —</option>
                {apps.filter(app => app.status !== 'Archived').map(app => <option key={app.id} value={app.id}>{app.name} ({app.environment})</option>)}
              </select>
            )}
          </div>
          <div className="form-group form-full">
            <label>Natural-language instruction <span className="required">*</span></label>
            <textarea
              value={instruction}
              onChange={e => { setInstruction(e.target.value); setPlan(null); setDecision(null); setError(null) }}
              placeholder="Inspect the registered timesheet application and identify the page title, headings, and weekly hours table."
              rows={4}
              maxLength={2000}
            />
            <div className="char-counter">{instruction.length}/2000</div>
          </div>
        </div>
        {error && <div className="info-banner info-banner-error" role="alert" style={{ marginTop: 12 }}><AlertTriangle size={15} /><span>{error}</span></div>}
        <button className="button button-primary" onClick={generatePlan} disabled={loading || appsLoading || !applicationId || !instruction.trim()} style={{ marginTop: 14 }}>
          {loading ? <><Loader2 size={15} className="spin" /> Planning…</> : <><Sparkles size={15} /> Generate plan</>}
        </button>
      </section>

      {plan && (
        <section className="card form-section" style={{ marginTop: 16 }}>
          <div className="form-section-header"><div className="form-section-badge">2</div><div><h3>Review plan</h3><p>Purpose and proposed actions for {plan.applicationName}</p></div></div>
          <p><strong>Registered Base URL:</strong> <span style={{ overflowWrap: 'anywhere' }}>{plan.registeredBaseUrl}</span></p>
          <p><strong>Purpose:</strong> {plan.purpose}</p>
          <ol className="conditions-list">
            {plan.actions.map((action, index) => (
              <li className="condition-item" key={`${action.action}-${index}`}>
                <span className="badge validation-ready">{index + 1}</span>
                <span><strong>{actionLabel[action.action]}</strong>{action.description ? `: ${action.description}` : ''}</span>
              </li>
            ))}
          </ol>
          <div className="info-banner exploration-active" style={{ marginTop: 14 }}>
            <Info size={15} /><span>This is a planning preview. Approval does not execute actions or start browser exploration.</span>
          </div>
          {decision ? (
            <div className="info-banner" role="status" style={{ marginTop: 12 }}>
              {decision === 'approved' ? <CheckCircle2 size={15} /> : <X size={15} />}
              <span>Plan {decision}. No browser actions were executed.</span>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="button button-primary" onClick={() => setDecision('approved')}><Check size={15} /> Approve plan</button>
              <button className="button button-secondary" onClick={() => setDecision('rejected')}><X size={15} /> Reject plan</button>
            </div>
          )}
        </section>
      )}
    </motion.div>
  )
}

/* ============================================================
   PHASE 1: CREATE AUTOMATION PAGE (TASK BUILDER)
   ============================================================ */

type AutomationForm = {
  name: string
  applicationId: string
  description: string
  taskCategory: string
  taskInstruction: string
  preconditions: string[]
  expectedResults: string[]
  readOnlyPreferred: boolean
  requireApproval: boolean
  stopOnAmbiguity: boolean
  maxActions: number
}

function CreateAutomationPage({ navigate, definition }: { navigate: (p: Page) => void; definition?: AutomationDefinition | null }) {
  const [apps, setApps] = useState<Application[]>([])
  const [appsLoading, setAppsLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  const [newItem, setNewItem] = useState({ precondition: '', expectedResult: '' })

  const [form, setForm] = useState<AutomationForm>({
    name: definition?.name ?? '',
    applicationId: definition?.application_id ?? '',
    description: definition?.description ?? '',
    taskCategory: definition?.task_category ?? '',
    taskInstruction: definition?.task_instruction ?? '',
    preconditions: (definition?.preconditions ?? []).map(item => typeof item === 'string' ? item : item.text),
    expectedResults: (definition?.expected_results ?? []).map(item => typeof item === 'string' ? item : item.text),
    readOnlyPreferred: definition?.safety_settings?.read_only_preferred ?? true,
    requireApproval: definition?.safety_settings?.require_approval ?? true,
    stopOnAmbiguity: definition?.safety_settings?.stop_on_ambiguity ?? true,
    maxActions: definition?.safety_settings?.max_actions ?? 25,
  })

  useEffect(() => {
    setAppsLoading(true)
    fetch(`${API}/api/applications`)
      .then(async r => { if (!r.ok) { const body = await r.json().catch(() => ({})); throw new Error(body.error || 'Unable to load applications.') }; return r.json() })
      .then(setApps)
      .catch(e => setApiError(e instanceof Error ? e.message : 'Unable to load applications.'))
      .finally(() => setAppsLoading(false))
  }, [])

  const set = (k: keyof AutomationForm, v: AutomationForm[typeof k]) => {
    setForm(f => ({ ...f, [k]: v }))
    setErrors(e => { const n = { ...e }; delete n[k as string]; return n })
  }

  const addPrecondition = () => {
    const val = newItem.precondition.trim()
    if (!val) return
    if (form.preconditions.length >= 20 || val.length > 300) { setErrors(e => ({ ...e, preconditions: form.preconditions.length >= 20 ? 'No more than 20 preconditions are allowed.' : 'Each precondition must be 300 characters or fewer.' })); return }
    set('preconditions', [...form.preconditions, val])
    setNewItem(n => ({ ...n, precondition: '' }))
  }
  const removePrecondition = (i: number) => set('preconditions', form.preconditions.filter((_, idx) => idx !== i))
  const addExpectedResult = () => {
    const val = newItem.expectedResult.trim()
    if (!val) return
    if (form.expectedResults.length >= 20 || val.length > 300) { setErrors(e => ({ ...e, expectedResults: form.expectedResults.length >= 20 ? 'No more than 20 expected results are allowed.' : 'Each expected result must be 300 characters or fewer.' })); return }
    set('expectedResults', [...form.expectedResults, val])
    setNewItem(n => ({ ...n, expectedResult: '' }))
  }
  const removeExpectedResult = (i: number) => set('expectedResults', form.expectedResults.filter((_, idx) => idx !== i))

  const clientValidate = () => {
    const e: Record<string, string> = {}
    if (!form.name.trim()) e.name = 'Name is required.'
    else if (form.name.trim().length > 150) e.name = 'Name must be ≤ 150 characters.'
    if (!form.applicationId) e.applicationId = 'Select a target application.'
    if (!form.taskCategory) e.taskCategory = 'Select a task category.'
    if (!form.taskInstruction.trim()) e.taskInstruction = 'Task instruction is required.'
    else if (form.taskInstruction.trim().length < 10) e.taskInstruction = 'Instruction must be at least 10 characters.'
    else if (form.taskInstruction.trim().length > 5000) e.taskInstruction = 'Instruction must be ≤ 5000 characters.'
    if (!Number.isInteger(form.maxActions) || form.maxActions < 1 || form.maxActions > 100) e.maxActions = 'Max actions must be an integer between 1 and 100.'
    if (form.preconditions.length > 20) e.preconditions = 'Add no more than 20 preconditions.'
    if (form.expectedResults.length > 20) e.expectedResults = 'Add no more than 20 expected results.'
    if ([...form.preconditions, ...form.expectedResults].some(item => item.length > 300)) e.conditions = 'Each precondition and expected result must be 300 characters or fewer.'
    return e
  }

  const doSave = async (status: 'Draft' | 'Configured') => {
    const e = clientValidate()
    if (Object.keys(e).length) { setErrors(e); return }
    setSaving(true); setApiError(null)
    try {
      const body = {
        applicationId: form.applicationId,
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        taskCategory: form.taskCategory,
        taskInstruction: form.taskInstruction.trim(),
        preconditions: form.preconditions,
        expectedResults: form.expectedResults,
        safetySettings: {
          read_only_preferred: form.readOnlyPreferred,
          require_approval: form.requireApproval,
          stop_on_ambiguity: form.stopOnAmbiguity,
          max_actions: form.maxActions,
        },
        status,
      }
      const res = await fetch(definition ? API + '/api/automations/' + definition.id : API + '/api/automations', { method: definition ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Save failed.')
      setSaved(true)
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Save failed.')
    } finally { setSaving(false) }
  }

  if (saved) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
        <div className="saved-confirmation card">
          <CheckCircle2 size={48} className="saved-icon" />
          <h2>{definition ? 'Task configuration updated!' : 'Task configuration saved!'}</h2>
          <p>The automation task has been saved to the database. Browser exploration, AI planning, and execution will be introduced in subsequent phases.</p>
          <div className="saved-actions">
            <button className="button button-secondary" onClick={() => navigate('automations')}>View all tasks</button>
            <button className="button button-primary" onClick={() => { if (definition) { navigate('automations'); return }; setSaved(false); setForm({ name: '', applicationId: '', description: '', taskCategory: '', taskInstruction: '', preconditions: [], expectedResults: [], readOnlyPreferred: true, requireApproval: true, stopOnAmbiguity: true, maxActions: 25 }) }}>{definition ? 'Back to task definitions' : 'Create another'}</button>
          </div>
        </div>
      </motion.div>
    )
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader
        eyebrow="TASK BUILDER"
        title={definition ? 'Edit Automation' : 'Create Automation'}
        description={definition ? 'Update the saved task configuration.' : 'Define a new automation task. It will be saved and ready for future execution.'}
      />

      <div className="info-banner"><Info size={17} /><span>Automation is not yet executed. Browser exploration, AI planning, and execution will be introduced in subsequent phases.</span></div>

      {apiError && <div className="info-banner info-banner-error"><AlertTriangle size={15} /><span>{apiError}</span><button onClick={() => { setApiError(null); setAppsLoading(true); fetch(`${API}/api/applications`).then(async r => { if (!r.ok) throw new Error('Unable to load applications.'); return r.json() }).then(setApps).catch(e => setApiError(e.message)).finally(() => setAppsLoading(false)) }}>Retry</button></div>}

      <div className="automation-form">
        {/* Section A: Identity */}
        <section className="card form-section">
          <div className="form-section-header"><div className="form-section-badge">A</div><div><h3>Task Identity</h3><p>Name this task and choose a target application</p></div></div>
          <div className="form-grid">
            <div className="form-group form-full">
              <label>Task name <span className="required">*</span></label>
              <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Submit monthly timesheet for project Apex" maxLength={150} />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </div>
            <div className="form-group">
              <label>Target application <span className="required">*</span></label>
              {appsLoading ? (
                <div className="select-loading"><Loader2 size={14} className="spin" /> Loading apps…</div>
              ) : apps.length === 0 ? (
                <div className="field-hint"><AlertTriangle size={12} /> No applications registered. <button className="inline-link" onClick={() => navigate('applications')}>Register one first →</button></div>
              ) : (
                <select value={form.applicationId} onChange={e => set('applicationId', e.target.value)}>
                  <option value="">— Select application —</option>
                  {apps.map(a => <option key={a.id} value={a.id}>{a.name} ({a.environment})</option>)}
                </select>
              )}
              {errors.applicationId && <span className="field-error">{errors.applicationId}</span>}
            </div>
            <div className="form-group">
              <label>Task category <span className="required">*</span></label>
              <select value={form.taskCategory} onChange={e => set('taskCategory', e.target.value)}>
                <option value="">— Select category —</option>
                {TASK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {errors.taskCategory && <span className="field-error">{errors.taskCategory}</span>}
            </div>
            <div className="form-group form-full">
              <label>Description <span className="muted-label">(optional)</span></label>
              <textarea value={form.description} onChange={e => set('description', e.target.value)} placeholder="Brief summary of this automation task…" rows={2} />
            </div>
          </div>
        </section>

        {/* Section B: Task Instruction */}
        <section className="card form-section">
          <div className="form-section-header"><div className="form-section-badge">B</div><div><h3>Task Instruction</h3><p>Describe in plain English what Chronos should do</p></div></div>
          <div className="form-group">
            <label>What would you like Chronos to do? <span className="required">*</span></label>
            <textarea
              value={form.taskInstruction}
              onChange={e => set('taskInstruction', e.target.value)}
              placeholder="Describe the task in plain English, e.g.: Log in to the Oracle HCM portal, navigate to My Timesheet, and submit 8 hours for project APEX on the 15th of this month. Verify that the submission confirmation appears."
              rows={6}
              maxLength={5000}
              className="instruction-textarea"
            />
            <div className="char-counter"><span className={form.taskInstruction.length > 4800 ? 'char-warn' : ''}>{form.taskInstruction.length}</span>/5000</div>
            {errors.taskInstruction && <span className="field-error">{errors.taskInstruction}</span>}
          </div>
        </section>

        {/* Section C: Preconditions */}
        <section className="card form-section">
          <div className="form-section-header"><div className="form-section-badge">C</div><div><h3>Preconditions</h3><p>What must be true before the automation starts?</p></div></div>
          <div className="conditions-list">
            {form.preconditions.map((p, i) => (
              <div key={i} className="condition-item">
                <CheckCircle2 size={14} className="condition-icon" />
                <span>{p}</span>
                <button className="icon-button-sm" onClick={() => removePrecondition(i)}><X size={12} /></button>
              </div>
            ))}
            {form.preconditions.length === 0 && <div className="conditions-empty">No preconditions added yet.</div>}
          </div>
          <div className="add-condition">
            <input value={newItem.precondition} maxLength={300} onChange={e => setNewItem(n => ({ ...n, precondition: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addPrecondition()} placeholder="e.g. User is logged in and has access to timesheet module" />
            <button className="button button-secondary" onClick={addPrecondition}><Plus size={14} /> Add</button>
          </div>
          {errors.preconditions && <span className="field-error">{errors.preconditions}</span>}
        </section>

        {/* Section D: Expected Results */}
        <section className="card form-section">
          <div className="form-section-header"><div className="form-section-badge">D</div><div><h3>Expected Results</h3><p>What outcomes should Chronos verify after execution?</p></div></div>
          <div className="conditions-list">
            {form.expectedResults.map((r, i) => (
              <div key={i} className="condition-item">
                <Check size={14} className="condition-icon cyan" />
                <span>{r}</span>
                <button className="icon-button-sm" onClick={() => removeExpectedResult(i)}><X size={12} /></button>
              </div>
            ))}
            {form.expectedResults.length === 0 && <div className="conditions-empty">No expected results added yet.</div>}
          </div>
          <div className="add-condition">
            <input value={newItem.expectedResult} maxLength={300} onChange={e => setNewItem(n => ({ ...n, expectedResult: e.target.value }))} onKeyDown={e => e.key === 'Enter' && addExpectedResult()} placeholder="e.g. Timesheet submission confirmation message is displayed" />
            <button className="button button-secondary" onClick={addExpectedResult}><Plus size={14} /> Add</button>
          </div>
          {errors.expectedResults && <span className="field-error">{errors.expectedResults}</span>}
        </section>

        {/* Section E: Safety Settings */}
        <section className="card form-section">
          <div className="form-section-header"><div className="form-section-badge">E</div><div><h3>Safety Settings</h3><p>Control how the automation behaves when executed in a future phase</p></div></div>
          <div className="safety-grid">
            <label className="toggle-row">
              <div>
                <strong>Prefer read-only mode</strong>
                <span>Attempt read-only operations where possible before writing</span>
              </div>
              <input type="checkbox" checked={form.readOnlyPreferred} onChange={e => set('readOnlyPreferred', e.target.checked)} />
            </label>
            <label className="toggle-row">
              <div>
                <strong>Require human approval</strong>
                <span>Pause and wait for a human to approve before executing write actions</span>
              </div>
              <input type="checkbox" checked={form.requireApproval} onChange={e => set('requireApproval', e.target.checked)} />
            </label>
            <label className="toggle-row">
              <div>
                <strong>Stop on ambiguity</strong>
                <span>Halt the automation if the AI planning layer is uncertain about the next step</span>
              </div>
              <input type="checkbox" checked={form.stopOnAmbiguity} onChange={e => set('stopOnAmbiguity', e.target.checked)} />
            </label>
            <div className="form-group" style={{ marginTop: 4 }}>
              <label>Maximum actions <span className="muted-label">(1–100)</span></label>
              <input type="number" min={1} max={100} value={form.maxActions} onChange={e => set('maxActions', Number(e.target.value))} style={{ maxWidth: 100 }} />
              {errors.maxActions && <span className="field-error">{errors.maxActions}</span>}
            </div>
          </div>
        </section>

        {/* Section F: Review & Save */}
        <section className="card form-section review-section">
          <div className="form-section-header"><div className="form-section-badge">F</div><div><h3>Review & Save</h3><p>Save the task configuration to the database</p></div></div>
          <div className="review-grid">
            <div className="review-item"><span>Task name</span><strong>{form.name || '—'}</strong></div>
            <div className="review-item"><span>Application</span><strong>{apps.find(a => a.id === form.applicationId)?.name || '—'}</strong></div>
            <div className="review-item"><span>Category</span><strong>{form.taskCategory || '—'}</strong></div>
            <div className="review-item"><span>Preconditions</span><strong>{form.preconditions.length}</strong></div>
            <div className="review-item"><span>Expected results</span><strong>{form.expectedResults.length}</strong></div>
            <div className="review-item"><span>Max actions</span><strong>{form.maxActions}</strong></div>
          </div>
          <div className="modal-footer" style={{ marginTop: 16 }}>
            <button className="button button-secondary" onClick={() => doSave('Draft')} disabled={saving}>
              {saving ? <><Loader2 size={15} className="spin" /> Saving…</> : 'Save as Draft'}
            </button>
            <button className="button button-primary" onClick={() => doSave('Configured')} disabled={saving}>
              {saving ? <><Loader2 size={15} className="spin" /> Saving…</> : <><Check size={15} /> Save Configuration</>}
            </button>
          </div>
        </section>
      </div>
    </motion.div>
  )
}

/* ============================================================
   PHASE 1: AUTOMATIONS LIST PAGE
   ============================================================ */

function AutomationsPage({ navigate, onEdit }: { navigate: (p: Page) => void; onEdit?: (definition: AutomationDefinition) => void }) {
  const [defs, setDefs] = useState<AutomationDefinition[]>([])
  const [apps, setApps] = useState<Application[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [selectedDefinition, setSelectedDefinition] = useState<AutomationDefinition | null>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const loadAll = async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (search) params.set('search', search)
      if (catFilter) params.set('category', catFilter)
      if (statusFilter) params.set('status', statusFilter)
      const [defsRes, appsRes] = await Promise.all([
        fetch(`${API}/api/automations?${params}`),
        fetch(`${API}/api/applications`),
      ])
      if (!defsRes.ok) { const body = await defsRes.json().catch(() => ({})); throw new Error(body.error || 'Failed to load task definitions.') }
      if (!appsRes.ok) { const body = await appsRes.json().catch(() => ({})); throw new Error(body.error || 'Failed to load applications.') }
      const defsData = await defsRes.json()
      const appsData = await appsRes.json()
      setApps(appsData)
      const appMap = new Map<string, string>(appsData.map((a: Application) => [a.id, a.name]))
      setDefs(defsData.map((d: AutomationDefinition) => ({ ...d, application_name: appMap.get(d.application_id) || d.application_id })))
    } catch (e) { setError(e instanceof Error ? e.message : 'Unknown error') }
    finally { setLoading(false) }
  }

  useEffect(() => { loadAll() }, [search, catFilter, statusFilter])

  const duplicate = async (id: string, name: string) => {
    try {
      const res = await fetch(`${API}/api/automations/${id}/duplicate`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error || 'Duplicate failed.') }
      showToast(`"${name}" duplicated.`)
      loadAll()
    } catch (e) { alert(e instanceof Error ? e.message : 'Duplicate failed.') }
  }

  const archive = async (id: string, name: string) => {
    if (!confirm(`Archive "${name}"?`)) return
    try {
      const res = await fetch(`${API}/api/automations/${id}/archive`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error || 'Archive failed.') }
      showToast(`"${name}" archived.`)
      loadAll()
    } catch (e) { alert(e instanceof Error ? e.message : 'Archive failed.') }
  }

  const statusColor = (s: string) => ({ Draft: 'amber', Configured: 'cyan', Archived: 'muted' }[s] || 'blue')

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader
        eyebrow="AUTOMATION LIBRARY"
        title="Task Definitions"
        description="Manage saved automation task configurations."
        action={<button className="button button-primary" onClick={() => navigate('create-automation')}><Plus size={16} /> Create Automation</button>}
      />

      <div className="toolbar card">
        <div className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tasks…" /></div>
        <select className="filter-select" value={catFilter} onChange={e => setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {TASK_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="Draft">Draft</option>
          <option value="Configured">Configured</option>
          <option value="Archived">Archived</option>
        </select>
      </div>

      {loading && <div className="empty-recordings card"><Loader2 size={28} className="spin" /><strong>Loading task definitions…</strong></div>}
      {error && <div className="info-banner info-banner-error"><AlertTriangle size={17} /><span>{error}</span><button onClick={loadAll}>Retry</button></div>}
      {!loading && !error && defs.length === 0 && (
        <div className="empty-recordings card">
          <Sparkles size={36} />
          <strong>No automation tasks yet</strong>
          <span>Create a task definition to get started.</span>
          <button className="button button-primary" style={{ marginTop: 8 }} onClick={() => navigate('create-automation')}><Plus size={16} /> Create Automation</button>
        </div>
      )}
      {!loading && !error && defs.length > 0 && (
        <section className="card runs-card">
          <div className="card-heading"><div><h2>Saved Tasks</h2><p>{defs.length} task definition{defs.length !== 1 ? 's' : ''}</p></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Application</th><th>Category</th><th>Status</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {defs.map(d => (
                  <tr key={d.id}>
                    <td><button className="text-button" onClick={() => setSelectedDefinition(d)}><strong>{d.name}</strong></button>{d.description && <div className="table-sub">{d.description.slice(0, 60)}{d.description.length > 60 ? '…' : ''}</div>}</td>
                    <td>{d.application_name}</td>
                    <td><span className="app-tag"><Tag size={11} />{d.task_category}</span></td>
                    <td><span className={`badge badge-${statusColor(d.status)}`}>{d.status}</span></td>
                    <td>{new Date(d.updated_at).toLocaleDateString()}</td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-button-sm" title="Edit" onClick={() => onEdit?.(d)}><Edit3 size={13} /></button>
                        <button className="icon-button-sm" title="Duplicate" onClick={() => duplicate(d.id, d.name)}><Copy size={13} /></button>
                        <button className="icon-button-sm danger" title="Archive" onClick={() => archive(d.id, d.name)}><Archive size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <AnimatePresence>
        {selectedDefinition && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={() => setSelectedDefinition(null)}><motion.div initial={{ y: 24 }} animate={{ y: 0 }} exit={{ y: 24 }} className="modal-panel card" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">TASK DEFINITION</div><h2>{selectedDefinition.name}</h2></div><button className="icon-button" onClick={() => setSelectedDefinition(null)}><X size={18} /></button></div><p><strong>Application:</strong> {selectedDefinition.application_name}</p><p><strong>Category:</strong> {selectedDefinition.task_category} · <strong>Status:</strong> {selectedDefinition.status}</p><p><strong>Instruction</strong></p><p>{selectedDefinition.task_instruction}</p><p><strong>Preconditions</strong></p><ul>{(selectedDefinition.preconditions || []).map((item, i) => <li key={i}>{typeof item === 'string' ? item : item.text}</li>)}</ul><p><strong>Expected results</strong></p><ul>{(selectedDefinition.expected_results || []).map((item, i) => <li key={i}>{typeof item === 'string' ? item : item.text}</li>)}</ul><button className="button button-primary" onClick={() => { const selected = selectedDefinition; setSelectedDefinition(null); onEdit?.(selected) }}>Edit definition</button></motion.div></motion.div>}
        {toast && <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="toast"><CheckCircle2 size={16} /> {toast}</motion.div>}
      </AnimatePresence>
    </motion.div>
  )
}

/* ============================================================
   EXISTING PAGES (PRESERVED)
   ============================================================ */

function Overview({ navigate, runs: initialRuns }: { navigate: (p: Page) => void; runs: Run[] }) {
  const [runs, setRuns] = useState<Run[]>(initialRuns)
  const [browserExecutions, setBrowserExecutions] = useState<any[]>([])

  useEffect(() => {
    setRuns(initialRuns)
  }, [initialRuns])

  useEffect(() => {
    Promise.all([
      fetch(`${API}/api/runs`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch(`${API}/api/browser-tests/executions`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]).then(([rData, bData]) => {
      if (Array.isArray(rData) && rData.length) setRuns(rData)
      if (Array.isArray(bData) && bData.length) setBrowserExecutions(bData)
    })
  }, [])

  // 1. Calculate combined metrics
  const timesheetPassed = runs.reduce((s, r) => s + (r.passed || 0), 0)
  const timesheetFailed = runs.reduce((s, r) => s + (r.status !== 'Partial' ? (r.failed || 0) : 0), 0)
  const timesheetPartial = runs.reduce((s, r) => s + (r.status === 'Partial' ? (r.failed || 0) : 0), 0)
  const timesheetTotal = runs.reduce((s, r) => s + (r.total || 0), 0)

  const browserPassed = browserExecutions.filter((e) => e.status === 'PASSED').length
  const browserFailed = browserExecutions.filter((e) => e.status === 'FAILED').length
  const browserOther = browserExecutions.filter((e) => e.status !== 'PASSED' && e.status !== 'FAILED').length
  const browserTotal = browserExecutions.length

  const totalPassed = timesheetPassed + browserPassed
  const totalFailed = timesheetFailed + browserFailed
  const totalPartial = timesheetPartial + browserOther
  const totalCases = timesheetTotal + browserTotal
  const totalCompleted = totalPassed + totalFailed + totalPartial
  const passRate = totalCompleted > 0 ? (totalPassed / totalCompleted) * 100 : 0
  const totalRuns = runs.length + browserExecutions.length

  // Circular gauge calculations
  const ringRadius = 58
  const ringCircumference = 2 * Math.PI * ringRadius
  const ringOffset = ringCircumference - (passRate / 100) * ringCircumference

  // 2. Accurate 7-Day Reliability Trajectory
  const allEvents: Array<{ time: number; passed: number; failed: number; total: number }> = []

  runs.forEach((r) => {
    const t = new Date(r.created).getTime()
    if (!isNaN(t)) {
      allEvents.push({
        time: t,
        passed: r.passed || 0,
        failed: (r.status !== 'Partial' ? r.failed : 0) || 0,
        total: r.total || 0,
      })
    }
  })

  browserExecutions.forEach((e) => {
    const t = new Date(e.created_at).getTime()
    if (!isNaN(t)) {
      const isPassed = e.status === 'PASSED'
      allEvents.push({
        time: t,
        passed: isPassed ? 1 : 0,
        failed: isPassed ? 0 : 1,
        total: 1,
      })
    }
  })

  const now = new Date()
  const days: Array<{
    day: string
    date: string
    dayStr: string
    passed: number
    failed: number
    total: number
    rate: number
    hasRuns: boolean
  }> = []

  // Compute baseline for trajectory
  let runningRate = passRate > 0 ? Math.round(passRate * 10) / 10 : 70.0

  for (let i = 6; i >= 0; i--) {
    const targetDate = new Date(now.getTime() - i * 86400000)
    const dayStr = targetDate.toISOString().slice(0, 10)

    const dayEvents = allEvents.filter((e) => {
      const d = new Date(e.time)
      return d.toISOString().slice(0, 10) === dayStr
    })

    const dayPassed = dayEvents.reduce((s, e) => s + e.passed, 0)
    const dayFailed = dayEvents.reduce((s, e) => s + e.failed, 0)
    const dayTotal = dayPassed + dayFailed
    const hasRuns = dayTotal > 0

    if (hasRuns) {
      runningRate = Math.round((dayPassed / dayTotal) * 1000) / 10
    }

    days.push({
      day: targetDate.toLocaleDateString('en-US', { weekday: 'short' }),
      date: targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      dayStr,
      passed: dayPassed,
      failed: dayFailed,
      total: dayTotal,
      rate: runningRate,
      hasRuns,
    })
  }

  // Trajectory delta (compare today vs yesterday or prior day with runs)
  const todayEntry = days[days.length - 1]
  const yesterdayEntry = days[days.length - 2]
  const trendChange = todayEntry && yesterdayEntry ? todayEntry.rate - yesterdayEntry.rate : null

  return (
    <motion.div key="overview" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader
        eyebrow="EXECUTIVE DASHBOARD"
        title="Overview"
        description="Monitor system health, automation reliability, and simulated execution outcomes in real-time."
        action={
          <button className="button button-primary" onClick={() => navigate('upload')}>
            <CloudUpload size={16} /> Upload Test Cases
          </button>
        }
      />

      {/* Top 4 Luxury Metric Cards */}
      <div className="metric-grid">
        <Metric icon={Activity} label="Total Cases Processed" value={String(totalCases)} trend="All Executions" color="violet" />
        <Metric icon={CheckCircle2} label="Automation Passed" value={String(totalPassed)} trend={totalCompleted > 0 ? `${passRate.toFixed(1)}% Success` : 'No Data'} color="cyan" />
        <Metric icon={AlertTriangle} label="Failed / Blocked" value={String(totalFailed)} trend="Requires Review" color="orange" />
        <Metric icon={Clock3} label="Total Runs Executed" value={String(totalRuns)} trend="Persisted Executions" color="blue" />
      </div>

      <div className="overview-grid" style={{ display: 'grid', gridTemplateColumns: '1.45fr 1fr', gap: 24, marginTop: 4 }}>
        {/* Luxury Automation Health & Reliability Card */}
        <section className="card reliability-card" style={{ padding: '28px 32px', background: '#0e1528', border: '1px solid #1e293b', borderRadius: 14 }}>
          {totalRuns === 0 ? (
            <div className="reliability-empty" style={{ padding: '50px 20px', textAlign: 'center' }}>
              <Activity size={36} style={{ color: '#21d4d8', margin: '0 auto 12px' }} />
              <strong style={{ display: 'block', fontSize: 17, marginBottom: 6 }}>No automation data yet</strong>
              <span style={{ color: '#94a3b8', fontSize: 13 }}>Upload a CSV or execute a test suite to populate reliability metrics.</span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <div>
                  <div className="eyebrow" style={{ color: '#21d4d8' }}>SYSTEM RELIABILITY INDEX</div>
                  <h2 style={{ fontSize: 22, marginTop: 4, color: '#f8fafc' }}>Automation Health & Pass Rate</h2>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(33, 212, 216, 0.1)', border: '1px solid rgba(33, 212, 216, 0.3)', padding: '6px 14px', borderRadius: 20 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#21d4d8', boxShadow: '0 0 10px #21d4d8' }} />
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#21d4d8' }}>
                    {passRate >= 75 ? 'OPTIMAL HEALTH' : passRate >= 45 ? 'STABLE' : 'ATTENTION REQUIRED'}
                  </span>
                </div>
              </div>

              {/* Dual-Column Layout: Left Gauge, Right Stat Tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 28, alignItems: 'center', paddingBottom: 24, borderBottom: '1px solid #1e293b' }}>
                {/* Glowing Circular Gauge */}
                <div style={{ position: 'relative', width: 160, height: 160, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="160" height="160" style={{ transform: 'rotate(-90deg)' }}>
                    <circle cx="80" cy="80" r={ringRadius} stroke="#17223b" strokeWidth="12" fill="transparent" />
                    <circle
                      cx="80"
                      cy="80"
                      r={ringRadius}
                      stroke="url(#reliability-gauge-grad)"
                      strokeWidth="12"
                      strokeDasharray={ringCircumference}
                      strokeDashoffset={ringOffset}
                      strokeLinecap="round"
                      fill="transparent"
                      style={{ transition: 'stroke-dashoffset 1s ease' }}
                    />
                    <defs>
                      <linearGradient id="reliability-gauge-grad" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#21d4d8" />
                        <stop offset="100%" stopColor="#10b981" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <div style={{ position: 'absolute', textAlign: 'center' }}>
                    <div style={{ fontSize: 28, fontWeight: 800, color: '#f8fafc', lineHeight: 1 }}>
                      {passRate.toFixed(1)}%
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 }}>
                      Pass Rate
                    </div>
                  </div>
                </div>

                {/* 2x2 Luxury KPI Stat Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div style={{ background: '#090e1c', border: '1px solid rgba(33, 212, 216, 0.2)', borderRadius: 10, padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#21d4d8', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Passed</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: '#f8fafc', marginTop: 4 }}>{totalPassed}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{totalCases > 0 ? Math.round((totalPassed / totalCases) * 100) : 0}% of all cases</div>
                  </div>

                  <div style={{ background: '#090e1c', border: '1px solid rgba(244, 63, 94, 0.2)', borderRadius: 10, padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#f43f5e', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Failed</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: '#f8fafc', marginTop: 4 }}>{totalFailed}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Requires fix</div>
                  </div>

                  <div style={{ background: '#090e1c', border: '1px solid rgba(251, 191, 36, 0.2)', borderRadius: 10, padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Partial / Warn</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: '#f8fafc', marginTop: 4 }}>{totalPartial}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Handled with note</div>
                  </div>

                  <div style={{ background: '#090e1c', border: '1px solid rgba(155, 124, 255, 0.2)', borderRadius: 10, padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#c4b5fd', letterSpacing: '0.05em', textTransform: 'uppercase' }}>Total Executions</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: '#f8fafc', marginTop: 4 }}>{totalRuns}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Historical volume</div>
                  </div>
                </div>
              </div>

              {/* Bottom: 7-Day Reliability Trajectory with Accurate Daily Values */}
              <div style={{ marginTop: 22 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: '#cbd5e1' }}>
                    <Clock3 size={15} color="#21d4d8" />
                    <span>7-Day Reliability Trajectory</span>
                  </div>
                  {trendChange !== null ? (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 6, background: trendChange >= 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)', border: `1px solid ${trendChange >= 0 ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`, fontSize: 12, fontWeight: 600, color: trendChange >= 0 ? '#34d399' : '#f87171' }}>
                      {trendChange >= 0 ? '+' : ''}{trendChange.toFixed(1)} pts
                      {trendChange >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                      <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 400 }}>today vs yesterday</span>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: '#64748b' }}>Baseline tracking</span>
                  )}
                </div>

                <div style={{ height: 160, width: '100%' }}>
                  <ResponsiveContainer width="100%" height={160}>
                    <AreaChart data={days} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="overview-trend-gradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#21d4d8" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#21d4d8" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                      <XAxis
                        dataKey="day"
                        tick={{ fontSize: 12, fill: '#94a3b8' }}
                        axisLine={{ stroke: '#1e293b' }}
                        tickLine={false}
                      />
                      <YAxis
                        domain={[0, 100]}
                        tick={{ fontSize: 12, fill: '#94a3b8' }}
                        axisLine={{ stroke: '#1e293b' }}
                        tickLine={false}
                        unit="%"
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload[0]) {
                            const d = payload[0].payload
                            return (
                              <div style={{ background: '#0a1020', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', minWidth: 190 }}>
                                <div style={{ fontWeight: 700, color: '#f8fafc', fontSize: 13, marginBottom: 4 }}>
                                  {d.day} ({d.date})
                                </div>
                                {d.hasRuns ? (
                                  <>
                                    <div style={{ color: '#21d4d8', fontSize: 13, fontWeight: 700 }}>
                                      Pass Rate: {d.rate.toFixed(1)}%
                                    </div>
                                    <div style={{ color: '#94a3b8', fontSize: 11, marginTop: 3 }}>
                                      {d.passed} passed · {d.failed} failed ({d.total} total)
                                    </div>
                                  </>
                                ) : (
                                  <div style={{ color: '#64748b', fontSize: 11, fontStyle: 'italic' }}>
                                    No runs · Maintained baseline
                                  </div>
                                )}
                              </div>
                            )
                          }
                          return null
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="rate"
                        fill="url(#overview-trend-gradient)"
                        stroke="#21d4d8"
                        strokeWidth={2.5}
                        dot={(props: any) => {
                          const { cx, cy, payload } = props
                          if (!payload.hasRuns) return <circle key={cx} cx={cx} cy={cy} r={2} fill="#334155" />
                          return (
                            <circle
                              key={cx}
                              cx={cx}
                              cy={cy}
                              r={5}
                              fill="#090e1c"
                              stroke="#21d4d8"
                              strokeWidth={2.5}
                            />
                          )
                        }}
                        activeDot={{ r: 7, fill: '#21d4d8', stroke: '#ffffff', strokeWidth: 2 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Latest Activity Card */}
        <section className="card activity-card" style={{ padding: '28px 28px', background: '#0e1528', border: '1px solid #1e293b', borderRadius: 14 }}>
          <div className="card-heading" style={{ marginBottom: 18 }}>
            <div>
              <div className="eyebrow" style={{ color: '#c4b5fd' }}>EVENT STREAM</div>
              <h2 style={{ fontSize: 20, marginTop: 4, color: '#f8fafc' }}>Latest Automation Runs</h2>
              <p style={{ fontSize: 13, color: '#94a3b8' }}>Real-time execution log from storage</p>
            </div>
          </div>
          {browserExecutions.length || runs.length ? (
            <div className="activity-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Show most recent browser executions first, then runs */}
              {[
                ...browserExecutions.slice(0, 4).map((e) => ({
                  id: e.id,
                  status: e.status === 'PASSED' ? 'Passed' : 'Failed',
                  title: `${e.status === 'PASSED' ? 'Passed' : 'Failed'} Test Case`,
                  detail: `${e.case_key || 'Case'} · ${e.case_name || e.suite_name || 'Workflow Run'}`,
                  time: new Date(e.created_at).toLocaleString(),
                })),
                ...runs.slice(0, 2).map((r) => ({
                  id: r.id,
                  status: r.status,
                  title: `${r.status} Timesheet Run`,
                  detail: `${r.file} · ${r.total} cases`,
                  time: new Date(r.created).toLocaleString(),
                })),
              ].slice(0, 5).map((item) => (
                <ActivityItem
                  key={item.id}
                  icon={item.status === 'Failed' ? AlertTriangle : CheckCircle2}
                  color={item.status === 'Failed' ? 'orange' : item.status === 'Partial' ? 'amber' : 'cyan'}
                  title={item.title}
                  detail={item.detail}
                  time={item.time}
                />
              ))}
            </div>
          ) : (
            <div className="empty-recordings" style={{ padding: '40px 10px', textAlign: 'center' }}>
              <Activity size={32} style={{ color: '#64748b', margin: '0 auto 10px' }} />
              <strong style={{ display: 'block', fontSize: 15, color: '#cbd5e1' }}>No activity yet</strong>
              <span style={{ fontSize: 12, color: '#64748b' }}>Processed runs will stream here automatically.</span>
            </div>
          )}
        </section>
      </div>

      {/* Recent Test Runs Section */}
      <section className="card runs-card" style={{ padding: '24px 28px', background: '#0e1528', border: '1px solid #1e293b', borderRadius: 14, marginTop: 8 }}>
        <div className="card-heading" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="eyebrow">PERSISTED RUNS</div>
            <h2 style={{ fontSize: 20, marginTop: 4, color: '#f8fafc' }}>Recent Test Runs</h2>
            <p style={{ fontSize: 13, color: '#94a3b8' }}>Monitor and inspect execution results and case breakdowns</p>
          </div>
          <button className="button button-secondary" onClick={() => navigate('runs')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>View All Runs</span>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <RunsTable runs={runs.slice(0, 4)} openRun={() => navigate('run-detail')} />
      </section>
    </motion.div>
  )
}
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
function RunDetails({ run, back }: { run: Run; back: () => void }) { const cases = run.cases || []; return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><button className="back-button" onClick={back}>← Back to test runs</button><PageHeader eyebrow={`RUN / ${run.id}`} title={run.file} description={`${run.created} · Persisted automation run`} action={<StatusBadge status={run.status} />} /><div className="metric-grid compact"><Metric icon={FileSpreadsheet} label="Total cases" value={String(run.total)} trend="Processed" color="violet" /><Metric icon={CheckCircle2} label="Passed" value={String(run.passed)} trend={run.total ? `${Math.round(run.passed / run.total * 100)}% pass rate` : 'No cases'} color="cyan" /><Metric icon={AlertTriangle} label="Failed" value={String(run.failed)} trend="Needs attention" color="orange" /><Metric icon={Clock3} label="Skipped" value={String(run.skipped)} trend={run.duration} color="blue" /></div><section className="card runs-card"><div className="card-heading"><div><h2>Test case results</h2><p>Each case includes artifacts captured for its isolated automation context.</p></div></div><div className="table-wrap"><table><thead><tr><th>Test case</th><th>Username</th><th>Target date</th><th>Project</th><th>Status</th><th>Artifacts</th><th>Message</th></tr></thead><tbody>{cases.map(c => <tr key={`${run.id}-${c.row_number}`}><td><strong>{c.case_id || `Row ${c.row_number}`}</strong></td><td className="mono">{c.username_masked || '—'}</td><td>{c.requested_date || '—'}</td><td>{c.project || '—'}</td><td><span className="badge">{c.status}</span></td><td>{c.artifacts?.length ? c.artifacts.map(artifact => <a key={artifact.kind} className="link-button" href={`${API}${artifact.url}`} target="_blank" rel="noreferrer">{artifact.kind}</a>) : '—'}</td><td>{c.message || '—'}</td></tr>)}</tbody></table></div></section></motion.div> }

type Artifact = {
  artifactId: string
  caseId: string
  caseName?: string
  status: string
  readOnly: boolean
  recordingAvailable: boolean
  videoUrl: string | null
  kind?: string
  appName?: string
  suiteName?: string
  createdAt?: string
  sizeBytes?: number
  fileName?: string
}

function Recordings({ open }: { open: (recording?: Artifact) => void }) {
  const [browserArtifacts, setBrowserArtifacts] = useState<any[]>([])
  const [legacyArtifacts, setLegacyArtifacts] = useState<Artifact[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'video' | 'screenshot'>('all')
  const [selectedApp, setSelectedApp] = useState<string>('all')

  const fetchData = async () => {
    setLoading(true)
    try {
      const [browserResp, legacyResp, runsResp] = await Promise.all([
        fetch(`${API}/api/browser-tests/all-artifacts`).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${API}/api/artifacts`).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`${API}/api/runs`).then(r => r.ok ? r.json() : []).catch(() => []),
      ])
      setBrowserArtifacts(browserResp)
      setLegacyArtifacts(legacyResp)
      setRuns(runsResp)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const normalizedBrowserArtifacts: Artifact[] = browserArtifacts.map((item) => ({
    artifactId: item.id,
    caseId: item.case_key || 'Case',
    caseName: item.case_name || '',
    status: item.execution_status || 'COMPLETED',
    readOnly: false,
    recordingAvailable: item.kind === 'video',
    videoUrl: `/api/browser-tests/artifacts/${item.id}`,
    kind: item.kind,
    appName: item.application_name || 'Workflow Test',
    suiteName: item.suite_name || '',
    createdAt: item.created_at,
    sizeBytes: item.size_bytes ? Number(item.size_bytes) : undefined,
    fileName: item.suite_name || 'Browser Test',
  }))

  const normalizedLegacyArtifacts: Artifact[] = legacyArtifacts.map((a) => {
    const run = runs.find((r) => r.cases?.some((c) => c.case_id === a.caseId))
    return {
      ...a,
      kind: a.videoUrl ? 'video' : 'screenshot',
      appName: 'Oracle APEX Timesheet',
      fileName: run?.file || 'Timesheet Automation',
      createdAt: a.artifactId ? new Date(Number(a.artifactId.split('-')[0]) || Date.now()).toISOString() : undefined,
    }
  })

  const allArtifacts = [...normalizedBrowserArtifacts, ...normalizedLegacyArtifacts]
  const videoCount = allArtifacts.filter(a => a.kind === 'video').length
  const screenshotCount = allArtifacts.filter(a => a.kind === 'screenshot').length
  const appOptions = Array.from(new Set(allArtifacts.map(a => a.appName).filter(Boolean))) as string[]

  const filtered = allArtifacts.filter((item) => {
    if (filterType === 'video' && item.kind !== 'video') return false
    if (filterType === 'screenshot' && item.kind !== 'screenshot') return false
    if (selectedApp !== 'all' && item.appName !== selectedApp) return false
    if (search) {
      const q = search.toLowerCase()
      const match =
        (item.caseId && item.caseId.toLowerCase().includes(q)) ||
        (item.caseName && item.caseName.toLowerCase().includes(q)) ||
        (item.appName && item.appName.toLowerCase().includes(q)) ||
        (item.suiteName && item.suiteName.toLowerCase().includes(q)) ||
        (item.status && item.status.toLowerCase().includes(q))
      if (!match) return false
    }
    return true
  })

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader
        eyebrow="EXECUTION EVIDENCE & RECORDINGS"
        title="Test Case Recordings"
        description="Inspect video recordings and screenshots captured across all automated browser and workflow runs."
        action={
          <button className="button button-secondary" onClick={fetchData} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Activity size={16} /> Refresh
          </button>
        }
      />

      <div className="card toolbar" style={{ padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', flex: 1, minWidth: 280 }}>
          <div className="search-field" style={{ minWidth: 260, flex: 1 }}>
            <Search size={16} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by test case ID, title, app, or suite..."
            />
          </div>

          <div className="filter-tabs" style={{ display: 'flex', gap: 6 }}>
            <button
              className={filterType === 'all' ? 'selected' : ''}
              onClick={() => setFilterType('all')}
            >
              All <span className="badge-count">{allArtifacts.length}</span>
            </button>
            <button
              className={filterType === 'video' ? 'selected' : ''}
              onClick={() => setFilterType('video')}
            >
              <Film size={14} style={{ marginRight: 4, verticalAlign: -2 }} /> Videos <span className="badge-count">{videoCount}</span>
            </button>
            <button
              className={filterType === 'screenshot' ? 'selected' : ''}
              onClick={() => setFilterType('screenshot')}
            >
              Screenshots <span className="badge-count">{screenshotCount}</span>
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ fontSize: 13, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>App:</span>
            <select
              value={selectedApp}
              onChange={e => setSelectedApp(e.target.value)}
              style={{ background: '#0a1020', border: '1px solid #1e293b', color: '#e2e8f0', borderRadius: 6, padding: '6px 12px', fontSize: 13 }}
            >
              <option value="all">All Applications ({allArtifacts.length})</option>
              {appOptions.map(app => (
                <option key={app} value={app}>{app}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: '60px 20px', textAlign: 'center' }}>
          <Loader2 size={36} className="spin" style={{ margin: '0 auto 12px', color: '#21d4d8' }} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>Loading recordings & evidence...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-recordings card" style={{ padding: '60px 20px', textAlign: 'center' }}>
          <Film size={44} style={{ margin: '0 auto 12px', color: '#64748b' }} />
          <strong style={{ display: 'block', fontSize: 17, marginBottom: 6 }}>No recordings match your filter</strong>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>Try clearing your search query or selecting a different tab.</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
          {filtered.map((artifact) => {
            const isVideo = artifact.kind === 'video'
            return (
              <motion.div
                whileHover={{ y: -4, borderColor: '#38bdf8' }}
                key={artifact.artifactId}
                className="card"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: 12,
                  border: '1px solid #1e293b',
                  background: '#0d1326',
                  transition: 'border-color 0.2s',
                }}
              >
                {/* Media Preview Box */}
                <div
                  style={{
                    position: 'relative',
                    height: 160,
                    background: '#070b14',
                    borderBottom: '1px solid #1e293b',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                  onClick={() => open(artifact)}
                >
                  {isVideo ? (
                    <div style={{ textAlign: 'center' }}>
                      <div
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: '50%',
                          background: 'rgba(33, 212, 216, 0.15)',
                          border: '2px solid #21d4d8',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          margin: '0 auto 8px',
                          color: '#21d4d8',
                        }}
                      >
                        <Play size={22} fill="currentColor" style={{ marginLeft: 3 }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: '#38bdf8' }}>
                        PLAY RECORDING
                      </span>
                    </div>
                  ) : (
                    <img
                      src={`${API}${artifact.videoUrl}`}
                      alt={artifact.caseId}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => {
                        (e.target as HTMLElement).style.display = 'none'
                      }}
                    />
                  )}

                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      left: 10,
                      background: 'rgba(8, 12, 24, 0.85)',
                      padding: '3px 8px',
                      borderRadius: 4,
                      fontSize: 11,
                      fontWeight: 600,
                      color: isVideo ? '#21d4d8' : '#a78bfa',
                      border: '1px solid #334155',
                    }}
                  >
                    {isVideo ? 'VIDEO (.webm)' : 'SCREENSHOT'}
                  </div>

                  <div
                    style={{
                      position: 'absolute',
                      top: 10,
                      right: 10,
                    }}
                  >
                    <StatusBadge status={artifact.status} />
                  </div>
                </div>

                {/* Card Details */}
                <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: '#38bdf8', fontWeight: 600, background: 'rgba(56, 189, 248, 0.1)', padding: '2px 6px', borderRadius: 4 }}>
                      {artifact.appName}
                    </span>
                    <strong style={{ fontSize: 14, color: '#f8fafc' }}>{artifact.caseId}</strong>
                  </div>

                  <h3 style={{ fontSize: 14, fontWeight: 500, color: '#cbd5e1', lineHeight: 1.4, margin: '0 0 10px 0', minHeight: 38 }}>
                    {artifact.caseName || artifact.fileName || 'Execution Run Artifact'}
                  </h3>

                  {artifact.suiteName && (
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Suite: {artifact.suiteName}
                    </div>
                  )}

                  <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 11, color: '#64748b' }}>
                      {artifact.createdAt ? new Date(artifact.createdAt).toLocaleDateString() : '—'}
                      {artifact.sizeBytes ? ` · ${(artifact.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : ''}
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="button button-primary"
                        style={{ padding: '5px 12px', fontSize: 12 }}
                        onClick={() => open(artifact)}
                      >
                        {isVideo ? 'Watch' : 'View'}
                      </button>
                      {artifact.videoUrl && (
                        <a
                          href={`${API}${artifact.videoUrl}`}
                          download
                          className="button button-secondary"
                          style={{ padding: '5px 10px', fontSize: 12 }}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Save
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}

function VideoModal({ close, recording }: { close: () => void; recording?: Artifact }) {
  if (!recording) return null
  const isVideo = recording.kind === 'video' || recording.videoUrl?.endsWith('.webm') || recording.videoUrl?.endsWith('.mp4') || recording.recordingAvailable
  const isScreenshot = recording.kind === 'screenshot' || recording.videoUrl?.endsWith('.png') || recording.videoUrl?.endsWith('.jpg')
  const mediaUrl = recording.videoUrl ? (recording.videoUrl.startsWith('http') ? recording.videoUrl : `${API}${recording.videoUrl}`) : null

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={close}>
      <motion.div
        initial={{ y: 20, scale: 0.98 }}
        animate={{ y: 0, scale: 1 }}
        className="video-modal card"
        style={{ maxWidth: 900, width: '92vw', padding: 24, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-heading" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="eyebrow" style={{ color: '#21d4d8', fontWeight: 600 }}>
              {recording.appName || 'ARTIFACT PREVIEW'} · {recording.caseId}
            </div>
            <h2 style={{ fontSize: 20, marginTop: 4, color: '#f8fafc' }}>
              {recording.caseName || recording.fileName || 'Recording Preview'}
            </h2>
            <div style={{ display: 'flex', gap: 10, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusBadge status={recording.status} />
              {recording.suiteName && <span style={{ fontSize: 12, color: '#94a3b8' }}>Suite: {recording.suiteName}</span>}
              {recording.createdAt && <span style={{ fontSize: 12, color: '#64748b' }}>· {new Date(recording.createdAt).toLocaleString()}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {mediaUrl && (
              <a href={mediaUrl} download className="button button-secondary" style={{ padding: '6px 12px', fontSize: 13 }} target="_blank" rel="noreferrer">
                Download
              </a>
            )}
            <button className="icon-button" onClick={close}><X size={18} /></button>
          </div>
        </div>

        <div style={{ background: '#070b14', borderRadius: 10, overflow: 'hidden', border: '1px solid #1e293b', minHeight: 380, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {isVideo && mediaUrl ? (
            <video controls autoPlay src={mediaUrl} style={{ width: '100%', maxHeight: '68vh', display: 'block' }} />
          ) : isScreenshot && mediaUrl ? (
            <img src={mediaUrl} alt={recording.caseId} style={{ maxWidth: '100%', maxHeight: '68vh', objectFit: 'contain' }} />
          ) : (
            <div className="video-placeholder" style={{ padding: 40, textAlign: 'center' }}>
              <Film size={48} color="#64748b" style={{ margin: '0 auto 12px' }} />
              <strong style={{ display: 'block', fontSize: 16, color: '#e2e8f0' }}>Artifact preview unavailable</strong>
              <span style={{ color: '#94a3b8', fontSize: 13 }}>The artifact file could not be loaded from the storage backend.</span>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

function Reports({ navigate }: { navigate: (p: Page) => void }) {
  const [runs, setRuns] = useState<Run[]>([])
  const [rangeFilter, setRangeFilter] = useState<'10' | '20' | 'all'>('10')

  useEffect(() => {
    fetch(`${API}/api/runs`)
      .then((response) => (response.ok ? response.json() : []))
      .then(setRuns)
      .catch(() => setRuns([]))
  }, [])

  const totalCases = runs.reduce((sum, r) => sum + r.total, 0)
  const totalPassed = runs.reduce((sum, r) => sum + r.passed, 0)
  const totalFailed = runs.reduce((sum, r) => sum + r.failed, 0)
  const passRate = totalCases > 0 ? Math.round((totalPassed / totalCases) * 100) : 0
  const partialRunCases = runs.filter((r) => r.status === 'Partial').reduce((s, r) => s + r.failed, 0)

  // Filter runs based on range selection
  const displayedRuns = rangeFilter === '10' ? runs.slice(-10) : rangeFilter === '20' ? runs.slice(-20) : runs

  const chartDataLocal = displayedRuns.map((r, index) => {
    const rawName = r.file ? r.file.replace(/\.csv$/i, '') : r.id.slice(-8)
    const shortLabel = displayedRuns.length > 15 ? `#${index + 1}` : rawName.length > 14 ? rawName.slice(0, 12) + '…' : rawName
    return {
      name: shortLabel,
      fullName: r.file || r.id,
      id: r.id,
      passed: r.passed,
      partial: r.status === 'Partial' ? r.failed : 0,
      failed: r.status === 'Partial' ? 0 : r.failed,
      total: r.total,
    }
  })

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
      <PageHeader
        eyebrow="ANALYTICS & INTELLIGENCE"
        title="Execution Reports"
        description="Comprehensive breakdown of automation pass rates, failure patterns, and run distributions."
      />

      {/* Top 4 Luxury Metric Cards */}
      <div className="metric-grid">
        <Metric icon={FileSpreadsheet} label="Total Executions" value={String(runs.length)} trend="Persisted Runs" color="violet" />
        <Metric icon={CheckCircle2} label="Cases Passed" value={String(totalPassed)} trend={totalCases ? `${passRate}% Pass Rate` : 'No Results'} color="cyan" />
        <Metric icon={AlertTriangle} label="Cases Failed" value={String(totalFailed)} trend={totalCases ? `${Math.round((totalFailed / totalCases) * 100)}% Failure` : 'No Results'} color="orange" />
        <Metric icon={Clock3} label="Total Cases Evaluated" value={String(totalCases)} trend="Full Portfolio" color="blue" />
      </div>

      {/* Chart 1: Results By Run (Stacked Bar with Gradients & Legend & Filter) */}
      <section className="card report-chart" style={{ padding: '26px 30px', background: '#0e1528', border: '1px solid #1e293b', borderRadius: 14 }}>
        <div className="card-heading" style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
          <div>
            <div className="eyebrow" style={{ color: '#21d4d8' }}>EXECUTION SEQUENCE</div>
            <h2 style={{ fontSize: 20, color: '#f8fafc', marginTop: 4 }}>Results by Run</h2>
            <p style={{ fontSize: 13, color: '#94a3b8' }}>Case breakdown for each executed automation session</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            {/* Custom Glowing Legend */}
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#21d4d8' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#21d4d8', boxShadow: '0 0 8px #21d4d8' }} />
                <span>Passed</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#fbbf24' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#fbbf24', boxShadow: '0 0 8px #fbbf24' }} />
                <span>Partial</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#f43f5e' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#f43f5e', boxShadow: '0 0 8px #f43f5e' }} />
                <span>Failed</span>
              </div>
            </div>

            {/* Range Toggle Pill Bar */}
            <div style={{ display: 'flex', background: '#090e1c', padding: 4, borderRadius: 8, border: '1px solid #1e293b' }}>
              <button
                style={{
                  border: 'none',
                  background: rangeFilter === '10' ? '#17223b' : 'transparent',
                  color: rangeFilter === '10' ? '#21d4d8' : '#94a3b8',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onClick={() => setRangeFilter('10')}
              >
                Last 10
              </button>
              <button
                style={{
                  border: 'none',
                  background: rangeFilter === '20' ? '#17223b' : 'transparent',
                  color: rangeFilter === '20' ? '#21d4d8' : '#94a3b8',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onClick={() => setRangeFilter('20')}
              >
                Last 20
              </button>
              <button
                style={{
                  border: 'none',
                  background: rangeFilter === 'all' ? '#17223b' : 'transparent',
                  color: rangeFilter === 'all' ? '#21d4d8' : '#94a3b8',
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onClick={() => setRangeFilter('all')}
              >
                All Runs ({runs.length})
              </button>
            </div>
          </div>
        </div>

        <div className="chart-wrap" style={{ height: 320 }}>
          {runs.length ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartDataLocal} margin={{ top: 12, right: 12, left: -16, bottom: 20 }}>
                <defs>
                  <linearGradient id="passed-bar-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#21d4d8" />
                    <stop offset="100%" stopColor="#059669" />
                  </linearGradient>
                  <linearGradient id="partial-bar-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fbbf24" />
                    <stop offset="100%" stopColor="#d97706" />
                  </linearGradient>
                  <linearGradient id="failed-bar-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#f43f5e" />
                    <stop offset="100%" stopColor="#be123c" />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12, fill: '#94a3b8' }}
                  axisLine={{ stroke: '#1e293b' }}
                  tickLine={false}
                  dy={8}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: '#94a3b8' }}
                  axisLine={{ stroke: '#1e293b' }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  content={({ active, payload, label }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload
                      return (
                        <div style={{ background: '#0a1020', border: '1px solid #1e293b', borderRadius: 10, padding: '12px 16px', boxShadow: '0 10px 30px rgba(0,0,0,0.6)', minWidth: 210 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#f8fafc', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {data.fullName || `Run ${label}`}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#21d4d8' }}>
                              <span>Passed:</span>
                              <strong>{data.passed} cases</strong>
                            </div>
                            {data.partial > 0 && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#fbbf24' }}>
                                <span>Partial:</span>
                                <strong>{data.partial} cases</strong>
                              </div>
                            )}
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#f43f5e' }}>
                              <span>Failed:</span>
                              <strong>{data.failed} cases</strong>
                            </div>
                            <div style={{ borderTop: '1px solid #1e293b', paddingTop: 6, marginTop: 4, display: 'flex', justifyContent: 'space-between', color: '#f8fafc', fontWeight: 700 }}>
                              <span>Total Cases:</span>
                              <span>{data.total}</span>
                            </div>
                          </div>
                        </div>
                      )
                    }
                    return null
                  }}
                />
                <Bar dataKey="passed" fill="url(#passed-bar-grad)" stackId="a" maxBarSize={38} />
                <Bar dataKey="partial" fill="url(#partial-bar-grad)" stackId="a" maxBarSize={38} />
                <Bar dataKey="failed" fill="url(#failed-bar-grad)" stackId="a" radius={[6, 6, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-recordings" style={{ padding: '60px 20px', textAlign: 'center' }}>
              <BarChart3 size={32} style={{ color: '#64748b', margin: '0 auto 10px' }} />
              <strong style={{ display: 'block', fontSize: 16 }}>No report data yet</strong>
              <span style={{ fontSize: 13, color: '#94a3b8' }}>Process a CSV or run browser test suites to populate analytics.</span>
            </div>
          )}
        </div>
      </section>

      {/* Chart 2: Overall Distribution (Luxury Donut with Center HUD + 3 Breakdown Cards) */}
      <section className="card report-chart" style={{ padding: '26px 30px', background: '#0e1528', border: '1px solid #1e293b', borderRadius: 14 }}>
        <div className="card-heading" style={{ marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="eyebrow" style={{ color: '#c4b5fd' }}>PORTFOLIO BREAKDOWN</div>
            <h2 style={{ fontSize: 20, color: '#f8fafc', marginTop: 4 }}>Overall Outcome Distribution</h2>
            <p style={{ fontSize: 13, color: '#94a3b8' }}>Cumulative case outcomes across all persisted execution sessions</p>
          </div>
          <div style={{ background: '#090e1c', border: '1px solid #1e293b', borderRadius: 8, padding: '7px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#94a3b8' }}>Total Processed:</span>
            <strong style={{ fontSize: 14, color: '#f8fafc' }}>{totalCases} Cases</strong>
          </div>
        </div>

        {totalCases > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 1fr) minmax(360px, 1.4fr)', gap: 36, alignItems: 'center' }}>
            {/* Left: Donut with Center HUD */}
            <div style={{ position: 'relative', height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <defs>
                    <linearGradient id="donut-passed-grad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#21d4d8" />
                      <stop offset="100%" stopColor="#10b981" />
                    </linearGradient>
                    <linearGradient id="donut-partial-grad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#fbbf24" />
                      <stop offset="100%" stopColor="#f59e0b" />
                    </linearGradient>
                    <linearGradient id="donut-failed-grad" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#f43f5e" />
                      <stop offset="100%" stopColor="#e11d48" />
                    </linearGradient>
                  </defs>
                  <Pie
                    data={[
                      { name: 'Passed', value: totalPassed },
                      { name: 'Partial', value: partialRunCases },
                      { name: 'Failed', value: Math.max(0, totalFailed - partialRunCases) },
                    ]}
                    cx="50%"
                    cy="50%"
                    innerRadius={82}
                    outerRadius={114}
                    paddingAngle={4}
                    cornerRadius={6}
                    dataKey="value"
                  >
                    <Cell fill="url(#donut-passed-grad)" stroke="#0e1528" strokeWidth={3} />
                    <Cell fill="url(#donut-partial-grad)" stroke="#0e1528" strokeWidth={3} />
                    <Cell fill="url(#donut-failed-grad)" stroke="#0e1528" strokeWidth={3} />
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload[0]) {
                        const item = payload[0]
                        const pct = totalCases > 0 ? Math.round((Number(item.value) / totalCases) * 100) : 0
                        return (
                          <div style={{ background: '#0a1020', border: '1px solid #1e293b', borderRadius: 8, padding: '10px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                            <div style={{ fontWeight: 700, color: '#f8fafc', fontSize: 13 }}>{item.name} Cases</div>
                            <div style={{ color: '#21d4d8', fontSize: 14, fontWeight: 800, marginTop: 2 }}>{item.value} ({pct}%)</div>
                          </div>
                        )
                      }
                      return null
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>

              {/* Center HUD */}
              <div style={{ position: 'absolute', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ fontSize: 36, fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.02em', lineHeight: 1 }}>
                  {passRate}%
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#21d4d8', textTransform: 'uppercase', marginTop: 5 }}>
                  Pass Rate
                </div>
              </div>
            </div>

            {/* Right: Rich KPI Outcome Cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Passed Outcome Card */}
              <div style={{ background: '#090e1c', border: '1px solid rgba(33, 212, 216, 0.25)', borderRadius: 10, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#21d4d8', boxShadow: '0 0 10px #21d4d8' }} />
                  <div>
                    <strong style={{ fontSize: 15, color: '#f8fafc', display: 'block' }}>Passed Cases</strong>
                    <small style={{ fontSize: 12, color: '#94a3b8' }}>Successfully completed without errors</small>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: '#21d4d8', display: 'block' }}>{totalPassed}</span>
                  <small style={{ fontSize: 12, color: '#64748b' }}>{totalCases > 0 ? Math.round((totalPassed / totalCases) * 100) : 0}% of portfolio</small>
                </div>
              </div>

              {/* Partial Outcome Card */}
              {partialRunCases > 0 && (
                <div style={{ background: '#090e1c', border: '1px solid rgba(251, 191, 36, 0.25)', borderRadius: 10, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fbbf24', boxShadow: '0 0 10px #fbbf24' }} />
                    <div>
                      <strong style={{ fontSize: 15, color: '#f8fafc', display: 'block' }}>Partial Execution</strong>
                      <small style={{ fontSize: 12, color: '#94a3b8' }}>Completed with warnings or skips</small>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: 20, fontWeight: 800, color: '#fbbf24', display: 'block' }}>{partialRunCases}</span>
                    <small style={{ fontSize: 12, color: '#64748b' }}>{totalCases > 0 ? Math.round((partialRunCases / totalCases) * 100) : 0}% of portfolio</small>
                  </div>
                </div>
              )}

              {/* Failed Outcome Card */}
              <div style={{ background: '#090e1c', border: '1px solid rgba(244, 63, 94, 0.25)', borderRadius: 10, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#f43f5e', boxShadow: '0 0 10px #f43f5e' }} />
                  <div>
                    <strong style={{ fontSize: 15, color: '#f8fafc', display: 'block' }}>Failed Cases</strong>
                    <small style={{ fontSize: 12, color: '#94a3b8' }}>Encountered assertion or locator failure</small>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: '#f43f5e', display: 'block' }}>{Math.max(0, totalFailed - partialRunCases)}</span>
                  <small style={{ fontSize: 12, color: '#64748b' }}>{totalCases > 0 ? Math.round((Math.max(0, totalFailed - partialRunCases) / totalCases) * 100) : 0}% of portfolio</small>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-recordings" style={{ padding: '60px 20px', textAlign: 'center' }}>
            <BarChart3 size={32} style={{ color: '#64748b', margin: '0 auto 10px' }} />
            <strong style={{ display: 'block', fontSize: 16 }}>No distribution data yet</strong>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>Execute test cases to view outcome proportions.</span>
          </div>
        )}
      </section>

      {/* Recent Runs Table */}
      <section className="card runs-card" style={{ padding: '24px 28px', background: '#0e1528', border: '1px solid #1e293b', borderRadius: 14 }}>
        <div className="card-heading" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="eyebrow">DETAILED AUDIT</div>
            <h2 style={{ fontSize: 20, marginTop: 4, color: '#f8fafc' }}>Recent Executions Log</h2>
            <p style={{ fontSize: 13, color: '#94a3b8' }}>Latest executed runs and case outcomes</p>
          </div>
          <button className="button button-secondary" onClick={() => navigate('runs')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>View All Runs</span>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run ID</th>
                <th>CSV Filename</th>
                <th>Cases</th>
                <th>Passed</th>
                <th>Failed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id.slice(-12)}</td>
                  <td>{r.file}</td>
                  <td>{r.total}</td>
                  <td className="success-text" style={{ color: '#21d4d8', fontWeight: 600 }}>{r.passed}</td>
                  <td className="danger-text" style={{ color: '#f43f5e', fontWeight: 600 }}>{r.failed}</td>
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

function SettingsPage() { return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><PageHeader eyebrow="CONFIGURATION" title="Settings" description="Manage demo preferences. Credentials are not stored in workflow definitions." /><div className="settings-grid"><section className="card settings-section"><h2>General</h2><p>Customize how Chronos looks and behaves.</p><label>Product name<input defaultValue="Chronos" /></label><label>Default date range<select><option>Last 7 days</option><option>Last 30 days</option></select></label><label>Theme preference<select><option>Dark (current)</option></select></label></section><section className="card settings-section"><h2>Automation preferences</h2><p>Defaults for simulated runs.</p><label>Default browser<select><option>Chromium</option></select></label><label>Recording preference<select><option>Capture when enabled</option><option>Always off</option></select></label><label>Retry count<select><option>2 retries</option><option>1 retry</option></select></label></section><section className="card settings-section"><h2>Oracle application</h2><p>Connection is reserved for a future backend.</p><label>Demo application URL<input defaultValue="https://demo.oracle-app.invalid" /></label><div className="connection-status"><span className="status-circle" />Not connected</div><div className="security-note"><ShieldCheck size={15} /> Credentials and authentication will be handled securely by the backend.</div></section><section className="card settings-section"><h2>Security &amp; data</h2><p>Your local preview remains in memory only.</p><div className="security-list"><div><ShieldCheck size={16} /><span><strong>Credentials are not stored in workflow definitions</strong><small>Choose the recording policy carefully; show-all recordings contain typed passwords.</small></span></div><div><FileSpreadsheet size={16} /><span><strong>Local file retention</strong><small>Clearing the workflow removes raw CSV data.</small></span></div></div><button className="button button-danger">Clear demo data</button></section></div></motion.div> }

type HcmInspectionApp = { id: string; name: string; base_url: string; auth_method: string; status: string }
type HcmSnapshot = {
  state: string
  pagePath: string
  snapshot: {
    ready: boolean
    message?: string
    title?: string
    headings?: string[]
    fields?: Array<{ label: string; kind: string; required: boolean; optionCount?: number; options: string[]; optionsRedacted?: boolean }>
    buttons?: string[]
    validationMessages?: string[]
  }
}

function OracleHcmHiringPage() {
  const [applications, setApplications] = useState<HcmInspectionApp[]>([])
  const [applicationId, setApplicationId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [inspectionId, setInspectionId] = useState('')
  const [state, setState] = useState('CLOSED')
  const [snapshot, setSnapshot] = useState<HcmSnapshot | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch(API + '/api/applications').then((response) => response.ok ? response.json() : Promise.reject())
      .then((rows: HcmInspectionApp[]) => {
        const target = rows.filter((row) => row.base_url === 'https://fa-erzp-dev26-saasfademo1.ds-fa.oraclepdemos.com' && row.auth_method === 'manual' && row.status === 'Active')
        setApplications(target)
        if (target.length === 1) setApplicationId(target[0].id)
      }).catch(() => setMessage('Could not load registered applications.'))
  }, [])

  const headers = () => ({ 'content-type': 'application/json', 'x-chronos-hr-token': accessToken })
  const start = async () => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(API + '/api/oracle-hcm/inspection', { method: 'POST', headers: headers(), body: JSON.stringify({ applicationId }) })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Inspection session could not start.')
      setInspectionId(payload.id); setState(payload.state); setSnapshot(null)
      setMessage('A protected Chromium window opened. Sign in manually there, then confirm here. No credentials, screenshots, video, or browser storage state are retained.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Inspection session could not start.') }
    finally { setBusy(false) }
  }
  const resume = async () => {
    if (!inspectionId) return
    setBusy(true)
    try {
      const response = await fetch(`${API}/api/oracle-hcm/inspection/${inspectionId}/resume`, { method: 'POST', headers: headers() })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Manual authentication was not confirmed.')
      setState(payload.state); setMessage('Authenticated read-only inspection is active. Use the Chromium window to reach the hiring wizard; actions requiring a POST remain blocked.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Manual authentication was not confirmed.') }
    finally { setBusy(false) }
  }
  const capture = async () => {
    if (!inspectionId) return
    setBusy(true)
    try {
      const response = await fetch(`${API}/api/oracle-hcm/inspection/${inspectionId}/snapshot`, { headers: { 'x-chronos-hr-token': accessToken } })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Could not inspect the current page.')
      setSnapshot(payload); setMessage(payload.snapshot.ready ? 'Visible wizard structure captured in memory for this session.' : payload.snapshot.message || 'No wizard structure was found.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not inspect the current page.') }
    finally { setBusy(false) }
  }
  const close = async () => {
    if (!inspectionId) return
    setBusy(true)
    try {
      await fetch(`${API}/api/oracle-hcm/inspection/${inspectionId}/close`, { method: 'POST', headers: headers() })
      setInspectionId(''); setState('CLOSED'); setSnapshot(null); setAccessToken(''); setMessage('Inspection browser closed and its in-memory session discarded.')
    } finally { setBusy(false) }
  }

  return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page browser-tests-page">
    <PageHeader eyebrow="ORACLE HCM · PHASE 1" title="Hiring wizard inspection" description="Manually authenticate in an isolated, read-only browser and capture only visible wizard structure." />
    <section className="card browser-test-import">
      <div className="card-heading"><div><div className="eyebrow">ACCESS CONTROLLED</div><h2>Protected inspection session</h2><p>The feature is disabled until CHRONOS_HR_ACCESS_TOKEN is configured with a random value of at least 32 characters. The token is held in page memory only.</p></div></div>
      {message && <div className="info-banner browser-test-message"><Info size={16} /><span>{message}</span></div>}
      <div className="browser-test-import-controls">
        <label>Registered Oracle HCM application<select value={applicationId} onChange={(event) => setApplicationId(event.target.value)}><option value="">Choose application</option>{applications.map((app) => <option key={app.id} value={app.id}>{app.name} · {app.base_url}</option>)}</select></label>
        <label>HR access token<input type="password" autoComplete="off" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} /></label>
      </div>
      <div className="browser-test-help"><strong>Privacy and network policy:</strong> inspect the blank wizard before entering employee data. If a text field contains a value, the snapshot is withheld. No screenshots, video, traces, cookies, input values, or auth state are captured or persisted. Only wizard labels, control types, required flags, eligible business dropdown options, buttons, and visible validation messages are returned. Login POSTs are allowed only to the same-origin password form action while the login gate is open. Other POSTs and unapproved origins stay blocked.</div>
      <div className="browser-test-approval-actions">
        {!inspectionId ? <button className="button button-primary" disabled={busy || !applicationId || accessToken.length < 32} onClick={start}>{busy ? 'Opening…' : 'Open manual login browser'}</button> : <>
          {state === 'WAITING_FOR_MANUAL_LOGIN' && <button className="button button-primary" disabled={busy} onClick={resume}>I signed in manually</button>}
          {state === 'AUTHENTICATED_READ_ONLY' && <button className="button button-primary" disabled={busy} onClick={capture}>{busy ? 'Inspecting…' : 'Capture visible wizard structure'}</button>}
          <button className="button button-secondary" disabled={busy} onClick={close}>Close session</button>
        </>}
        <span className="badge">{state.replaceAll('_', ' ')}</span>
      </div>
    </section>
    {snapshot?.snapshot.ready && <section className="card browser-test-history">
      <div className="card-heading"><div><div className="eyebrow">VOLATILE INSPECTION RESULT</div><h2>{snapshot.snapshot.title}</h2><p>Page path: {snapshot.pagePath} · This result is not written to run history.</p></div></div>
      <h3>Wizard headings</h3><ul>{snapshot.snapshot.headings?.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <h3>Visible fields and choices</h3><div className="table-wrap"><table><thead><tr><th>Field label</th><th>Control</th><th>Required</th><th>Choices</th></tr></thead><tbody>{snapshot.snapshot.fields?.map((field, index) => <tr key={index}><td>{field.label || 'Unlabeled control'}</td><td>{field.kind}</td><td>{field.required ? 'Yes' : 'No'}</td><td>{field.optionsRedacted ? 'Options omitted by privacy filter' : field.options?.join(', ') || (field.optionCount ? `${field.optionCount} options` : '—')}</td></tr>)}</tbody></table></div>
      <h3>Buttons and transitions</h3><p>{snapshot.snapshot.buttons?.join(' · ') || 'No buttons detected.'}</p>
      <h3>Visible validation messages</h3><ul>{snapshot.snapshot.validationMessages?.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </section>}
  </motion.div>
}

type BrowserTestApp = { id: string; name: string; base_url: string }
type RecordedWorkflowTemplate = { workflow_name: string; workflow_version: number; action_plan: Array<{ action: string; locator?: { name?: string; value?: string; kind?: string }; dataKey?: string }>; data_fields: Array<{ key: string; label: string; type: string }>; csv_template: string }
type WorkflowVersionSummary = { workflow_version: number; workflow_name: string; created_at: string }
type BrowserTestSuite = { id: string; name: string; application_name: string; case_count: number; created_at: string }
type BrowserTestCase = { id: string; case_key: string; name: string; priority: string; tags: string[]; plan: { version: string; actions: Array<{ action: string; requiresApproval?: boolean; requiresWriteApproval?: boolean; locator?: { kind: string; name?: string; value?: string } }> }; test_data_keys: string[]; expected_result: string }
type BrowserTestExecution = { id: string; status: string; case_id: string; case_key: string; case_name: string; suite_name: string; application_name: string; created_at?: string; actual_outcome?: string; error_code?: string; error_details?: string; video_status?: string; video_error?: string; policy_warnings?: Array<{ reasonCode: string; hostname?: string; category?: string }>; diagnostics?: Array<{ type: string; stage?: string; blockingComponent?: string; failureSource?: string; responseSource?: string; isMainFrameNavigation?: boolean; method?: string; origin?: string | null; path?: string | null; status?: number; resourceType?: string; message?: string; error?: string; reason?: string; hostname?: string; reasonCode?: string }>; steps?: Array<{ id: number; step_number: number; action: string; status: string; expected?: unknown; actual?: unknown; error_code?: string; error_details?: string }>; artifacts?: Array<{ id: string; kind: string; content_type: string }> }
type BrowserTestPreview = { rowNumber: number; testCaseId: string; name: string; priority: string; tags: string[]; testDataKeys: string[]; stepCount: number; errors: string[] }
const browserTestCsvTemplate = 'test_case_id,name,preconditions,steps,test_data,expected_result,priority,tags\n' +
  'TC001,Inspect login page,[],"Navigate to /login; Verify that the Sign In heading is visible",{},"Assert that the Sign In heading is visible",High,smoke\n'

function BrowserTestsPage() {
  const [activeTab, setActiveTab] = useState<'execution' | 'import' | 'docs'>('execution')
  const [applications, setApplications] = useState<BrowserTestApp[]>([])
  const [suites, setSuites] = useState<BrowserTestSuite[]>([])
  const [executions, setExecutions] = useState<BrowserTestExecution[]>([])
  const [cases, setCases] = useState<BrowserTestCase[]>([])
  const [applicationId, setApplicationId] = useState(() => window.localStorage.getItem('chronos-workflow-application') || '')
  const [suiteId, setSuiteId] = useState('')
  const [fileName, setFileName] = useState('')
  const [csvText, setCsvText] = useState('')
  const [preview, setPreview] = useState<BrowserTestPreview[]>([])
  const [selectedPreviewIds, setSelectedPreviewIds] = useState<string[]>([])
  const [previewErrors, setPreviewErrors] = useState<string[]>([])
  const [suiteName, setSuiteName] = useState('')
  const [selectedExecution, setSelectedExecution] = useState<BrowserTestExecution | null>(null)
  const [approvalCase, setApprovalCase] = useState<BrowserTestCase | null>(null)
  const [approvalChecked, setApprovalChecked] = useState(false)
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([])
  const [recordingDisabledCaseIds, setRecordingDisabledCaseIds] = useState<string[]>([])
  const [queuedCases, setQueuedCases] = useState<BrowserTestCase[]>([])
  const [runOptions, setRunOptions] = useState({ defaultTimeoutMs: 10000, recordVideo: true, captureScreenshotsOnFailure: true, stopOnFailure: false, recordingPolicy: 'show-all-values', reuseAuthenticatedSession: false, headed: true })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [workflowTemplate, setWorkflowTemplate] = useState<RecordedWorkflowTemplate | null>(null)
  const [workflowCsvDraft, setWorkflowCsvDraft] = useState('')
  const [workflowVersions, setWorkflowVersions] = useState<WorkflowVersionSummary[]>([])
  const [previewWorkflowVersion, setPreviewWorkflowVersion] = useState<number | null>(null)

  const refresh = async () => {
    const [appResponse, suiteResponse, runResponse] = await Promise.all([
      fetch(API + '/api/applications'), fetch(API + '/api/browser-tests/suites'), fetch(API + '/api/browser-tests/executions'),
    ])
    if (!appResponse.ok || !suiteResponse.ok || !runResponse.ok) throw new Error('Unable to load browser-test data.')
    const [appData, suiteData, runData] = await Promise.all([appResponse.json(), suiteResponse.json(), runResponse.json()])
    setApplications(appData.map((item: BrowserTestApp) => ({ id: item.id, name: item.name, base_url: item.base_url })))
    setSuites(suiteData)
    setExecutions(runData)
    if (applicationId && appData.some((item: BrowserTestApp) => item.id === applicationId)) window.localStorage.removeItem('chronos-workflow-application')
    else if (appData[0]) { window.localStorage.removeItem('chronos-workflow-application'); setApplicationId(appData[0].id) }
  }
  useEffect(() => { refresh().catch((error) => setMessage(error.message)) }, [])
  useEffect(() => {
    setWorkflowTemplate(null)
    setWorkflowCsvDraft('')
    setWorkflowVersions([])
    if (!applicationId) return
    let active = true
    Promise.all([
      fetch(API + '/api/applications/' + applicationId + '/workflow-template').then((response) => response.ok ? response.json() : null),
      fetch(API + '/api/applications/' + applicationId + '/workflow-versions').then((response) => response.ok ? response.json() : []),
    ]).then(([data, versions]) => { if (active) { setWorkflowTemplate(data); setWorkflowCsvDraft(data?.csv_template || ''); setWorkflowVersions(versions) } })
      .catch(() => { if (active) { setWorkflowTemplate(null); setWorkflowVersions([]) } })
    return () => { active = false }
  }, [applicationId])

  const loadWorkflowVersion = async (version: number) => {
    if (!applicationId) return
    setBusy(true); setMessage('')
    try {
      const response = await fetch(API + '/api/applications/' + applicationId + '/workflow-template?version=' + version)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to load that workflow version.')
      setWorkflowTemplate(data); setWorkflowCsvDraft(data.csv_template); setPreview([]); setPreviewWorkflowVersion(null)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to load workflow version.') }
    finally { setBusy(false) }
  }

  const chooseSuite = async (id: string) => {
    setSuiteId(id)
    setSelectedExecution(null)
    setSelectedCaseIds([])
    setQueuedCases([])
    if (!id) { setCases([]); return }
    const response = await fetch(API + '/api/browser-tests/suites/' + id + '/cases')
    if (!response.ok) throw new Error('Unable to load cases for this suite.')
    setCases(await response.json())
  }
  const previewCsvText = async (text: string, filename: string) => {
    setBusy(true); setMessage(''); setPreview([]); setPreviewErrors([]); setSelectedPreviewIds([])
    try {
      if (text.length > 2_000_000) throw new Error('CSV file must be 2 MB or smaller.')
      setFileName(filename); setSuiteName(filename.replace(/\.csv$/i, '')); setCsvText(text)
      const normalizedHeaders = (Papa.parse<string[]>(text, { skipEmptyLines: true }).data[0] || []).map((header) => String(header).trim().toLowerCase().replace(/[\s-]+/g, '_'))
      const selectedVersion = workflowTemplate && !normalizedHeaders.includes('test_data') ? workflowTemplate.workflow_version : null
      setPreviewWorkflowVersion(selectedVersion)
      const response = await fetch(API + '/api/browser-tests/import/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicationId, filename, csvText: text, workflowVersion: selectedVersion }),
      })
      const data = await response.json()
      setPreview(data.rows || [])
      setSelectedPreviewIds((data.rows || []).filter((row: BrowserTestPreview) => !row.errors.length).map((row: BrowserTestPreview) => row.testCaseId))
      setPreviewErrors([...(data.errors || []), ...((data.rowErrors || []).flatMap((row: { rowNumber: number; errors: string[] }) => row.errors.map((error) => 'CSV row ' + row.rowNumber + ': ' + error)))])
      if (data.valid) setMessage('Preview is valid. Review the cases, then import the suite.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'CSV preview failed.') }
    finally { setBusy(false) }
  }
  const previewFile = async (file?: File) => {
    if (!file) return
    if (file.size > 2_000_000) { setMessage('CSV file must be 2 MB or smaller.'); return }
    await previewCsvText(await file.text(), file.name)
  }
  const importSuite = async () => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(API + '/api/browser-tests/import', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applicationId, filename: fileName, name: suiteName || fileName, csvText, selectedCaseIds: selectedPreviewIds, workflowVersion: previewWorkflowVersion }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Import failed.')
      await refresh()
      await chooseSuite(data.id)
      setMessage('Imported ' + data.case_count + ' validated cases.')
      setPreview([]); setCsvText('')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Import failed.') }
    finally { setBusy(false) }
  }
  const loadExecution = async (id: string) => {
    const response = await fetch(API + '/api/browser-tests/executions/' + id)
    if (!response.ok) throw new Error('Unable to load execution details.')
    const data = await response.json()
    setSelectedExecution(data)
    return data as BrowserTestExecution
  }
  const runCase = async (item: BrowserTestCase, approved: boolean, allowWrites = false): Promise<string> => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(API + '/api/browser-tests/cases/' + item.id + '/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approveInteractions: approved, allowWrites, defaultTimeoutMs: runOptions.defaultTimeoutMs, recordVideo: runOptions.recordVideo && !recordingDisabledCaseIds.includes(item.id), recordingPolicy: runOptions.recordingPolicy, reuseAuthenticatedSession: runOptions.reuseAuthenticatedSession, captureScreenshotsOnFailure: runOptions.captureScreenshotsOnFailure, headless: !runOptions.headed }),
      })
      const started = await response.json()
      if (!response.ok) throw new Error(started.error || 'Could not start this test.')
      setApprovalCase(null); setApprovalChecked(false)
      setMessage('Execution queued. Step results are saved as the test runs.')
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const latest = await loadExecution(started.id)
        if (['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'INTERRUPTED', 'CANCELLED'].includes(latest.status)) break
      }
      await refresh()
      return (await loadExecution(started.id)).status
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Execution failed.') }
    finally { setBusy(false) }
    return 'FAILED'
  }
  const runCases = async (items: BrowserTestCase[]) => {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const needsApproval = item.plan?.actions?.some((action) => action.requiresApproval)
      const active = executions.some((run) => run.case_id === item.id && ['QUEUED', 'RUNNING'].includes(run.status))
      if (active) continue
      if (needsApproval) {
        setQueuedCases(items.slice(index + 1))
        setApprovalCase(item)
        setApprovalChecked(false)
        return
      }
      const status = await runCase(item, false)
      if (runOptions.stopOnFailure && ['FAILED', 'BLOCKED'].includes(status)) {
        const skipped = items.slice(index + 1)
        for (const pending of skipped) {
          const response = await fetch(API + '/api/browser-tests/cases/' + pending.id + '/skip', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'Skipped after ' + item.case_key + ' failed.' }),
          })
          if (!response.ok) throw new Error('Could not persist skipped status for ' + pending.case_key + '.')
        }
        await refresh()
        setSelectedCaseIds([])
        setQueuedCases([])
        setMessage('Stopped after ' + item.case_key + ' failed. ' + skipped.length + ' remaining case(s) were recorded as skipped.')
        return
      }
    }
    setSelectedCaseIds([])
    setQueuedCases([])
    setMessage('Finished starting the selected test cases. Each case has its own execution and recording.')
  }
  const runSelectedCases = async () => {
    const selected = cases.filter((item) => selectedCaseIds.includes(item.id))
    if (!selected.length) { setMessage('Select at least one test case to run.'); return }
    await runCases(selected)
  }
  const approveQueuedCase = async () => {
    if (!approvalCase) return
    const approvedCase = approvalCase
    const remaining = queuedCases
    setApprovalCase(null)
    setApprovalChecked(false)
    setQueuedCases([])
    const status = await runCase(approvedCase, true, approvalHasWrites)
    if (runOptions.stopOnFailure && ['FAILED', 'BLOCKED'].includes(status)) {
      for (const pending of remaining) {
        const response = await fetch(API + '/api/browser-tests/cases/' + pending.id + '/skip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Skipped after ' + approvedCase.case_key + ' failed.' }) })
        if (!response.ok) throw new Error('Could not persist skipped status for ' + pending.case_key + '.')
      }
      await refresh()
      setMessage('Stopped after ' + approvedCase.case_key + ' failed. ' + remaining.length + ' remaining case(s) were recorded as skipped.')
      return
    }
    await runCases(remaining)
  }
  const resumeLogin = async () => {
    if (!selectedExecution) return
    const response = await fetch(API + '/api/browser-tests/executions/' + selectedExecution.id + '/resume', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) { setMessage(data.error || 'Could not resume the test.'); return }
    setMessage('Manual login confirmed. The test is continuing.')
  }
  const cancelExecution = async () => {
    if (!selectedExecution) return
    const response = await fetch(API + '/api/browser-tests/executions/' + selectedExecution.id + '/cancel', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) { setMessage(data.error || 'Could not cancel the execution.'); return }
    setMessage('Cancellation requested. Any in-flight write is treated as uncertain and will not be retried.')
    await loadExecution(selectedExecution.id)
  }
  const previewIsValid = preview.length > 0 && selectedPreviewIds.length > 0 && preview.some((row) => selectedPreviewIds.includes(row.testCaseId) && row.errors.length === 0)
  const waitingForLogin = selectedExecution?.status === 'RUNNING' && selectedExecution.actual_outcome?.includes('Waiting for user')
  const approvalActions = approvalCase?.plan.actions.filter((action) => action.requiresApproval) || []
  const approvalHasWrites = approvalActions.some((action) => action.requiresWriteApproval)
  const approvalHasDelete = approvalActions.some((action) => action.action === 'delete')

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page browser-tests-page">
      <PageHeader
        eyebrow="WORKFLOW AUTOMATION"
        title="Workflow Tests"
        description="Execute deterministic workflow test cases, watch live browser execution, and inspect step-by-step results."
      />

      {message && (
        <div className="info-banner browser-test-message">
          <Info size={18} />
          <span>{message}</span>
        </div>
      )}

      {/* Primary Navigation Tabs */}
      <div className="workflow-tabs">
        <button
          className={`workflow-tab-btn ${activeTab === 'execution' ? 'active' : ''}`}
          onClick={() => setActiveTab('execution')}
        >
          <Play size={16} /> Test Suites & Execution {cases.length > 0 ? `(${cases.length})` : ''}
        </button>
        <button
          className={`workflow-tab-btn ${activeTab === 'import' ? 'active' : ''}`}
          onClick={() => setActiveTab('import')}
        >
          <Upload size={16} /> Import CSV Cases
        </button>
        <button
          className={`workflow-tab-btn ${activeTab === 'docs' ? 'active' : ''}`}
          onClick={() => setActiveTab('docs')}
        >
          <FileSpreadsheet size={16} /> Rule Syntax & Help
        </button>
      </div>

      {/* TAB 1: TEST SUITES & EXECUTION */}
      {activeTab === 'execution' && (
        <div className="workflow-tab-content">
          {/* Controls Bar */}
          <section className="card" style={{ padding: '20px 24px' }}>
            <div className="card-heading" style={{ marginBottom: 16 }}>
              <div>
                <div className="eyebrow">SUITE & EXECUTION CONTROLS</div>
                <h2>Execution Setup</h2>
              </div>
              <button className="button button-secondary" onClick={() => refresh().catch((error) => setMessage(error.message))}>
                Refresh Suites
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
              <div className="form-group">
                <label style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Target Application</label>
                <select
                  style={{ padding: '10px 14px', fontSize: 14, borderRadius: 8, background: '#111827', border: '1px solid #1f2937', color: '#f8fafc' }}
                  value={applicationId}
                  onChange={(event) => { setApplicationId(event.target.value); setPreview([]) }}
                >
                  <option value="">Choose an application</option>
                  {applications.map((app) => <option key={app.id} value={app.id}>{app.name} · {app.base_url}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Test Suite</label>
                <select
                  style={{ padding: '10px 14px', fontSize: 14, borderRadius: 8, background: '#111827', border: '1px solid #1f2937', color: '#f8fafc' }}
                  value={suiteId}
                  onChange={(event) => chooseSuite(event.target.value).catch((error) => setMessage(error.message))}
                >
                  <option value="">Select a test suite...</option>
                  {suites.map((suite) => (
                    <option key={suite.id} value={suite.id}>
                      {suite.name} ({suite.case_count} cases) · {suite.application_name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Run Options Switches */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #1e293b', display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center' }}>
              <label className="browser-test-approve-check" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#f1f5f9', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  style={{ width: 17, height: 17, accentColor: '#21d4d8' }}
                  checked={runOptions.headed}
                  onChange={(event) => setRunOptions((current) => ({ ...current, headed: event.target.checked }))}
                />
                <strong>Show Chromium browser window (Live automation)</strong>
                <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: 'rgba(33, 212, 216, 0.15)', color: '#21d4d8', border: '1px solid rgba(33, 212, 216, 0.3)' }}>VISIBLE CHROMIUM</span>
              </label>

              <label className="browser-test-approve-check" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#f1f5f9', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  style={{ width: 17, height: 17, accentColor: '#21d4d8' }}
                  checked={runOptions.recordVideo}
                  onChange={(event) => setRunOptions((current) => ({ ...current, recordVideo: event.target.checked }))}
                />
                <span>Record video</span>
              </label>

              <label className="browser-test-approve-check" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#f1f5f9', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  style={{ width: 17, height: 17, accentColor: '#21d4d8' }}
                  checked={runOptions.stopOnFailure}
                  onChange={(event) => setRunOptions((current) => ({ ...current, stopOnFailure: event.target.checked }))}
                />
                <span>Stop on first failure</span>
              </label>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                <span style={{ fontSize: 13, color: '#94a3b8' }}>Timeout:</span>
                <select
                  style={{ padding: '6px 12px', fontSize: 13, borderRadius: 6, background: '#111827', border: '1px solid #1f2937', color: '#e2e8f0' }}
                  value={runOptions.defaultTimeoutMs / 1000}
                  onChange={(event) => setRunOptions((current) => ({ ...current, defaultTimeoutMs: Number(event.target.value) * 1000 }))}
                >
                  <option value={5}>5 sec</option>
                  <option value={10}>10 sec</option>
                  <option value={20}>20 sec</option>
                  <option value={30}>30 sec</option>
                  <option value={60}>60 sec</option>
                </select>
              </div>
            </div>
          </section>

          {/* Test Cases Table */}
          {cases.length > 0 ? (
            <section className="card" style={{ padding: '22px 24px' }}>
              <div className="card-heading" style={{ marginBottom: 18 }}>
                <div>
                  <div className="eyebrow">AUTOMATED TEST SUITE</div>
                  <h2>Test Cases ({cases.length})</h2>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
                    Select cases to execute in batch or run individual tests.
                  </p>
                </div>
                <button
                  className="button button-primary"
                  disabled={busy || selectedCaseIds.length === 0}
                  onClick={() => runSelectedCases().catch((error) => setMessage(error.message))}
                  style={{ padding: '10px 18px', fontSize: 14 }}
                >
                  <Play size={16} /> Run Selected ({selectedCaseIds.length})
                </button>
              </div>

              <div className="table-wrap">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #1e293b', textAlign: 'left', color: '#94a3b8' }}>
                      <th style={{ padding: '12px 14px', width: 44 }}>
                        <input
                          aria-label="Select all test cases"
                          type="checkbox"
                          style={{ width: 16, height: 16, accentColor: '#21d4d8' }}
                          checked={cases.length > 0 && selectedCaseIds.length === cases.length}
                          onChange={(event) => setSelectedCaseIds(event.target.checked ? cases.map((item) => item.id) : [])}
                        />
                      </th>
                      <th style={{ padding: '12px 14px' }}>ID / Case</th>
                      <th style={{ padding: '12px 14px' }}>Priority & Tags</th>
                      <th style={{ padding: '12px 14px' }}>Plan Steps</th>
                      <th style={{ padding: '12px 14px' }}>Expected Outcome</th>
                      <th style={{ padding: '12px 14px', textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cases.map((item) => {
                      const needsApproval = item.plan?.actions?.some((action) => action.requiresApproval)
                      const active = executions.some((run) => run.case_id === item.id && ['QUEUED', 'RUNNING'].includes(run.status))
                      return (
                        <tr key={item.id} style={{ borderBottom: '1px solid #1e293b' }}>
                          <td style={{ padding: '14px' }}>
                            <input
                              aria-label={'Select ' + item.case_key}
                              type="checkbox"
                              style={{ width: 16, height: 16, accentColor: '#21d4d8' }}
                              disabled={active}
                              checked={selectedCaseIds.includes(item.id)}
                              onChange={(event) => setSelectedCaseIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))}
                            />
                          </td>
                          <td style={{ padding: '14px' }}>
                            <strong style={{ fontSize: 14, color: '#f8fafc', display: 'block' }}>{item.case_key}</strong>
                            <span style={{ fontSize: 12, color: '#94a3b8' }}>{item.name}</span>
                          </td>
                          <td style={{ padding: '14px' }}>
                            <span style={{ fontSize: 11, background: '#1e293b', padding: '3px 8px', borderRadius: 4, textTransform: 'capitalize', color: '#e2e8f0', fontWeight: 600 }}>
                              {item.priority}
                            </span>
                            {item.tags?.length ? (
                              <div style={{ marginTop: 4, fontSize: 11, color: '#64748b' }}>
                                {item.tags.join(', ')}
                              </div>
                            ) : null}
                          </td>
                          <td style={{ padding: '14px', maxWidth: 280 }}>
                            <span style={{ fontSize: 12, color: '#38bdf8', fontWeight: 600 }}>
                              {item.plan?.actions?.length || 0} automated actions
                            </span>
                            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.plan?.actions?.map((a) => a.action).join(' → ')}
                            </div>
                          </td>
                          <td style={{ padding: '14px', fontSize: 12, color: '#cbd5e1' }}>
                            {item.expected_result}
                          </td>
                          <td style={{ padding: '14px', textAlign: 'right' }}>
                            <button
                              className="button button-primary"
                              disabled={busy || active}
                              onClick={() => needsApproval ? (setApprovalCase(item), setApprovalChecked(false)) : runCase(item, false)}
                              style={{ padding: '8px 14px', fontSize: 13 }}
                            >
                              {active ? (
                                <>
                                  <Loader2 size={14} className="spin" /> Running...
                                </>
                              ) : needsApproval ? (
                                'Review & Approve'
                              ) : (
                                <>
                                  <Play size={14} /> Run Test
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : (
            <section className="card" style={{ padding: 48, textAlign: 'center' }}>
              <FileSpreadsheet size={44} style={{ color: '#6366f1', margin: '0 auto 12px' }} />
              <h3 style={{ fontSize: 18, color: '#f8fafc', margin: '0 0 8px' }}>No Test Suite Selected</h3>
              <p style={{ color: '#94a3b8', fontSize: 14, maxWidth: 440, margin: '0 auto 20px' }}>
                Select a test suite from the dropdown above to run cases, or switch to "Import CSV Cases" to create a new suite.
              </p>
              <button className="button button-secondary" onClick={() => setActiveTab('import')}>
                <Upload size={15} /> Import a CSV Test Suite
              </button>
            </section>
          )}

          {/* Active / Selected Execution Details */}
          {selectedExecution && (
            <section className="card" style={{ padding: '24px' }}>
              <div className="card-heading" style={{ marginBottom: 16 }}>
                <div>
                  <div className="eyebrow">EXECUTION DETAILS · {selectedExecution.id.slice(0, 8)}</div>
                  <h2>{selectedExecution.case_key} · {selectedExecution.case_name}</h2>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
                    {selectedExecution.actual_outcome || selectedExecution.error_details || 'Execution in progress...'}
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <StatusBadge status={selectedExecution.status} />
                  {['QUEUED', 'RUNNING'].includes(selectedExecution.status) && (
                    <button className="button button-danger" onClick={() => cancelExecution().catch((error) => setMessage(error.message))}>
                      Cancel Run
                    </button>
                  )}
                </div>
              </div>

              {waitingForLogin && (
                <div className="browser-test-auth-prompt" style={{ padding: 18, borderRadius: 10, marginBottom: 16 }}>
                  <strong>Manual login is open in the isolated browser window.</strong>
                  <span>Complete sign in in the browser window, then click resume below.</span>
                  <button className="button button-primary" onClick={resumeLogin} style={{ marginTop: 8 }}>
                    Resume After Manual Login
                  </button>
                </div>
              )}

              {selectedExecution.error_code && (
                <div className="exploration-warning-box" style={{ padding: 14, borderRadius: 8, marginBottom: 14 }}>
                  <strong>{selectedExecution.error_code}:</strong> {selectedExecution.error_details}
                </div>
              )}

              {/* Artifacts Links */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '16px 0', padding: '14px', background: '#0b1120', borderRadius: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Film size={15} /> Artifacts:
                </span>
                {selectedExecution.artifacts?.length ? (
                  selectedExecution.artifacts.map((artifact) => (
                    <a
                      key={artifact.id}
                      className="button button-secondary"
                      href={API + '/api/browser-tests/artifacts/' + artifact.id}
                      target="_blank"
                      rel="noreferrer"
                      style={{ padding: '6px 12px', fontSize: 12 }}
                    >
                      {artifact.kind === 'video' ? '▶ View Recording' : artifact.kind === 'screenshot' ? '📷 View Screenshot' : 'Download Trace'}
                    </a>
                  ))
                ) : (
                  <span style={{ fontSize: 12, color: '#64748b' }}>No video/screenshot generated yet.</span>
                )}
                <a
                  className="button button-secondary"
                  href={API + '/api/browser-tests/executions/' + selectedExecution.id + '/report'}
                  download
                  style={{ padding: '6px 12px', fontSize: 12, marginLeft: 'auto' }}
                >
                  Download Report JSON
                </a>
              </div>

              {/* Step Results Table */}
              {!!selectedExecution.steps?.length && (
                <div className="table-wrap" style={{ marginTop: 14 }}>
                  <table style={{ width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #1e293b', color: '#94a3b8' }}>
                        <th style={{ padding: '10px 12px', width: 60 }}>Step</th>
                        <th style={{ padding: '10px 12px' }}>Action</th>
                        <th style={{ padding: '10px 12px' }}>Status</th>
                        <th style={{ padding: '10px 12px' }}>Details / Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedExecution.steps.map((step) => (
                        <tr key={step.id} style={{ borderBottom: '1px solid #1e293b' }}>
                          <td style={{ padding: '10px 12px', fontWeight: 600 }}>{step.step_number}</td>
                          <td style={{ padding: '10px 12px', color: '#38bdf8' }}>{step.action}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: step.status === 'PASSED' ? '#14532d' : '#450a0a',
                              color: step.status === 'PASSED' ? '#4ade80' : '#f87171'
                            }}>
                              {step.status}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', color: '#94a3b8', fontFamily: 'monospace' }}>
                            {step.error_details || JSON.stringify(step.actual || step.expected || '')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* Recent Executions History Drawer */}
          <section className="card" style={{ padding: '20px 24px' }}>
            <div className="card-heading" style={{ marginBottom: 12 }}>
              <div>
                <div className="eyebrow">PERSISTED RUNS</div>
                <h2>Recent Executions</h2>
              </div>
            </div>
            {executions.length === 0 ? (
              <div className="empty-recordings" style={{ minHeight: 120 }}>
                <Activity size={24} />
                <span>No executions yet. Run a test case above.</span>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                {executions.slice(0, 12).map((run) => (
                  <button
                    key={run.id}
                    className="browser-test-run"
                    style={{
                      padding: '12px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      border: selectedExecution?.id === run.id ? '1px solid #38bdf8' : '1px solid #1e293b',
                      borderRadius: 8,
                      background: selectedExecution?.id === run.id ? '#13233e' : '#0b1120',
                      cursor: 'pointer'
                    }}
                    onClick={() => loadExecution(run.id).catch((error) => setMessage(error.message))}
                  >
                    <div style={{ textAlign: 'left', minWidth: 0 }}>
                      <strong style={{ fontSize: 13, color: '#f8fafc', display: 'block' }}>{run.case_key}</strong>
                      <span style={{ fontSize: 11, color: '#94a3b8', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {run.case_name}
                      </span>
                    </div>
                    <StatusBadge status={run.status} />
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB 2: IMPORT CSV CASES */}
      {activeTab === 'import' && (
        <section className="card" style={{ padding: '24px 28px' }}>
          <div className="card-heading" style={{ marginBottom: 16 }}>
            <div>
              <div className="eyebrow">TEST CASE IMPORT</div>
              <h2>Import Test Cases from CSV</h2>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>
                Upload or edit a CSV containing deterministic test cases for your registered applications.
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18, marginBottom: 20 }}>
            <div className="form-group">
              <label style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Target Application</label>
              <select
                style={{ padding: '10px 14px', fontSize: 14, borderRadius: 8, background: '#111827', border: '1px solid #1f2937', color: '#f8fafc' }}
                value={applicationId}
                onChange={(event) => { setApplicationId(event.target.value); setPreview([]) }}
              >
                <option value="">Choose an application</option>
                {applications.map((app) => <option key={app.id} value={app.id}>{app.name} · {app.base_url}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>Suite Name</label>
              <input
                style={{ padding: '10px 14px', fontSize: 14, borderRadius: 8, background: '#111827', border: '1px solid #1f2937', color: '#f8fafc' }}
                value={suiteName}
                onChange={(event) => setSuiteName(event.target.value)}
                placeholder="e.g. Oracle Fusion Smoke Tests"
              />
            </div>

            <div className="form-group">
              <label style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>CSV File Upload</label>
              <input
                type="file"
                accept=".csv,text/csv"
                style={{ padding: '8px 12px', fontSize: 13, borderRadius: 8, background: '#111827', border: '1px solid #1f2937', color: '#f8fafc' }}
                onChange={(event) => previewFile(event.currentTarget.files?.[0])}
              />
            </div>
          </div>

          {/* Template Download Banner */}
          <div style={{ padding: '14px 18px', background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <strong style={{ fontSize: 14, color: '#f8fafc' }}>
                {workflowTemplate ? `Recorded Template: ${workflowTemplate.workflow_name} (v${workflowTemplate.workflow_version})` : 'Standard Test Template'}
              </strong>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: '#94a3b8' }}>
                Download a pre-structured CSV template with matching column headers and sample data.
              </p>
            </div>
            {workflowTemplate ? (
              <a
                className="button button-primary"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(workflowTemplate.csv_template)}`}
                download="chronos-recorded-workflow-template.csv"
              >
                Download ${workflowTemplate.workflow_name} CSV
              </a>
            ) : (
              <a
                className="button button-secondary"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(browserTestCsvTemplate)}`}
                download="chronos-browser-tests-template.csv"
              >
                Download CSV Template
              </a>
            )}
          </div>

          {/* Template Draft Editor if template exists */}
          {workflowTemplate && (
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', display: 'block', marginBottom: 6 }}>
                Edit CSV Data Template
              </label>
              <textarea
                value={workflowCsvDraft}
                onChange={(event) => setWorkflowCsvDraft(event.target.value)}
                rows={6}
                spellCheck={false}
                style={{ width: '100%', padding: 12, borderRadius: 8, background: '#0b1120', border: '1px solid #1f2937', color: '#e2e8f0', fontFamily: 'monospace', fontSize: 12 }}
              />
              <button
                className="button button-secondary"
                style={{ marginTop: 8 }}
                disabled={busy || !applicationId}
                onClick={() => previewCsvText(workflowCsvDraft, 'recorded-workflow.csv')}
              >
                Preview Edited Template
              </button>
            </div>
          )}

          {/* Preview Table */}
          {preview.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 15, color: '#f8fafc' }}>
                  Preview: {fileName} ({preview.length} rows)
                </strong>
                {previewIsValid && (
                  <button className="button button-primary" disabled={busy} onClick={importSuite}>
                    {busy ? 'Importing...' : `Import ${selectedPreviewIds.length} Valid Cases`}
                  </button>
                )}
              </div>

              <div className="table-wrap">
                <table style={{ width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #1e293b', color: '#94a3b8' }}>
                      <th style={{ padding: 10, width: 40 }}>Select</th>
                      <th style={{ padding: 10 }}>Row / ID</th>
                      <th style={{ padding: 10 }}>Case Name</th>
                      <th style={{ padding: 10 }}>Priority</th>
                      <th style={{ padding: 10 }}>Actions</th>
                      <th style={{ padding: 10 }}>Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row) => (
                      <tr key={row.rowNumber} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: 10 }}>
                          <input
                            type="checkbox"
                            aria-label={'Select CSV row ' + row.rowNumber}
                            disabled={row.errors.length > 0}
                            checked={selectedPreviewIds.includes(row.testCaseId)}
                            onChange={(event) => setSelectedPreviewIds((current) => event.target.checked ? [...current, row.testCaseId] : current.filter((id) => id !== row.testCaseId))}
                          />
                        </td>
                        <td style={{ padding: 10 }}>{row.rowNumber} · {row.testCaseId}</td>
                        <td style={{ padding: 10 }}><strong>{row.name}</strong></td>
                        <td style={{ padding: 10 }}>{row.priority}</td>
                        <td style={{ padding: 10 }}>{row.stepCount} steps</td>
                        <td style={{ padding: 10 }}>
                          {row.errors.length ? (
                            <span style={{ color: '#ef4444' }}>{row.errors.join('; ')}</span>
                          ) : (
                            <span style={{ color: '#22c55e' }}>Valid</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {previewErrors.length > 0 && (
            <ul className="browser-test-errors" style={{ marginTop: 14 }}>
              {previewErrors.slice(0, 15).map((error, index) => <li key={index}>{error}</li>)}
            </ul>
          )}
        </section>
      )}

      {/* TAB 3: RULE SYNTAX & DOCS */}
      {activeTab === 'docs' && (
        <section className="card" style={{ padding: '24px 28px' }}>
          <div className="card-heading" style={{ marginBottom: 14 }}>
            <div>
              <div className="eyebrow">DETERMINISTIC ACTION TEMPLATES</div>
              <h2>Supported Rule Syntax · Plan Version 1.0</h2>
            </div>
          </div>
          <pre style={{ padding: 18, borderRadius: 8, background: '#080e19', border: '1px solid #1e293b', color: '#b9f6e2', fontSize: 13, lineHeight: 1.8, overflow: 'auto' }}>
{`navigate: /path
click role=button[name="Continue"]
fill label="Email" <- \${test_data.email}
select label="Country" <- \${test_data.country}
check label="Accept terms"
uncheck label="Subscribe"
create role=button[name="Create"]
update role=button[name="Save"]
delete role=button[name="Delete"]
wait visible text="Ready" timeout=5000
read text="Result" as result
assert visible role=heading[name="Dashboard"]
assert text text="Status" contains "Complete"
assert url contains "/home"`}
          </pre>
          <p style={{ marginTop: 12, fontSize: 13, color: '#94a3b8', lineHeight: 1.6 }}>
            Interactive steps like <code>create</code>, <code>update</code>, and <code>delete</code> require per-run explicit approval and assertions to maintain security and integrity.
          </p>
        </section>
      )}

      {/* Approval Modal */}
      {approvalCase && (
        <div className="modal-backdrop browser-test-approval-backdrop">
          <section className="card browser-test-approval" role="dialog" aria-modal="true" aria-label="Approve interactive browser test" style={{ maxWidth: 640, width: '100%', padding: 26 }}>
            <div className="modal-heading" style={{ marginBottom: 14 }}>
              <div>
                <div className="eyebrow">RUN APPROVAL</div>
                <h2>{approvalCase.case_key} · {approvalCase.name}</h2>
              </div>
              <button className="icon-button" onClick={() => { setApprovalCase(null); setQueuedCases([]) }}>
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.6 }}>
              {approvalHasWrites
                ? 'This run includes application writes. Review each operation and explicitly enable writes for this run. Requests remain strictly restricted to the registered application origin.'
                : 'This plan clicks or changes form controls. Review the steps and approve this single run.'}
            </p>
            <ol className="browser-test-plan" style={{ margin: '14px 0', paddingLeft: 22, color: '#93c5fd', fontSize: 13, lineHeight: 1.7 }}>
              {approvalActions.map((action, index) => (
                <li key={index}>
                  <strong>{action.action}</strong>{action.locator ? ' · ' + (action.locator.name || action.locator.value || action.locator.kind) : ''}{action.action === 'delete' ? ' · (deletes a record)' : ''}
                </li>
              ))}
            </ol>
            <label className="browser-test-approve-check" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0', fontSize: 13, color: '#f8fafc', cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ width: 18, height: 18, accentColor: '#21d4d8' }}
                checked={approvalChecked}
                onChange={(event) => setApprovalChecked(event.target.checked)}
              />
              <span>{approvalHasDelete ? 'Enable writes and authorize deletion.' : approvalHasWrites ? 'Enable writes and authorize create/update actions.' : 'I approve the interactive steps in this test run.'}</span>
            </label>
            <div className="browser-test-approval-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button className="button button-secondary" onClick={() => { setApprovalCase(null); setQueuedCases([]) }}>
                Cancel
              </button>
              <button className="button button-primary" disabled={!approvalChecked || busy} onClick={approveQueuedCase}>
                Approve and Run Once
              </button>
            </div>
          </section>
        </div>
      )}
    </motion.div>
  )
}

export default App
