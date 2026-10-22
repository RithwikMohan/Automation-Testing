import { useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity, AlertTriangle, Archive, ArrowUpRight, BarChart3, Bell, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, CloudUpload, Copy, Edit3, ExternalLink, FileSpreadsheet, Film, GitBranch, Globe, Info, LayoutDashboard, List, Loader2, Menu, Play, Plus, Search, Settings as SettingsIcon, ShieldCheck, Sparkles, Tag, TrendingDown, TrendingUp, Upload, X, Zap } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

type Page = 'overview' | 'upload' | 'runs' | 'run-detail' | 'recordings' | 'reports' | 'settings' | 'applications' | 'create-automation' | 'automations'
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

const ENVIRONMENTS = ['Development', 'Testing', 'Staging', 'Production']
const AUTH_METHODS = ['none', 'manual', 'credential_reference', 'other']
const APP_CATEGORIES = ['Productivity', 'E-commerce', 'Finance', 'Internal Tool', 'CRM', 'ERP', 'Development', 'HR', 'Support', 'Other']
const TASK_CATEGORIES = ['Navigation', 'Form filling', 'Data extraction', 'Data validation', 'Record creation', 'Record update', 'Search', 'Custom task']
const API = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787').replace(/\/$/, '')

const chartData: { day: string; passed: number; failed: number }[] = []
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'applications', label: 'Applications', icon: Globe },
  { id: 'create-automation', label: 'Create Automation', icon: Sparkles },
  { id: 'automations', label: 'Task Definitions', icon: List },
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
function Metric({ icon: Icon, label, value, trend, color }: { icon: typeof Activity; label: string; value: string; trend: string; color: string }) { return <motion.div whileHover={{ y: -4 }} className={`metric card`}><div className={`metric-icon ${color}`}><Icon size={19} /></div><div className="metric-label">{label}</div><div className="metric-value">{value}</div><div className="metric-trend"><ArrowUpRight size={13} /> {trend}</div></motion.div> }
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

      <div className="info-banner exploration-gate" role="status">
        <ShieldCheck size={17} />
        <span><strong>Read-only browser inspection is unavailable.</strong> A controlled outbound network boundary is required before Chronos can safely open registered websites. No generic browser navigation is enabled.</span>
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
                <button className="text-button" onClick={() => { navigate('create-automation') }}>+ New task</button>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* Toast */}
      <AnimatePresence>
        {detailApp && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={() => setDetailApp(null)}><motion.div initial={{ y: 24 }} animate={{ y: 0 }} exit={{ y: 24 }} className="modal-panel card" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">REGISTERED APPLICATION</div><h2>{detailApp.name}</h2></div><button className="icon-button" onClick={() => setDetailApp(null)}><X size={18} /></button></div><p><strong>Base URL:</strong> {detailApp.base_url}</p><p><strong>Environment:</strong> {detailApp.environment} · <strong>Status:</strong> {detailApp.status}</p><p><strong>Authentication:</strong> {authMethodLabel(detailApp.auth_method)}</p>{detailApp.credential_ref && <p><strong>Credential reference:</strong> {detailApp.credential_ref}</p>}{detailApp.login_url && <p><strong>Login URL:</strong> {detailApp.login_url}</p>}{detailApp.category && <p><strong>Category:</strong> {detailApp.category}</p>}{detailApp.description && <p><strong>Description:</strong> {detailApp.description}</p>}{detailApp.notes && <p><strong>Notes:</strong> {detailApp.notes}</p>}<button className="button button-primary" onClick={() => { const selected = detailApp; setDetailApp(null); setEditApp(selected); setShowModal(true) }}>Edit application</button></motion.div></motion.div>}
        {toast && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="toast">
            <CheckCircle2 size={16} /> {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modal */}
      <AnimatePresence>
        {showModal && (
          <AppFormModal
            app={editApp}
            onClose={() => setShowModal(false)}
            onSaved={() => { setShowModal(false); load(); showToast(editApp ? 'Application updated.' : 'Application registered.') }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function AppFormModal({ app, onClose, onSaved }: { app: Application | null; onClose: () => void; onSaved: () => void }) {
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
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

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
            {errors.baseUrl && <span className="field-error">{errors.baseUrl}</span>}
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
  const previousPeriodRuns = (latestDate && sevenDaysAgo && fourteenDaysAgo) ? runs.filter((r) => { const d = new Date(r.created); return d >= fourteenDaysAgo && d < sevenDaysAgo }) : []

  const periodPassRate = (periodRuns: Run[]) => {
    const p = periodRuns.reduce((s, r) => s + r.passed, 0)
    const f = periodRuns.reduce((s, r) => r.status !== 'Partial' ? s + r.failed : s, 0)
    const t = p + f
    return t > 0 ? (p / t) * 100 : null
  }
  const currentRate = periodPassRate(currentPeriodRuns)
  const previousRate = periodPassRate(previousPeriodRuns)
  const trendChange = currentRate !== null && previousRate !== null ? currentRate - previousRate : null

  const ringRadius = 54
  const ringCircumference = 2 * Math.PI * ringRadius
  const ringOffset = ringCircumference - (passRate / 100) * ringCircumference

  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const sparklineData = dayLabels.map((day, i) => {
    const dayOffset = 6 - i
    const dayStart = latestDate ? new Date(latestDate.getTime() - dayOffset * 86400000) : null
    const dayEnd = dayStart ? new Date(dayStart.getTime() + 86400000) : null
    const dayRuns = dayStart && dayEnd ? runs.filter(r => { const d = new Date(r.created); return d >= dayStart && d < dayEnd }) : []
    const dayPassed = dayRuns.reduce((s, r) => s + r.passed, 0)
    const dayFailed = dayRuns.reduce((s, r) => r.status !== 'Partial' ? s + r.failed : s, 0)
    const dayTotal = dayPassed + dayFailed
    return {
      day,
      date: dayStart ? `${dayStart.getDate()}/${dayStart.getMonth() + 1}` : '',
      passed: dayPassed,
      failed: dayFailed,
      rate: dayTotal > 0 ? (dayPassed / dayTotal) * 100 : 0,
    }
  })

  return <motion.div key="overview" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page">
    <PageHeader eyebrow="DASHBOARD" title="Overview" description="Chronos automation platform — monitor reliability, activity, and test results." action={<button className="button button-primary" onClick={() => navigate('upload')}><CloudUpload size={16} /> Upload test cases</button>} />
    <div className="metric-grid">
      <Metric icon={Activity} label="Total cases" value={String(totals.total)} trend="All processed" color="violet" />
      <Metric icon={CheckCircle2} label="Passed" value={String(totals.passed)} trend={completed > 0 ? `${passRate.toFixed(1)}% pass rate` : 'No results yet'} color="cyan" />
      <Metric icon={AlertTriangle} label="Failed" value={String(totals.failed)} trend="Needs attention" color="orange" />
      <Metric icon={Clock3} label="Runs" value={String(runs.length)} trend="Total executed" color="blue" />
    </div>
    <div className="overview-grid">
      <section className="card reliability-card">
        {runs.length === 0 ? (
          <div className="reliability-empty">
            <Activity size={32} />
            <strong>No automation data yet</strong>
            <span>Upload a CSV and run the backend automation to see reliability metrics.</span>
          </div>
        ) : (
          <>
            <div className="reliability-header">
              <div>
                <div className="eyebrow">AUTOMATION RELIABILITY</div>
                <h2>Pass Rate</h2>
              </div>
              <div className="reliability-kpi-grid">
                <div className="kpi-item"><span className="kpi-value cyan">{totals.passed}</span><span className="kpi-label">Passed</span></div>
                <div className="kpi-item"><span className="kpi-value orange">{totals.failed}</span><span className="kpi-label">Failed</span></div>
                {totals.partial > 0 && <div className="kpi-item"><span className="kpi-value amber">{totals.partial}</span><span className="kpi-label">Partial</span></div>}
                {pending > 0 && <div className="kpi-item"><span className="kpi-value">{pending}</span><span className="kpi-label">Pending</span></div>}
              </div>
            </div>
            <div className="reliability-trend">
              <div className="trend-header">
                <div className="trend-title"><Clock3 size={13} /><span>7-Day Reliability Trend</span></div>
                {trendChange !== null ? (
                  <div className="trend-indicator">
                    <div className={`trend-value ${trendChange >= 0 ? 'trend-up' : 'trend-down'}`}>
                      {trendChange >= 0 ? '+' : ''}{trendChange.toFixed(1)} pts
                      {trendChange >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                    </div>
                    <span className="trend-label">vs previous period</span>
                  </div>
                ) : (
                  <div className="trend-indicator trend-empty"><span className="trend-label">Not enough historical data</span></div>
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
function RunDetails({ run, back }: { run: Run; back: () => void }) { const cases = run.cases || []; return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><button className="back-button" onClick={back}>← Back to test runs</button><PageHeader eyebrow={`RUN / ${run.id}`} title={run.file} description={`${run.created} · Persisted automation run`} action={<StatusBadge status={run.status} />} /><div className="metric-grid compact"><Metric icon={FileSpreadsheet} label="Total cases" value={String(run.total)} trend="Processed" color="violet" /><Metric icon={CheckCircle2} label="Passed" value={String(run.passed)} trend={run.total ? `${Math.round(run.passed / run.total * 100)}% pass rate` : 'No cases'} color="cyan" /><Metric icon={AlertTriangle} label="Failed" value={String(run.failed)} trend="Needs attention" color="orange" /><Metric icon={Clock3} label="Skipped" value={String(run.skipped)} trend={run.duration} color="blue" /></div><section className="card runs-card"><div className="card-heading"><div><h2>Test case results</h2><p>Each case includes artifacts captured for its isolated automation context.</p></div></div><div className="table-wrap"><table><thead><tr><th>Test case</th><th>Username</th><th>Target date</th><th>Project</th><th>Status</th><th>Artifacts</th><th>Message</th></tr></thead><tbody>{cases.map(c => <tr key={`${run.id}-${c.row_number}`}><td><strong>{c.case_id || `Row ${c.row_number}`}</strong></td><td className="mono">{c.username_masked || '—'}</td><td>{c.requested_date || '—'}</td><td>{c.project || '—'}</td><td><span className="badge">{c.status}</span></td><td>{c.artifacts?.length ? c.artifacts.map(artifact => <a key={artifact.kind} className="link-button" href={`${API}${artifact.url}`} target="_blank" rel="noreferrer">{artifact.kind}</a>) : '—'}</td><td>{c.message || '—'}</td></tr>)}</tbody></table></div></section></motion.div> }

function Recordings({ open }: { open: (recording?: Artifact) => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  useEffect(() => {
    Promise.all([
      fetch(`${API}/api/artifacts`),
      fetch(`${API}/api/runs`),
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
        setArtifacts([]); setRuns([])
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
function VideoModal({ close, recording }: { close: () => void; recording?: Artifact }) { return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-backdrop" onClick={close}><motion.div initial={{ y: 20 }} animate={{ y: 0 }} className="video-modal card" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">{recording?.readOnly ? 'READ-ONLY RECORDING' : 'DEMO RECORDING'} · {recording?.caseId || '—'}</div><h2>Recording preview</h2></div><button className="icon-button" onClick={close}><X size={18} /></button></div>{recording?.videoUrl ? <video className="real-video" controls autoPlay src={`${API}${recording.videoUrl}`} /> : <div className="video-placeholder"><Film size={42} /><strong>Recording will be available when the Playwright worker is connected.</strong><span>No browser session or real Oracle account was accessed.</span></div>}<div className="timeline"><div><span className="timeline-dot cyan" /><b>Login validation</b><small>Read-only</small></div><div><span className="timeline-dot violet" /><b>Authentication result</b><small>{recording?.status || 'Unavailable'}</small></div><div><span className="timeline-dot orange" /><b>Timesheet changes</b><small>None</small></div></div></motion.div></motion.div> }
function Reports({ navigate }: { navigate: (p: Page) => void }) {
  const [runs, setRuns] = useState<Run[]>([])
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
  const chartDataLocal = runs.map((r) => ({
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
        <div className="card-heading"><div><h2>Results by run</h2><p>Passed / Partial / Failed breakdown</p></div></div>
        <div className="chart-wrap">
          {runs.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartDataLocal}>
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
        <div className="card-heading"><div><h2>Overall distribution</h2><p>Case outcomes across all runs</p></div></div>
        <div className="chart-wrap">
          {totalCases > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={[{ name: 'Passed', value: totalPassed }, { name: 'Partial', value: partialRunCases }, { name: 'Failed', value: Math.max(0, totalFailed - partialRunCases) }]} cx="50%" cy="50%" innerRadius={60} outerRadius={80} fill="#8884d8" dataKey="value">
                  <Cell fill="#22c55e" /><Cell fill="#f59e0b" /><Cell fill="#ef4444" />
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
        <div className="card-heading"><div><h2>Recent runs</h2><p>Last 10 executed test runs</p></div><button className="text-button" onClick={() => navigate('runs')}>View all <ArrowUpRight size={14} /></button></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Run ID</th><th>CSV filename</th><th>Cases</th><th>Passed</th><th>Failed</th><th>Status</th></tr></thead>
            <tbody>{runs.slice(0, 10).map((r) => (<tr key={r.id}><td className="mono">{r.id.slice(-12)}</td><td>{r.file}</td><td>{r.total}</td><td className="success-text">{r.passed}</td><td className="danger-text">{r.failed}</td><td><StatusBadge status={r.status} /></td></tr>))}</tbody>
          </table>
        </div>
      </section>
    </motion.div>
  )
}
function SettingsPage() { return <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="page"><PageHeader eyebrow="CONFIGURATION" title="Settings" description="Manage demo preferences. Real credentials are never stored here." /><div className="settings-grid"><section className="card settings-section"><h2>General</h2><p>Customize how Chronos looks and behaves.</p><label>Product name<input defaultValue="Chronos" /></label><label>Default date range<select><option>Last 7 days</option><option>Last 30 days</option></select></label><label>Theme preference<select><option>Dark (current)</option></select></label></section><section className="card settings-section"><h2>Automation preferences</h2><p>Defaults for simulated runs.</p><label>Default browser<select><option>Chromium</option></select></label><label>Recording preference<select><option>Capture when enabled</option><option>Always off</option></select></label><label>Retry count<select><option>2 retries</option><option>1 retry</option></select></label></section><section className="card settings-section"><h2>Oracle application</h2><p>Connection is reserved for a future backend.</p><label>Demo application URL<input defaultValue="https://demo.oracle-app.invalid" /></label><div className="connection-status"><span className="status-circle" />Not connected</div><div className="security-note"><ShieldCheck size={15} /> Credentials and authentication will be handled securely by the backend.</div></section><section className="card settings-section"><h2>Security &amp; data</h2><p>Your local preview remains in memory only.</p><div className="security-list"><div><ShieldCheck size={16} /><span><strong>No credential persistence</strong><small>Passwords are never rendered, logged, or saved.</small></span></div><div><FileSpreadsheet size={16} /><span><strong>Local file retention</strong><small>Clearing the workflow removes raw CSV data.</small></span></div></div><button className="button button-danger">Clear demo data</button></section></div></motion.div> }

export default App
