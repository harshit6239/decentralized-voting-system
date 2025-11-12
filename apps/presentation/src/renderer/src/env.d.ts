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
  generateKeys: (payload: { electionId: string }) => Promise
  getThreshold: (payload: { electionId: string }) => Promise<ThresholdDetails>
  listTokens: () => Promise<[]>
  issueToken: (payload: { electionId: string; voterId: string }) => Promise
  castBallot: (payload: {
    electionId: string
    voterId: string
    choice: string
    tokenJwt: string
    ledgerUrl?: string
  }) => Promise
  listLedger: (payload?: { electionId?: string }) => Promise<LedgerEntry[]>
  runTally: (payload: { electionId: string; sharePaths?: string[] }) => Promise
  runAudit: (payload: {
    electionId: string
    sharePaths?: string[]
    sampleRate?: number
    minSample?: number
  }) => Promise
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: BackendAPI
  }
}

export {}
