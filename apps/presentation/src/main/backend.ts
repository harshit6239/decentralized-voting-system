import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const ROOT_PATH = path.resolve(__dirname, '../../../..')

if (process.cwd() !== ROOT_PATH) {
  process.chdir(ROOT_PATH)
}

const requireFromRoot = createRequire(path.join(ROOT_PATH, 'package.json'))

const loadFromRoot = <T>(relativePath: string): T => {
  const absolutePath = path.join(ROOT_PATH, relativePath)

  try {
    return requireFromRoot(absolutePath) as T
  } catch (error) {
    console.error(`Failed to load module '${relativePath}' from ${ROOT_PATH}`, error)
    throw error
  }
}

type DbModule = typeof import('../../../../src/common/db.js')
type UtilsModule = typeof import('../../../../src/common/utils.js')
type CryptoModule = typeof import('../../../../src/common/crypto.js')
type VoterModule = typeof import('../../../../src/voter/voter.js')
type TallyModule = typeof import('../../../../src/ledger/tally.js')
type AuditModule = typeof import('../../../../src/audit/audit.js')
type TokenModule = typeof import('../../../../src/ra/tokenService.js')

type ThresholdSection = {
  shareFiles?: string[]
  requiredShares?: number
  totalShares?: number
}

type KeyFileData = {
  threshold?: ThresholdSection
}

type ShareFileJson = {
  index?: number
  shareIndex?: number
}

type ShareInfo = {
  path: string
  absolutePath: string
  exists: boolean
  index: number | null
}

type ElectionSummaryRecord = ElectionRecord & {
  hasKey: boolean
  keyFile: string | null
  shares: ShareInfo[]
}

type TokenRow = {
  tokenId: string
  electionId: string
  voterId: string
  tokenJwt: string
  used: number
  issuedAt: string
}

type TokenRecord = {
  tokenId: string
  electionId: string
  voterId: string
  tokenJwt: string
  used: boolean
  issuedAt: string
}

type LedgerStatement = {
  all: (...args: unknown[]) => LedgerEntryRecord[]
}

type LedgerDatabase = {
  prepare: (query: string) => LedgerStatement
}

type LedgerEntryRecord = {
  ledgerIndex: number
  commitment: string
  cipherRef: string
  electionId: string
  timestamp: string
  receiptId: string
}

type BallotPlain = {
  electionId: string
  voterId: string
  choice: string
  timestamp: string
}

type BallotSeal = {
  ciphertextB64: string
  nonceB64: string
  commitmentHex: string
}

type Receipt = {
  receiptId: string
  ledgerIndex: number
  commitment: string
  timestamp: string
  electionId: string
  signature: string
}

