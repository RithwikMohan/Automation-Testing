import { useEffect, useMemo, useState } from 'react'

const API = (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/$/, '')
const ACTIONS = ['navigate', 'click', 'fill', 'select', 'check', 'uncheck', 'wait_visible', 'assert_visible', 'assert_text', 'assert_url', 'assert_value'] as const
const LOCATORS = ['role', 'label', 'id', 'name', 'placeholder', 'css', 'xpath', 'text'] as const
type LocatorKind = typeof LOCATORS[number]
type Locator = { kind: LocatorKind; value?: string; role?: string; name?: string }
type ContextTarget = { strategy: 'table_intersection'; tableSelector: string; rowSelector: string; rowLabelSelector: string; headerSelector: string; rowCellSelector?: string; cellSelector: string; rowText: string; headerText: string; headerMatch: 'exact' | 'date' }
type WorkflowAction = { id: string; action: typeof ACTIONS[number] | 'create' | 'update' | 'delete'; name?: string; url?: string; locator?: Locator; locatorCandidates?: Locator[]; variableKey?: string; timeoutMs?: number; expected?: string; operator?: 'equals' | 'contains'; contextualTarget?: ContextTarget }
type WorkflowVariable = { key: string; label: string; type?: 'text' | 'number' | 'date' | 'email'; required?: boolean; defaultValue?: string; pattern?: string; variable?: boolean; sensitive?: boolean; credential?: boolean }
type Workflow = { applicationId: string; name: string; actions: WorkflowAction[]; variables: WorkflowVariable[]; version?: number }
type Application = { id: string; name: string; base_url: string }

const id = () => crypto.randomUUID()
const newLocator = (): Locator => ({ kind: 'label', value: '' })
const newAction = (action: WorkflowAction['action'], url = ''): WorkflowAction => ({ id: id(), action, ...(action === 'navigate' ? { url } : { locator: newLocator(), locatorCandidates: [newLocator()] }), ...(action === 'wait_visible' ? { timeoutMs: 10000 } : {}), ...(action === 'assert_url' ? { operator: 'contains', expected: '/' } : {}) })

function targetSummary(action: WorkflowAction) {
  if (action.action === 'navigate') return action.url || '(URL not configured)'
  if (action.action === 'assert_url') return `${action.operator} ${action.expected || '(path)'}`
  const target = action.contextualTarget
  if (target) return `Table cell: ${target.rowText.replaceAll('${', '{{').replaceAll('}', '}}')} · ${target.headerText.replaceAll('${', '{{').replaceAll('}', '}}')}`
  const locator = action.locator
  return locator ? locator.kind === 'role' ? `${locator.role} “${locator.name}”` : `${locator.kind}: ${locator.value}` : 'Target required'
}

