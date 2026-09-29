import { FormEvent, useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import './App.css'

type TabKey = 'overview' | 'elections' | 'tokens' | 'receipts' | 'ledger' | 'tally-audit'

type ElectionSummary = Awaited<ReturnType<typeof window.api.listElections>>[number]
type OverviewSnapshot = Awaited<ReturnType<typeof window.api.overview>>
type LedgerEntry = Awaited<ReturnType<typeof window.api.listLedger>>[number]
type ThresholdDetails = Awaited<ReturnType<typeof window.api.getThreshold>>
type ReceiptVerification = Awaited<ReturnType<typeof window.api.verifyReceipt>>
type TokenRecord = Awaited<ReturnType<typeof window.api.listTokens>>[number]
type TallyResult = Awaited<ReturnType<typeof window.api.runTally>>
type AuditResult = Awaited<ReturnType<typeof window.api.runAudit>>

const emptyThreshold: ThresholdDetails = {
  keyFile: '',
  shareFiles: [],
  threshold: {
    totalShares: 0,
    requiredShares: 0
  }
}

function App(): JSX.Element {
  const [tab, setTab] = useState<TabKey>('overview')
  const [overview, setOverview] = useState<OverviewSnapshot | null>(null)
  const [elections, setElections] = useState<ElectionSummary[]>([])
  const [selectedElectionId, setSelectedElectionId] = useState<string>('')
  const [threshold, setThreshold] = useState<ThresholdDetails>(emptyThreshold)
  const [tokens, setTokens] = useState<TokenRecord[]>([])
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([])
  const [ledgerFilter, setLedgerFilter] = useState<string>('')
  const [tallyResult, setTallyResult] = useState<TallyResult | null>(null)
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null)
  const [receiptIdInput, setReceiptIdInput] = useState<string>('')
  const [receiptResult, setReceiptResult] = useState<ReceiptVerification | null>(null)
  const [feedback, setFeedback] = useState<string>('')
  const [errorText, setErrorText] = useState<string>('')
  const [busy, setBusy] = useState<boolean>(false)

  const [formElection, setFormElection] = useState({
    id: '',
    title: '',
    start: '',
    end: '',
    choices: ''
  })

  const [formToken, setFormToken] = useState({
    voterId: ''
  })

  const [formBallot, setFormBallot] = useState({
    voterId: '',
    choice: '',
    tokenJwt: '',
    ledgerUrl: ''
  })

  const [shareInput, setShareInput] = useState<string>('')
  const [auditSampling, setAuditSampling] = useState({ sampleRate: 1, minSample: 1 })

  const selectedElection = useMemo(() => {
    return elections.find((item) => item.id === selectedElectionId) ?? null
  }, [elections, selectedElectionId])

  const clearMessages = useCallback(() => {
    setFeedback('')
    setErrorText('')
  }, [])

  const notify = useCallback((message: string) => {
    setFeedback(message)
    setErrorText('')
  }, [])

  const reportError = useCallback((message: string) => {
    setFeedback('')
    setErrorText(message)
  }, [])

  const refreshOverview = useCallback(async () => {
    try {
      const snapshot = await window.api.overview()
      setOverview(snapshot)
    } catch (error) {
      reportError((error as Error).message)
    }
  }, [reportError])

  const refreshElections = useCallback(async () => {
    try {
      const records = await window.api.listElections()
      setElections(records)
      if (!records.find((item) => item.id === selectedElectionId)) {
        setSelectedElectionId('')
        setThreshold(emptyThreshold)
        setLedgerEntries([])
        setLedgerFilter('')
      }
    } catch (error) {
      reportError((error as Error).message)
    }
  }, [reportError, selectedElectionId])

  const refreshTokens = useCallback(async () => {
    try {
      const all = await window.api.listTokens()
      setTokens(all)
    } catch (error) {
      reportError((error as Error).message)
    }
  }, [reportError])

  const refreshLedger = useCallback(
    async (electionId?: string) => {
      try {
        const filterId = electionId ?? (ledgerFilter ? ledgerFilter : undefined)
        const rows = await window.api.listLedger(filterId ? { electionId: filterId } : undefined)
        setLedgerEntries(rows)
      } catch (error) {
        reportError((error as Error).message)
      }
    },
    [ledgerFilter, reportError]
  )

  const refreshThreshold = useCallback(
    async (electionId: string) => {
      try {
        const detail = await window.api.getThreshold({ electionId })
        setThreshold(detail)
        setShareInput(detail.shareFiles.map((share) => share.absolutePath).join('\n'))
      } catch (error) {
        setThreshold(emptyThreshold)
        reportError((error as Error).message)
      }
    },
    [reportError]
  )

  const bootstrapData = useCallback(async () => {
    await Promise.all([refreshOverview(), refreshElections(), refreshTokens()])
  }, [refreshOverview, refreshElections, refreshTokens])

  useEffect(() => {
    void bootstrapData()
  }, [bootstrapData])

  const handleCreateElection = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    clearMessages()
    if (!formElection.id.trim() || !formElection.title.trim()) {
      reportError('Provide an id and title for the election')
      return
    }

    const choices = formElection.choices
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)

    if (choices.length < 2) {
      reportError('Provide at least two choices (one per line)')
      return
    }

    const convertTime = (value: string): string =>
      value ? new Date(value).toISOString() : new Date().toISOString()

    setBusy(true)
    try {
      await window.api.createElection({
        id: formElection.id.trim(),
        title: formElection.title.trim(),
        startIso: convertTime(formElection.start),
        endIso: convertTime(formElection.end),
        choices
      })

      setFormElection({ id: '', title: '', start: '', end: '', choices: '' })
      notify('Election created')
      await refreshElections()
      await refreshOverview()
    } catch (error) {
      reportError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleSelectElection = async (electionId: string): Promise<void> => {
    clearMessages()
    setSelectedElectionId(electionId)
    setLedgerFilter(electionId)
    setTallyResult(null)
    setAuditResult(null)
    const election = elections.find((item) => item.id === electionId)
    if (election && election.choices.length > 0) {
      setFormBallot((prev) => ({ ...prev, choice: election.choices[0] }))
    }
    await Promise.all([refreshThreshold(electionId), refreshLedger(electionId)])
  }

  const handleDeleteElection = async (electionId: string): Promise<void> => {
    clearMessages()
    setBusy(true)
    try {
      await window.api.deleteElection({ electionId })
      if (selectedElectionId === electionId) {
        setSelectedElectionId('')
        setThreshold(emptyThreshold)
        setLedgerEntries([])
        setLedgerFilter('')
      }
      notify(`Election ${electionId} removed`)
      await Promise.all([refreshElections(), refreshOverview()])
    } catch (error) {
      reportError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleGenerateKeys = async (): Promise<void> => {
    if (!selectedElectionId) {
      reportError('Select an election first')
      return
    }
    clearMessages()
    setBusy(true)
    try {
      await window.api.generateKeys({ electionId: selectedElectionId })
      notify('Election keys generated and shares refreshed')
      await refreshThreshold(selectedElectionId)
    } catch (error) {
      reportError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleIssueToken = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!selectedElectionId) {
      reportError('Select an election before issuing tokens')
      return
    }
    if (!formToken.voterId.trim()) {
      reportError('Provide a voter id')
      return
    }

    clearMessages()
    setBusy(true)
    try {
      await window.api.issueToken({
        electionId: selectedElectionId,
        voterId: formToken.voterId.trim()
      })
      notify('Token issued')
      setFormToken({ voterId: '' })
      await refreshTokens()
      await refreshOverview()
    } catch (error) {
      reportError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleCastBallot = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!selectedElectionId) {
      reportError('Select an election before casting a ballot')
      return
    }
    if (!formBallot.choice) {
      reportError('Select a choice for the ballot')
      return
    }

    clearMessages()
    setBusy(true)
    try {
      await window.api.castBallot({
        electionId: selectedElectionId,
        voterId: formBallot.voterId.trim(),
        choice: formBallot.choice,
        tokenJwt: formBallot.tokenJwt.trim(),
        ledgerUrl: formBallot.ledgerUrl.trim() || undefined
      })
      notify('Ballot submitted to the ledger')
      setFormBallot({ voterId: '', choice: '', tokenJwt: '', ledgerUrl: '' })
      await refreshLedger(selectedElectionId)
      await refreshOverview()
    } catch (error) {
      reportError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const activeSharePaths = useMemo(() => {
    return shareInput
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
  }, [shareInput])

  const runTally = async (): Promise<void> => {
    if (!selectedElectionId) {
      reportError('Select an election to run the tally')
      return
    }
    setBusy(true)
    clearMessages()
    try {
      const result = await window.api.runTally({
        electionId: selectedElectionId,
        sharePaths: activeSharePaths.length > 0 ? activeSharePaths : undefined
      })
      setTallyResult(result)
      notify('Tally completed')
    } catch (error) {
      reportError((error as Error).message)
      setTallyResult(null)
    } finally {
      setBusy(false)
    }
  }

  const runAudit = async (): Promise<void> => {
    if (!selectedElectionId) {
      reportError('Select an election to run the audit')
      return
    }
    setBusy(true)
    clearMessages()
    try {
      const result = await window.api.runAudit({
        electionId: selectedElectionId,
        sharePaths: activeSharePaths.length > 0 ? activeSharePaths : undefined,
        sampleRate: auditSampling.sampleRate,
        minSample: auditSampling.minSample
      })
      setAuditResult(result)
      notify('Audit completed')
    } catch (error) {
      reportError((error as Error).message)
      setAuditResult(null)
    } finally {
      setBusy(false)
    }
  }

  const handleVerifyReceipt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const trimmedId = receiptIdInput.trim()
    if (!trimmedId) {
      reportError('Enter a receipt identifier to verify')
      return
    }

    clearMessages()
    setReceiptResult(null)
    setBusy(true)
    try {
      const result = await window.api.verifyReceipt({ receiptId: trimmedId })
      setReceiptResult(result)
      if (result.valid) {
        const indexLabel =
          typeof result.ledgerIndex === 'number' ? ` for ledger entry ${result.ledgerIndex}` : ''
        notify(`Receipt verified${indexLabel}`)
      } else {
        reportError('Receipt not found or invalid')
      }
    } catch (error) {
      setReceiptResult(null)
      reportError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const ledgerCount = useMemo(() => ledgerEntries.length, [ledgerEntries])

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Election Command Deck</h1>
        <nav>
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
            Overview
          </button>
          <button
            className={tab === 'elections' ? 'active' : ''}
            onClick={() => setTab('elections')}
          >
            Elections
          </button>
          <button
            className={tab === 'tokens' ? 'active' : ''}
            onClick={() => {
              setTab('tokens')
              void refreshTokens()
            }}
          >
            Tokens
          </button>
          <button className={tab === 'receipts' ? 'active' : ''} onClick={() => setTab('receipts')}>
            Receipts
          </button>
          <button
            className={tab === 'ledger' ? 'active' : ''}
            onClick={() => {
              setTab('ledger')
              void refreshLedger()
            }}
          >
            Ledger
          </button>
          <button
            className={tab === 'tally-audit' ? 'active' : ''}
            onClick={() => setTab('tally-audit')}
          >
            Tally & Audit
          </button>
        </nav>
      </header>

      {(feedback || errorText) && (
        <section className="alerts">
          {feedback && <div className="alert success">{feedback}</div>}
          {errorText && <div className="alert error">{errorText}</div>}
        </section>
      )}

      <main className="app-content">
        {tab === 'overview' && overview && (
          <section className="panel">
            <h2>System Snapshot</h2>
            <div className="metrics">
              <article>
                <span className="metric-number">{overview.totals.elections}</span>
                <span className="metric-label">Elections</span>
              </article>
              <article>
                <span className="metric-number">{overview.totals.tokens}</span>
                <span className="metric-label">Tokens</span>
              </article>
              <article>
                <span className="metric-number">{overview.totals.ledgerEntries}</span>
                <span className="metric-label">Ledger Entries</span>
              </article>
              <article>
                <span className="metric-number">{overview.totals.activeElections}</span>
                <span className="metric-label">Active Right Now</span>
              </article>
            </div>
            <footer className="panel-footer">Updated at {overview.timestamps.generatedAt}</footer>
          </section>
        )}

        {tab === 'elections' && (
          <section className="panel">
            <h2>Elections</h2>
            <div className="two-column">
              <div>
                <h3>Create</h3>
                <form className="stack" onSubmit={handleCreateElection}>
                  <label>
                    Identifier
                    <input
                      type="text"
                      value={formElection.id}
                      onChange={(event) =>
                        setFormElection((prev) => ({ ...prev, id: event.target.value }))
                      }
                      placeholder="spring-primary"
                    />
                  </label>
                  <label>
                    Title
                    <input
                      type="text"
                      value={formElection.title}
                      onChange={(event) =>
                        setFormElection((prev) => ({ ...prev, title: event.target.value }))
                      }
                      placeholder="Spring Primary"
                    />
                  </label>
                  <div className="grid-2">
                    <label>
                      Starts
                      <input
                        type="datetime-local"
                        value={formElection.start}
                        onChange={(event) =>
                          setFormElection((prev) => ({ ...prev, start: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Ends
                      <input
                        type="datetime-local"
                        value={formElection.end}
                        onChange={(event) =>
                          setFormElection((prev) => ({ ...prev, end: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Choices (one per line)
                    <textarea
                      rows={4}
                      value={formElection.choices}
                      onChange={(event) =>
                        setFormElection((prev) => ({ ...prev, choices: event.target.value }))
                      }
                      placeholder={'Alice\nBob'}
                    />
                  </label>
                  <button type="submit" disabled={busy}>
                    Create Election
                  </button>
                </form>
              </div>
              <div>
                <h3>Manage</h3>
                {elections.length === 0 && <p>No elections yet.</p>}
                <ul className="list">
                  {elections.map((record) => (
                    <li
                      key={record.id}
                      className={record.id === selectedElectionId ? 'active' : ''}
                    >
                      <div>
                        <strong>{record.title}</strong>
                        <span className="muted">{record.id}</span>
                      </div>
                      <div className="actions">
                        <button onClick={() => void handleSelectElection(record.id)}>View</button>
                        <button onClick={() => void handleDeleteElection(record.id)}>Delete</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {selectedElection && (
              <section className="section">
                <header>
                  <h3>Selected Election</h3>
                  <div className="muted">
                    {selectedElection.start_iso} → {selectedElection.end_iso}
                  </div>
                </header>
                <div className="section-body">
                  <div className="choices">
                    {selectedElection.choices.map((choice) => (
                      <span key={choice}>{choice}</span>
                    ))}
                  </div>
                  <div className="stack compact">
                    <button onClick={handleGenerateKeys} disabled={busy}>
                      Generate threshold keys
                    </button>
                    <div className="muted">Key file: {threshold.keyFile || '—'}</div>
                    {threshold.threshold.requiredShares > 0 && (
                      <div className="muted">
                        Requires {threshold.threshold.requiredShares} of{' '}
                        {threshold.threshold.totalShares} shares
                      </div>
                    )}
                    <details>
                      <summary>Key shares</summary>
                      <ul>
                        {threshold.shareFiles.map((share) => (
                          <li key={share.absolutePath}>
                            <code>{share.absolutePath}</code>
                            {!share.exists && <span className="muted"> (missing)</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>
                </div>
              </section>
            )}
          </section>
        )}

        {tab === 'tokens' && (
          <section className="panel">
            <h2>Tokens</h2>
            {!selectedElection && <p>Select an election to issue tokens.</p>}
            {selectedElection && (
              <form className="stack" onSubmit={handleIssueToken}>
                <label>
                  Voter identifier
                  <input
                    type="text"
                    value={formToken.voterId}
                    onChange={(event) => setFormToken({ voterId: event.target.value })}
                    placeholder="voter-123"
                  />
                </label>
                <button type="submit" disabled={busy}>
                  Issue token for {selectedElection.title}
                </button>
              </form>
            )}

            <h3>Issued Tokens</h3>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Election</th>
                    <th>Voter</th>
                    <th>Issued</th>
                    <th>Used</th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token) => (
                    <tr key={token.tokenId}>
                      <td className="mono">{token.tokenId}</td>
                      <td>{token.electionId}</td>
                      <td>{token.voterId}</td>
                      <td>{token.issuedAt}</td>
                      <td>{token.used ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'receipts' && (
          <section className="panel">
            <h2>Receipt Verification</h2>
            <form className="stack" onSubmit={handleVerifyReceipt}>
              <label>
                Receipt id
                <input
                  type="text"
                  value={receiptIdInput}
                  onChange={(event) => setReceiptIdInput(event.target.value)}
                  placeholder="receipt-123"
                />
              </label>
              <button type="submit" disabled={busy}>
                Verify receipt
              </button>
            </form>

            {receiptResult && (
              <section className="section">
                <div className="section-body">
                  <div className="stack compact">
                    <div>
                      <strong>Status:</strong> {receiptResult.valid ? 'Valid' : 'Invalid'}
                    </div>
                    <div>
                      <strong>Ledger entry:</strong>{' '}
                      {typeof receiptResult.ledgerIndex === 'number'
                        ? receiptResult.ledgerIndex
                        : '—'}
                    </div>
                    <div>
                      <strong>Election:</strong> {receiptResult.electionId ?? '—'}
                    </div>
                    <div>
                      <strong>Commitment:</strong>{' '}
                      {receiptResult.commitment ? (
                        <span className="mono">{receiptResult.commitment}</span>
                      ) : (
                        '—'
                      )}
                    </div>
                    {receiptResult.valid && receiptResult.electionId && (
                      <button
                        type="button"
                        onClick={() => {
                          setLedgerFilter(receiptResult.electionId ?? '')
                          setTab('ledger')
                          void refreshLedger(receiptResult.electionId ?? undefined)
                        }}
                      >
                        View in ledger
                      </button>
                    )}
                  </div>
                </div>
              </section>
            )}
          </section>
        )}

        {tab === 'ledger' && (
          <section className="panel">
            <h2>Ledger</h2>
            <div className="toolbar">
              <label>
                Election filter
                <select
                  value={ledgerFilter}
                  onChange={(event) => {
                    const value = event.target.value
                    setLedgerFilter(value)
                    void refreshLedger(value || undefined)
                  }}
                >
                  <option value="">All elections</option>
                  {elections.map((record) => (
                    <option key={record.id} value={record.id}>
                      {record.title}
                    </option>
                  ))}
                </select>
              </label>
              <span className="muted">{ledgerCount} entries</span>
            </div>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Election</th>
                    <th>Commitment</th>
                    <th>Timestamp</th>
                    <th>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map((entry) => (
                    <tr key={`${entry.electionId}-${entry.ledgerIndex}`}>
                      <td>{entry.ledgerIndex}</td>
                      <td>{entry.electionId}</td>
                      <td className="mono">{entry.commitment}</td>
                      <td>{entry.timestamp}</td>
                      <td className="mono">{entry.receiptId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === 'tally-audit' && selectedElection && (
          <section className="panel">
            <h2>Tally &amp; Audit</h2>
            <div className="two-column">
              <div>
                <h3>Run tally</h3>
                <div className="stack">
                  <label>
                    Key shares to use
                    <textarea
                      rows={6}
                      value={shareInput}
                      onChange={(event) => setShareInput(event.target.value)}
                      placeholder={'C:/keys/election-share-1.json'}
                    />
                  </label>
                  <button onClick={runTally} disabled={busy}>
                    Reconstruct &amp; tally
                  </button>
                  {tallyResult && (
                    <pre className="result-block">{JSON.stringify(tallyResult, null, 2)}</pre>
                  )}
                </div>
              </div>
              <div>
                <h3>Audit trail</h3>
                <div className="stack">
                  <div className="grid-2">
                    <label>
                      Sample rate
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={auditSampling.sampleRate}
                        onChange={(event) =>
                          setAuditSampling((prev) => ({
                            ...prev,
                            sampleRate: Number.parseInt(event.target.value, 10) || 1
                          }))
                        }
                      />
                    </label>
                    <label>
                      Minimum sample
                      <input
                        type="number"
                        min={1}
                        value={auditSampling.minSample}
                        onChange={(event) =>
                          setAuditSampling((prev) => ({
                            ...prev,
                            minSample: Number.parseInt(event.target.value, 10) || 1
                          }))
                        }
                      />
                    </label>
                  </div>
                  <button onClick={runAudit} disabled={busy}>
                    Run audit
                  </button>
                  {auditResult && (
                    <pre className="result-block">{JSON.stringify(auditResult, null, 2)}</pre>
                  )}
                </div>
              </div>
            </div>

            <section className="section">
              <h3>Cast ballot for testing</h3>
              <form className="grid-2" onSubmit={handleCastBallot}>
                <label>
                  Voter id
                  <input
                    type="text"
                    value={formBallot.voterId}
                    onChange={(event) =>
                      setFormBallot((prev) => ({ ...prev, voterId: event.target.value }))
                    }
                  />
                </label>
                <label>
                  Token JWT
                  <input
                    type="text"
                    value={formBallot.tokenJwt}
                    onChange={(event) =>
                      setFormBallot((prev) => ({ ...prev, tokenJwt: event.target.value }))
                    }
                  />
                </label>
                <label>
                  Choice
                  <select
                    value={formBallot.choice}
                    onChange={(event) =>
                      setFormBallot((prev) => ({ ...prev, choice: event.target.value }))
                    }
                  >
                    <option value="">Select</option>
                    {selectedElection.choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                </label>
                {/* <label>
                  Ledger URL (optional)
                  <input
                    type="text"
                    value={formBallot.ledgerUrl}
                    onChange={(event) =>
                      setFormBallot((prev) => ({ ...prev, ledgerUrl: event.target.value }))
                    }
                    placeholder="http://localhost:4000/submit"
                  />
                </label> */}
                <button className="full" type="submit" disabled={busy}>
                  Submit ballot
                </button>
              </form>
            </section>
          </section>
        )}

        {tab === 'tally-audit' && !selectedElection && (
          <section className="panel">
            <p>Select an election first.</p>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