type BallotSubmissionResult = {
  ballot: BallotPlain
  seal: BallotSeal
  receipt: Receipt
  vvpatPath: string
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

type TallyResultPayload = {
  result: unknown
  shares: string[]
}

type AuditResultPayload = {
  report: unknown
  shares: string[]
}

type ThresholdDetails = {
  keyFile: string
  shareFiles: ShareInfo[]
  threshold: {
    totalShares: number
    requiredShares: number
  }
}

type IssuedToken = {
  tokenId: string
  tokenJwt: string
  tokenFilePath: string
  issuedAt: string
}

const dbModule = loadFromRoot<DbModule>('src/common/db.js')
const utilsModule = loadFromRoot<UtilsModule>('src/common/utils.js')
const cryptoModule = loadFromRoot<CryptoModule>('src/common/crypto.js')
const voterModule = loadFromRoot<VoterModule>('src/voter/voter.js')
const tallyModule = loadFromRoot<TallyModule>('src/ledger/tally.js')
const auditModule = loadFromRoot<AuditModule>('src/audit/audit.js')
const tokenModule = loadFromRoot<TokenModule>('src/ra/tokenService.js')

const dbExports = dbModule as unknown as {
  listElections: () => ElectionRecord[]
  insertElection: (payload: {
    id: string
    title: string
    startIso: string
    endIso: string
    choices: string[]
  }) => void
  getElection: (id: string) => ElectionRecord | undefined
  deleteElection: (id: string) => void
  listTokens: () => TokenRow[]
  getDb: () => LedgerDatabase
}

const { readJson, nowISO } = utilsModule as unknown as {
  readJson: <T>(filePath: string) => T
  nowISO: () => string
}

const { genKeypair, constants } = cryptoModule as unknown as {
  genKeypair: (label: string) => Record<string, string>
  constants: {
    KEY_ALGO_BOX: string
    KEY_ALGO_SIGN: string
    keysRoot: string
    SHARE_TOTAL: number
    SHARE_THRESHOLD: number
  }
}

const voterExports = voterModule as unknown as {
  generateVoterKeys: (voterId: string) => { publicKeyPath: string; privateKeyPath: string }
  buildBallotPlain: (electionId: string, voterId: string, choice: string) => BallotPlain
  encryptBallot: (ballot: BallotPlain, keyFile: string) => BallotSeal
  submitBallot: (
    submission: {
      tokenJwt: string
      ciphertextB64: string
      nonceB64: string
      commitmentHex: string
      electionId: string
      timestamp: string
    },
    ledgerUrl: string
  ) => Promise<Receipt>
  recordVvpat: (commitmentHex: string, ballot: BallotPlain, receipt: Receipt) => string
  DEFAULT_LEDGER_URL: () => string
}

const tallyExports = tallyModule as unknown as {
  runTally: (
    electionId: string,
    options: { privateKeyPath: string; privateKeyShares?: string[] }
  ) => Promise<unknown>
}

const auditExports = auditModule as unknown as {
  auditElection: (
    electionId: string,
    options: {
      electionPrivKeyPath: string
      privateKeyShares?: string[]
      sampleRate?: number
      minSample?: number
    }
  ) => Promise<unknown>
}

const tokenExports = tokenModule as unknown as {
  issueToken: (payload: IssueTokenPayload) => IssuedToken
}

const { listElections, insertElection, getElection, deleteElection, listTokens, getDb } = dbExports
const {
  generateVoterKeys,
  buildBallotPlain,
  encryptBallot,
  submitBallot,
  recordVvpat,
  DEFAULT_LEDGER_URL
} = voterExports
const { runTally } = tallyExports
const { auditElection } = auditExports
const { issueToken } = tokenExports

export type ElectionRecord = {
  id: string
  title: string
  start_iso: string
  end_iso: string
  choices: string[]
}

export type CreateElectionPayload = {
  id: string
  title: string
  startIso: string
  endIso: string
  choices: string[]
}

export type IssueTokenPayload = {
  electionId: string
  voterId: string
}

export type CastVotePayload = {
  electionId: string
  voterId: string
  choice: string
  tokenJwt: string
  ledgerUrl?: string
}

export type ShareSelection = {
  electionId: string
  sharePaths?: string[]
}

const getKeyFilePath = (electionId: string): string =>
  path.join(constants.keysRoot, `${electionId}-${constants.KEY_ALGO_BOX}.json`)

const resolveSharePath = (sharePath: string): string =>
  path.isAbsolute(sharePath) ? sharePath : path.resolve(constants.keysRoot, sharePath)

const gatherShares = (keyData: KeyFileData, sharePaths?: string[]): string[] => {
  const threshold = keyData.threshold

  if (!threshold) {
    return Array.isArray(sharePaths) ? sharePaths.map(resolveSharePath) : []
  }

  const required = threshold.requiredShares ?? constants.SHARE_THRESHOLD
  const available: string[] =
    Array.isArray(sharePaths) && sharePaths.length > 0
      ? sharePaths
      : Array.isArray(threshold.shareFiles)
        ? threshold.shareFiles.slice(0, required)
        : []

  const resolved = available.map(resolveSharePath)

  if (resolved.length < required) {
    throw new Error(`At least ${required} shares required; received ${resolved.length}`)
  }

  return resolved
}

export const getElectionSummaries = async (): Promise<ElectionSummaryRecord[]> => {
  const elections = listElections()

  return elections.map((record) => {
    const keyFile = getKeyFilePath(record.id)
    const hasKey = fs.existsSync(keyFile)
    let shareInfo: ShareInfo[] = []

    if (hasKey) {
      try {
        const keyData = readJson<KeyFileData>(keyFile)
        if (Array.isArray(keyData.threshold?.shareFiles)) {
          shareInfo = keyData.threshold.shareFiles.map((relativePath) => {
            const absolutePath = resolveSharePath(relativePath)
            let shareData: ShareFileJson | undefined
            if (fs.existsSync(absolutePath)) {
              shareData = readJson<ShareFileJson>(absolutePath)
            }
            return {
              path: relativePath,
              absolutePath,
              exists: fs.existsSync(absolutePath),
              index: shareData?.index ?? shareData?.shareIndex ?? null
            }
          })
        }
      } catch (error) {
        console.warn('Failed to inspect share metadata', error)
        shareInfo = []
      }
    }

    return {
      ...record,
      hasKey,
      keyFile: hasKey ? keyFile : null,
      shares: shareInfo
    }
  })
}

export const createElectionRecord = async (
  payload: CreateElectionPayload
): Promise<ElectionSummaryRecord> => {
  const { id, title, startIso, endIso, choices } = payload

  if (!id || !title) {
    throw new Error('Election id and title are required')
  }

  if (!Array.isArray(choices) || choices.length < 2) {
    throw new Error('Provide at least two choices for the election')
  }

  insertElection({
    id,
    title,
    startIso,
    endIso,
    choices
  })

  const summaries = await getElectionSummaries()
  const created = summaries.find((entry) => entry.id === id)
  if (created) {
    return created
  }

  const fallbackElection = getElection(id)
  return {
    ...(fallbackElection ?? { id, title, start_iso: startIso, end_iso: endIso, choices }),
    hasKey: false,
    keyFile: null,
    shares: []
  }
}

export const removeElection = async (electionId: string): Promise<void> => {
  deleteElection(electionId)
}

export const ensureElectionKeys = async (electionId: string): Promise<ThresholdDetails> => {
  if (!electionId) {
    throw new Error('electionId is required to generate keys')
  }

  genKeypair(electionId)
  return getThresholdDetails(electionId)
}

export const getThresholdDetails = (electionId: string): ThresholdDetails => {
  const keyFile = getKeyFilePath(electionId)
  if (!fs.existsSync(keyFile)) {
    return {
      keyFile,
      shareFiles: [],
      threshold: {
        totalShares: constants.SHARE_TOTAL,
        requiredShares: constants.SHARE_THRESHOLD
      }
    }
  }

  const keyData = readJson<KeyFileData>(keyFile)
  const shareFiles: ShareInfo[] = Array.isArray(keyData.threshold?.shareFiles)
    ? keyData.threshold.shareFiles.map((relativePath) => {
        const absolutePath = resolveSharePath(relativePath)
        const exists = fs.existsSync(absolutePath)
        const description = exists ? readJson<ShareFileJson>(absolutePath) : undefined
        return {
          path: relativePath,
          absolutePath,
          exists,
          index: description?.index ?? description?.shareIndex ?? null
        }
      })
    : []

  return {
    keyFile,
    shareFiles,
    threshold: {
      totalShares: keyData.threshold?.totalShares ?? constants.SHARE_TOTAL,
      requiredShares: keyData.threshold?.requiredShares ?? constants.SHARE_THRESHOLD
    }
  }
}

export const issueVoterToken = async (payload: IssueTokenPayload): Promise<IssuedToken> => {
  if (!payload.electionId || !payload.voterId) {
    throw new Error('electionId and voterId are required')
  }

  return issueToken(payload)
}

export const listAllTokens = async (): Promise<TokenRecord[]> => {
  return listTokens().map((row) => ({
    ...row,
    used: Boolean(row.used)
  }))
}

export const castBallotWithToken = async (
  payload: CastVotePayload
): Promise<BallotSubmissionResult> => {
  const { electionId, voterId, choice, tokenJwt, ledgerUrl } = payload
  if (!electionId || !voterId || !choice || !tokenJwt) {
    throw new Error('Election, voter, choice, and token are required to cast a vote')
  }

  generateVoterKeys(voterId)
  const ballotPlain = buildBallotPlain(electionId, voterId, choice)
  const keyFile = getKeyFilePath(electionId)
  if (!fs.existsSync(keyFile)) {
    throw new Error(
      `Election key not found for '${electionId}'. Generate keys before casting ballots.`
    )
  }

  const seal = encryptBallot(ballotPlain, keyFile)
  const submission = {
    tokenJwt,
    ciphertextB64: seal.ciphertextB64,
    nonceB64: seal.nonceB64,
    commitmentHex: seal.commitmentHex,
    electionId,
    timestamp: ballotPlain.timestamp
  }

  const receipt = await submitBallot(submission, ledgerUrl ?? DEFAULT_LEDGER_URL())
  const vvpat = recordVvpat(seal.commitmentHex, ballotPlain, receipt)

  return {
    ballot: ballotPlain,
    seal,
    receipt,
    vvpatPath: vvpat
  }
}

export const fetchLedgerEntries = async (electionId?: string): Promise<LedgerEntryRecord[]> => {
  const db = getDb()
  const baseQuery =
    'SELECT "index" as ledgerIndex, commitment, cipherRef, electionId, timestamp, receiptId FROM ledger'

  const rows = electionId
    ? db.prepare(`${baseQuery} WHERE electionId = ? ORDER BY "index" ASC`).all(electionId)
    : db.prepare(`${baseQuery} ORDER BY "index" ASC`).all()

  return rows
}

export const runElectionTally = async (
  electionId: string,
  sharePaths?: string[]
): Promise<TallyResultPayload> => {
  const keyFile = getKeyFilePath(electionId)
  if (!fs.existsSync(keyFile)) {
    throw new Error(`Key file for '${electionId}' not found`)
  }

  const keyData = readJson<KeyFileData>(keyFile)
  const shares = gatherShares(keyData, sharePaths)

  const result = await runTally(electionId, {
    privateKeyPath: keyFile,
    privateKeyShares: shares
  })

  return {
    result,
    shares
  }
}

export const runElectionAudit = async (
  electionId: string,
  options: { sharePaths?: string[]; sampleRate?: number; minSample?: number } = {}
): Promise<AuditResultPayload> => {
  const keyFile = getKeyFilePath(electionId)
  if (!fs.existsSync(keyFile)) {
    throw new Error(`Key file for '${electionId}' not found`)
  }

  const keyData = readJson<KeyFileData>(keyFile)
  const shares = gatherShares(keyData, options.sharePaths)

  const report = await auditElection(electionId, {
    electionPrivKeyPath: keyFile,
    privateKeyShares: shares,
    sampleRate: options.sampleRate ?? 1,
    minSample: options.minSample ?? 1
  })

  return {
    report,
    shares
  }
}

export const getSystemOverview = async (): Promise<OverviewSnapshot> => {
  const elections = await getElectionSummaries()
  const tokens = await listAllTokens()
  const ledgerEntries = await fetchLedgerEntries()

  const activeElections = elections.filter((item) => {
    const now = Date.now()
    return now >= Date.parse(item.start_iso) && now <= Date.parse(item.end_iso)
  }).length

  return {
    totals: {
      elections: elections.length,
      tokens: tokens.length,
      ledgerEntries: ledgerEntries.length,
      activeElections
    },
    timestamps: {
      generatedAt: nowISO()
    }
  }
}
