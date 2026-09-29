/// <reference types="vite/client" />

import type { ElectronAPI } from '@electron-toolkit/preload'

type ElectionSummary = {
  id: string
  title: string
  start_iso: string
  end_iso: string
  choices: string[]
  hasKey: boolean
  keyFile: string | null
  shares: Array<{
    path: string
    absolutePath: string
    exists: boolean
    index: number | null
  }>
}

type OverviewSnapshot = {
  totals: {
    elections: number
    tokens: number
    ledgerEntries: number
    activeElections: number
  }
  timestamps: {
    generatedAt: string
  }
}

type LedgerEntry = {
  ledgerIndex: number
  commitment: string
  cipherRef: string
  electionId: string
  timestamp: string
  receiptId: string
}

type ThresholdDetails = {
  keyFile: string
  shareFiles: Array<{
    path: string
    absolutePath: string
    exists: boolean
    index: number | null
  }>
  threshold: {
    totalShares: number
    requiredShares: number
  }
}

type ReceiptVerification = {
  valid: boolean
  ledgerIndex: number | null
  commitment: string | null
  electionId: string | null
}

type TokenRecord = {
  tokenId: string
  electionId: string
  voterId: string
  issuedAt: string
  used: boolean
}

type TallyResult = Record<string, unknown>

type AuditResult = Record<string, unknown>

type BackendAPI = {
  overview: () => Promise<OverviewSnapshot>
  listElections: () => Promise<ElectionSummary[]>
  createElection: (payload: {
    id: string
    title: string
    startIso: string
    endIso: string
    choices: string[]
  }) => Promise<ElectionSummary>
  deleteElection: (payload: { electionId: string }) => Promise<void>
  generateKeys: (payload: { electionId: string }) => Promise<void>
  getThreshold: (payload: { electionId: string }) => Promise<ThresholdDetails>
  listTokens: () => Promise<TokenRecord[]>
  issueToken: (payload: { electionId: string; voterId: string }) => Promise<void>
  castBallot: (payload: {
    electionId: string
    voterId: string
    choice: string
    tokenJwt: string
    ledgerUrl?: string
  }) => Promise<void>
  listLedger: (payload?: { electionId?: string }) => Promise<LedgerEntry[]>
  verifyReceipt: (payload: { receiptId: string }) => Promise<ReceiptVerification>
  runTally: (payload: { electionId: string; sharePaths?: string[] }) => Promise<TallyResult>
  runAudit: (payload: {
    electionId: string
    sharePaths?: string[]
    sampleRate?: number
    minSample?: number
  }) => Promise<AuditResult>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: BackendAPI
  }
}

export {}