function actionIssue(action: WorkflowAction, variables: WorkflowVariable[]) {
  if (action.action === 'navigate') { try { const url = new URL(action.url || ''); return ['http:', 'https:'].includes(url.protocol) ? '' : 'Enter an HTTP(S) URL.' } catch { return 'Enter a valid URL.' } }
  if (action.action === 'assert_url') return action.expected?.trim() ? '' : 'Enter an expected URL path.'
  if (action.contextualTarget) {
    const target = action.contextualTarget
    if ([target.tableSelector, target.rowSelector, target.rowLabelSelector, target.headerSelector, target.cellSelector, target.rowText, target.headerText].some((value) => !value?.trim())) return 'Complete all contextual table, row, column, and cell fields.'
  } else if (action.locator?.kind === 'role' ? !action.locator.role?.trim() || !action.locator.name?.trim() : !action.locator?.value?.trim()) return 'Configure a locator target.'
  if (['fill', 'select', 'assert_value'].includes(action.action) && !variables.some((variable) => variable.key === action.variableKey)) return 'Choose a defined workflow variable.'
  if (action.action === 'wait_visible' && (!Number.isInteger(action.timeoutMs) || Number(action.timeoutMs) < 100 || Number(action.timeoutMs) > 60000)) return 'Set timeout from 100 to 60,000 ms.'
  if (action.action === 'assert_text' && !action.expected?.trim()) return 'Enter expected text.'
  return ''
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function buildCsvTemplate(workflow: Workflow, version: number) {
  const variables = workflow.variables.filter((variable) => variable.variable !== false && (variable.sensitive !== true || variable.credential === true))
  const headers = ['test_case_id', 'name', 'preconditions', 'steps', ...variables.map((variable) => variable.key), 'expected_result', 'priority', 'tags']
  const locatorRule = (locator?: Locator) => !locator ? '' : locator.kind === 'role' ? `role=${locator.role}[name=${JSON.stringify(locator.name)}]` : locator.kind === 'css' ? `css=${locator.value}` : `${locator.kind}=${JSON.stringify(locator.value)}`
  const ruleForAction = (action: WorkflowAction) => {
    if (action.action === 'navigate') return `navigate: ${action.url || ''}`
    if (action.action === 'assert_url') return `assert url ${action.operator || 'contains'} ${JSON.stringify(action.expected || '')}`
    const locator = locatorRule(action.locator)
    if (['click', 'check', 'uncheck'].includes(action.action)) return `${action.action} ${locator}`
    if (['create', 'update', 'delete'].includes(action.action)) return `${action.action} ${locator}`
    if (['fill', 'select', 'assert_value'].includes(action.action)) return `${action.action === 'assert_value' ? 'assert value' : action.action} ${locator} <- \${test_data.${action.variableKey || ''}}`
    if (action.action === 'wait_visible') return `wait visible ${locator} timeout=${action.timeoutMs || 10000}`
    if (action.action === 'assert_visible') return `assert visible ${locator}`
    if (action.action === 'assert_text') return `assert text ${locator} contains ${JSON.stringify(action.expected || '')}`
    return ''
  }
  const finalAction = workflow.actions[workflow.actions.length - 1]
  const finalAssertion = finalAction?.action.startsWith('assert_') ? ruleForAction(finalAction) : ''
  const stepActions = finalAssertion ? workflow.actions.slice(0, -1) : workflow.actions
  const steps = stepActions.map(ruleForAction).filter(Boolean).join('\n')
  const row = ['TC001', `${workflow.name} case 1`, '[]', steps, ...variables.map((variable) => variable.defaultValue || ''), finalAssertion || 'assert visible text="Replace with expected result"', 'normal', `workflow-v${version}`]
  return [headers, row].map((items) => items.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

function normalizeSaved(application: Application, data: any): Workflow {
  const actions: WorkflowAction[] = (data.action_plan || []).map((action: any) => ({
    ...action,
    id: action.id || id(),
    variableKey: action.variableKey || action.dataKey,
    locatorCandidates: action.locatorCandidates || (action.locator ? [action.locator] : []),
    ...(action.contextualTarget ? { contextualTarget: action.contextualTarget } : {}),
  }))
  return { applicationId: application.id, name: data.workflow_name || `${application.name} workflow`, actions, variables: (data.data_fields || []).map((field: any) => ({ ...field, type: field.type || 'text' })), version: data.workflow_version }
}

export function WorkflowBuilderModal({ application, onClose, onOpenTests }: { application: Application; onClose: () => void; onOpenTests: () => void }) {
  const [workflow, setWorkflow] = useState<Workflow>({ applicationId: application.id, name: `${application.name} workflow`, actions: [newAction('navigate', application.base_url)], variables: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [csvPreview, setCsvPreview] = useState('')
  const [csvErrors, setCsvErrors] = useState<string[]>([])
  const [fileName, setFileName] = useState('workflow-cases.csv')
  const [workflowVersion, setWorkflowVersion] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  const update = (fn: (current: Workflow) => Workflow) => { setHasUnsavedChanges(true); setWorkflow((current) => fn(current)) }
  const requiredVariableKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const action of workflow.actions) {
      if (action.variableKey && ['fill', 'select', 'assert_value'].includes(action.action)) keys.add(action.variableKey)
      for (const text of [action.contextualTarget?.rowText, action.contextualTarget?.headerText]) {
        for (const match of text?.matchAll(/\$\{([a-z][a-z0-9_]*)\}/g) || []) keys.add(match[1])
      }
    }
    return keys
  }, [workflow.actions])

  const load = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(`${API}/api/applications/${application.id}/workflow-template`)
      if (response.status === 404) { setNotice('No saved workflow yet. Add actions and save to create version 1.'); return }
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not load workflow.')
      setWorkflow(normalizeSaved(application, data)); setWorkflowVersion(data.workflow_version); setCsvPreview(data.csv_template || ''); setHasUnsavedChanges(false)
      setNotice(`Loaded saved workflow version ${data.workflow_version}.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load workflow.') }
    finally { setBusy(false); setLoaded(true) }
  }
  useEffect(() => { void load() }, [application.id])

  useEffect(() => {
    if (!loaded) return
    const templateVersion = hasUnsavedChanges ? (workflowVersion || workflow.version || 0) + 1 : workflowVersion || workflow.version || 1
    setCsvPreview(buildCsvTemplate(workflow, templateVersion))
  }, [loaded, workflow, workflowVersion, hasUnsavedChanges])

  const post = async (operation: 'validate' | 'preview' | 'save') => {
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(`${API}/api/applications/${application.id}/workflow-template/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(workflow) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Workflow request failed.')
      if (operation === 'validate') setNotice(`Workflow is valid: ${data.actionCount} actions, ${data.variableCount} variables${data.hasAssertion ? ', assertion configured' : ', add a success assertion before running'}.`)
      if (operation === 'preview') { setCsvPreview(data.csv_template); setNotice('CSV template preview refreshed from the configured variable schema.') }
      if (operation === 'save') { setWorkflowVersion(data.workflow_version); setWorkflow((current) => ({ ...current, version: data.workflow_version })); setHasUnsavedChanges(false); setCsvPreview(data.csv_template || ''); setNotice(`Saved as workflow version ${data.workflow_version}.`) }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Workflow request failed.') }
    finally { setBusy(false) }
  }

  const uploadCsv = async (file?: File) => {
    if (!file) return
    if (hasUnsavedChanges) { setError('Save a new workflow version before validating a CSV template for these edits.'); return }
    if (!workflowVersion) { setError('Save this workflow first, then validate a CSV against its saved version.'); return }
    setFileName(file.name)
    setBusy(true); setCsvErrors([]); setError('')
    try {
      const csvText = await file.text()
      const response = await fetch(`${API}/api/browser-tests/import/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ applicationId: application.id, filename: file.name, csvText, workflowVersion }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'CSV validation failed.')
      const errors = [...(data.errors || []), ...(data.rows || []).flatMap((row: any) => (row.errors || []).map((message: string) => `Row ${row.rowNumber}: ${message}`))]
      setCsvErrors(errors); setNotice(errors.length ? `CSV validation found ${errors.length} issue(s).` : `${data.rows?.length || 0} CSV rows are valid for this workflow.`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'CSV validation failed.') }
    finally { setBusy(false) }
  }

  const download = () => {
    if (!csvPreview) return
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csvPreview], { type: 'text/csv;charset=utf-8' })); link.download = 'chronos-workflow-template.csv'; link.click(); URL.revokeObjectURL(link.href)
  }

  const patchAction = (index: number, patch: Partial<WorkflowAction>) => update((current) => ({ ...current, actions: current.actions.map((action, i) => i === index ? { ...action, ...patch } : action) }))
  const setLocator = (index: number, locator: Locator) => patchAction(index, { locator, locatorCandidates: [locator], contextualTarget: undefined })
  const move = (index: number, direction: -1 | 1) => update((current) => { const actions = [...current.actions]; const target = index + direction; if (target < 0 || target >= actions.length) return current; [actions[index], actions[target]] = [actions[target], actions[index]]; return { ...current, actions } })

  const addVariable = () => update((current) => ({ ...current, variables: [...current.variables, { key: `variable_${current.variables.length + 1}`, label: `Variable ${current.variables.length + 1}`, type: 'text', required: true }] }))
  const removeVariable = (key: string) => update((current) => ({
    ...current,
    variables: current.variables.filter((variable) => variable.key !== key),
    actions: current.actions.filter((action) => action.variableKey !== key && ![action.contextualTarget?.rowText, action.contextualTarget?.headerText].some((text) => text?.includes(`\${${key}}`))),
  }))
  const patchVariable = (index: number, patch: Partial<WorkflowVariable>) => update((current) => {
    const oldKey = current.variables[index]?.key
    const nextKey = patch.key
    return { ...current,
      variables: current.variables.map((variable, i) => i === index ? { ...variable, ...patch } : variable),
      actions: nextKey && oldKey && nextKey !== oldKey ? current.actions.map((action) => ({
        ...action,
        ...(action.variableKey === oldKey ? { variableKey: nextKey } : {}),
        ...(action.contextualTarget ? { contextualTarget: { ...action.contextualTarget, rowText: action.contextualTarget.rowText.replaceAll(`\${${oldKey}}`, `\${${nextKey}}`), headerText: action.contextualTarget.headerText.replaceAll(`\${${oldKey}}`, `\${${nextKey}}`) } } : {}),
      })) : current.actions,
    }
  })

  return <div className="modal-backdrop workflow-builder-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="card workflow-builder" role="dialog" aria-modal="true" aria-label="Workflow Builder">
      <div className="modal-heading"><div><div className="eyebrow">WORKFLOW BUILDER · {application.name}</div><h2>{workflow.name || 'New workflow'}{workflowVersion ? ` · v${workflowVersion}` : ''}</h2></div><button className="icon-button" onClick={onClose}>×</button></div>
      {error && <div className="info-banner info-banner-error" role="alert">{error}</div>}{notice && <div className="info-banner" role="status">{notice}</div>}
      <div className="workflow-editor-heading"><label>Workflow name<input value={workflow.name} maxLength={120} onChange={(event) => update((current) => ({ ...current, name: event.target.value }))} /></label><label>Application URL<span>{application.base_url}</span></label></div>
      <section className="workflow-editor-section"><div className="card-heading"><div><h3>Actions in execution order</h3><p>Simple targets use explicit locators. Contextual targets resolve one configured table cell.</p></div><select aria-label="Add action type" value="" onChange={(event) => { if (event.target.value) update((current) => ({ ...current, actions: [...current.actions, newAction(event.target.value as WorkflowAction['action'])] })) }}><option value="">＋ Add action</option>{ACTIONS.map((action) => <option key={action} value={action}>{action.replaceAll('_', ' ')}</option>)}</select></div>
        {!workflow.actions.length && <p className="muted">Add an action to begin.</p>}
        {workflow.actions.map((action, index) => { const issue = actionIssue(action, workflow.variables); return <article className="workflow-action-editor" key={action.id}><div className="workflow-action-top"><strong>{index + 1}. {action.name || action.action.replaceAll('_', ' ')}</strong><span>{targetSummary(action)}</span><em className={issue ? 'workflow-status-invalid' : 'workflow-status-valid'}>{issue ? 'Needs configuration' : 'Configured'}</em><div className="workflow-action-buttons"><button disabled={index === 0} onClick={() => move(index, -1)} title="Move up">↑</button><button disabled={index === workflow.actions.length - 1} onClick={() => move(index, 1)} title="Move down">↓</button><button onClick={() => update((current) => ({ ...current, actions: current.actions.flatMap((item, i) => i === index ? [{ ...item, id: id(), name: item.name ? `${item.name} copy` : undefined }, { ...item, id: id(), name: item.name ? `${item.name} copy 2` : undefined }] : [item]) }))}>Duplicate</button><button onClick={() => update((current) => ({ ...current, actions: current.actions.filter((_, i) => i !== index) }))}>Delete</button></div></div>{issue && <div className="workflow-error-inline">{issue}</div>}
          <div className="workflow-action-fields"><label>Action name<input value={action.name || ''} placeholder={`${action.action} ${index + 1}`} onChange={(event) => patchAction(index, { name: event.target.value })} /></label>
          {action.action === 'navigate' && <label>URL<input value={action.url || ''} placeholder="https://example.com/path" onChange={(event) => patchAction(index, { url: event.target.value })} /></label>}
          {action.action !== 'navigate' && action.action !== 'assert_url' && <>
            <label>Target type<select value={action.contextualTarget ? 'contextual' : action.locator?.kind || 'label'} onChange={(event) => { const kind = event.target.value as LocatorKind | 'contextual'; if (kind === 'contextual') patchAction(index, { contextualTarget: action.contextualTarget || { strategy: 'table_intersection', tableSelector: 'table', rowSelector: 'tbody tr', rowLabelSelector: 'th:first-child', headerSelector: 'thead th', rowCellSelector: 'th,td', cellSelector: 'input', rowText: '', headerText: '', headerMatch: 'exact' } }); else setLocator(index, kind === 'role' ? { kind, role: 'button', name: '' } : { kind, value: '' }) }}>{LOCATORS.map((kind) => <option key={kind} value={kind}>{kind === 'role' ? 'Accessible role and name' : kind === 'id' ? 'Element ID' : kind === 'name' ? 'Name attribute' : kind === 'css' ? 'CSS selector' : kind === 'xpath' ? 'XPath' : kind}</option>)}<option value="contextual">Contextual table cell</option></select></label>
            {action.contextualTarget ? <div className="workflow-context-fields"><label>Table CSS selector<input value={action.contextualTarget.tableSelector} onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, tableSelector: event.target.value } })} /></label><label>Row CSS selector<input value={action.contextualTarget.rowSelector} onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, rowSelector: event.target.value } })} /></label><label>Row label selector<input value={action.contextualTarget.rowLabelSelector} onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, rowLabelSelector: event.target.value } })} /></label><label>Row label / variable<input value={action.contextualTarget.rowText} placeholder="${project_name}" onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, rowText: event.target.value } })} /></label><label>Column header selector<input value={action.contextualTarget.headerSelector} onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, headerSelector: event.target.value } })} /></label><label>Column header / variable<input value={action.contextualTarget.headerText} placeholder="${work_date}" onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, headerText: event.target.value } })} /></label><label>Row cell selector<input value={action.contextualTarget.rowCellSelector || 'th,td'} onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, rowCellSelector: event.target.value } })} /></label><label>Target inside cell<input value={action.contextualTarget.cellSelector} onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, cellSelector: event.target.value } })} /></label><label>Date header matching<select value={action.contextualTarget.headerMatch} onChange={(event) => patchAction(index, { contextualTarget: { ...action.contextualTarget!, headerMatch: event.target.value as 'exact' | 'date' } })}><option value="exact">Exact text</option><option value="date">Normalize date (ISO or month/day/year)</option></select></label></div> : <>{action.locator?.kind === 'role' ? <><label>ARIA role<input value={action.locator.role || ''} onChange={(event) => setLocator(index, { ...action.locator!, role: event.target.value })} /></label><label>Accessible name<input value={action.locator.name || ''} onChange={(event) => setLocator(index, { ...action.locator!, name: event.target.value })} /></label></> : <label>Locator value<input value={action.locator?.value || ''} onChange={(event) => setLocator(index, { ...(action.locator || newLocator()), value: event.target.value })} /></label>}</>}
          </>}
          {['fill', 'select', 'assert_value'].includes(action.action) && <label>Workflow variable<select value={action.variableKey || ''} onChange={(event) => patchAction(index, { variableKey: event.target.value })}><option value="">Choose variable</option>{workflow.variables.map((variable) => <option key={variable.key} value={variable.key}>{variable.label} · {variable.key}</option>)}</select></label>}
          {action.action === 'wait_visible' && <label>Timeout (ms)<input type="number" min={100} max={60000} value={action.timeoutMs || 10000} onChange={(event) => patchAction(index, { timeoutMs: Number(event.target.value) })} /></label>}
          {action.action === 'assert_text' && <label>Expected text<input value={action.expected || ''} onChange={(event) => patchAction(index, { expected: event.target.value })} /></label>}
          {action.action === 'assert_url' && <><label>Match<select value={action.operator || 'contains'} onChange={(event) => patchAction(index, { operator: event.target.value as 'equals' | 'contains' })}><option value="contains">Contains</option><option value="equals">Equals</option></select></label><label>URL path<input value={action.expected || ''} placeholder="/success" onChange={(event) => patchAction(index, { expected: event.target.value })} /></label></>}
          {action.contextualTarget && <label>Fill/select value variable<select value={action.variableKey || ''} onChange={(event) => patchAction(index, { variableKey: event.target.value })}><option value="">Choose variable</option>{workflow.variables.map((variable) => <option key={variable.key} value={variable.key}>{variable.label} · {variable.key}</option>)}</select></label>}
          </div>
        </article>})}
      </section>
      <section className="workflow-editor-section"><div className="card-heading"><div><h3>CSV variables</h3><p>These definitions drive template columns and validation. Referenced: {Array.from(requiredVariableKeys).join(', ') || 'none'}.</p></div><button className="button button-secondary" onClick={addVariable}>＋ Add variable</button></div>
        {workflow.variables.map((variable, index) => <div className="workflow-variable-row" key={index}><label>Key<input value={variable.key} onChange={(event) => patchVariable(index, { key: event.target.value })} /></label><label>Label<input value={variable.label} onChange={(event) => patchVariable(index, { label: event.target.value })} /></label><label>Type<select value={variable.type || 'text'} onChange={(event) => patchVariable(index, { type: event.target.value as WorkflowVariable['type'] })}><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="email">Email</option></select></label><label>Default<input value={variable.defaultValue || ''} onChange={(event) => patchVariable(index, { defaultValue: event.target.value })} /></label><label>Pattern<input value={variable.pattern || ''} placeholder="Optional regex" onChange={(event) => patchVariable(index, { pattern: event.target.value })} /></label><label className="workflow-variable-required"><input type="checkbox" checked={variable.required !== false} onChange={(event) => patchVariable(index, { required: event.target.checked })} /> Required</label><span className={requiredVariableKeys.has(variable.key) ? 'workflow-status-valid' : 'workflow-status-invalid'}>{requiredVariableKeys.has(variable.key) ? 'Referenced' : 'Unused'}</span><button className="button button-danger" onClick={() => removeVariable(variable.key)}>Remove</button></div>)}
        {[...requiredVariableKeys].filter((key) => !workflow.variables.some((variable) => variable.key === key)).map((key) => <div className="workflow-error-inline" key={key}>Missing variable definition: {key}</div>)}
      </section>
      <section className="workflow-editor-section"><div className="card-heading"><div><h3>CSV template and test cases</h3><p>Template columns update automatically from the variables above. Save a new workflow version before uploading its template.</p></div><div className="workflow-toolbar"><button className="button button-secondary" disabled={busy} onClick={() => post('preview')}>Preview template</button><button className="button button-secondary" disabled={!csvPreview} onClick={download}>Download template</button></div></div>{csvPreview && <textarea className="workflow-csv-preview" aria-label="CSV template preview" readOnly value={csvPreview} rows={4} />}<label>Upload test case CSV<input type="file" accept=".csv,text/csv" disabled={busy || !workflowVersion || hasUnsavedChanges} onChange={(event) => void uploadCsv(event.target.files?.[0])} /></label>{hasUnsavedChanges && <p className="muted">The draft template is tagged for the next workflow version. Save that version before uploading it.</p>}{fileName && csvErrors.length > 0 && <div className="workflow-csv-errors">{csvErrors.map((item, index) => <div key={index}>{item}</div>)}</div>}{fileName && notice.includes('CSV rows are valid') && <strong className="workflow-valid">{notice}</strong>}</section>
      <div className="workflow-builder-actions"><button className="button button-secondary" disabled={busy} onClick={() => void load()}>Reload saved</button><button className="button button-secondary" disabled={busy || !loaded} onClick={() => post('validate')}>Validate workflow</button><button className="button button-secondary" disabled={busy} onClick={() => post('preview')}>Refresh CSV</button><button className="button button-primary" disabled={busy} onClick={() => post('save')}>{busy ? 'Saving…' : 'Save new version'}</button><button className="button button-primary" disabled={!workflowVersion} onClick={onOpenTests}>Open test suites</button></div>
    </section>
  </div>
}
