/* eslint-disable @typescript-eslint/no-var-requires */
import fs from 'fs'
import path from 'path'

const ROOT_PATH = path.resolve(__dirname, '../../../..')

if (process.cwd() !== ROOT_PATH) {
  process.chdir(ROOT_PATH)
}

const dbModule = require(path.resolve(ROOT_PATH, 'src/common/db'))
const utilsModule = require(path.resolve(ROOT_PATH, 'src/common/utils'))
const cryptoModule = require(path.resolve(ROOT_PATH, 'src/common/crypto'))
const voterModule = require(path.resolve(ROOT_PATH, 'src/voter/voter'))
const tallyModule = require(path.resolve(ROOT_PATH, 'src/ledger/tally'))
const auditModule = require(path.resolve(ROOT_PATH, 'src/audit/audit'))
const tokenModule = require(path.resolve(ROOT_PATH, 'src/ra/tokenService'))

const { listElections, insertElection, getElection, deleteElection, listTokens, getDb } = dbModule
const { readJson, nowISO } = utilsModule
const { genKeypair, constants } = cryptoModule
const {
  generateVoterKeys,
  buildBallotPlain,
  encryptBallot,
  submitBallot,
  recordVvpat,
  DEFAULT_LEDGER_URL
} = voterModule
const { runTally } = tallyModule
const { auditElection } = auditModule
const { issueToken } = tokenModule

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

const gatherShares = (keyData: any, sharePaths?: string[]): string[] => {
  if (!keyData?.threshold) {
    return []
  }

  const available: string[] =
    Array.isArray(sharePaths) && sharePaths.length > 0
      ? sharePaths
      : Array.isArray(keyData.threshold.shareFiles)
        ? keyData.threshold.shareFiles.slice(0, keyData.threshold.requiredShares)
        : []

  const resolved = available.map(resolveSharePath)

  if (resolved.length < (keyData.threshold.requiredShares ?? 0)) {
    throw new Error(
      `At least ${keyData.threshold.requiredShares} shares required; received ${resolved.length}`
    )
  }

  return resolved
}

export const getElectionSummaries = async (): Promise<any[]> => {
  const elections = listElections()

  return elections.map((record: any) => {
    const keyFile = getKeyFilePath(record.id)
    const hasKey = fs.existsSync(keyFile)
    let shareInfo: any[] = []

    if (hasKey) {
      try {
        const keyData = readJson(keyFile)
        if (Array.isArray(keyData?.threshold?.shareFiles)) {
          shareInfo = keyData.threshold.shareFiles.map((relativePath: string) => {
            const absolutePath = resolveSharePath(relativePath)
            let shareData: any = null
            if (fs.existsSync(absolutePath)) {
              shareData = readJson(absolutePath)
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

export const createElectionRecord = async (payload: CreateElectionPayload): Promise<any> => {
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
  return summaries.find((entry) => entry.id === id) ?? getElection(id)
}

export const removeElection = async (electionId: string): Promise<void> => {
  deleteElection(electionId)
}

export const ensureElectionKeys = async (electionId: string): Promise<any> => {
  if (!electionId) {
    throw new Error('electionId is required to generate keys')
  }

  genKeypair(electionId)
  return getThresholdDetails(electionId)
}

export const getThresholdDetails = (electionId: string): any => {
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

  const keyData = readJson(keyFile)
  const shareFiles: any[] = Array.isArray(keyData?.threshold?.shareFiles)
    ? keyData.threshold.shareFiles.map((relativePath: string) => {
        const absolutePath = resolveSharePath(relativePath)
        const exists = fs.existsSync(absolutePath)
        const description = exists ? readJson(absolutePath) : null
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
    threshold: keyData.threshold
  }
}

export const issueVoterToken = async (payload: IssueTokenPayload): Promise<any> => {
  if (!payload.electionId || !payload.voterId) {
    throw new Error('electionId and voterId are required')
  }

  return issueToken(payload)
}

export const listAllTokens = async (): Promise<any[]> => {
  return listTokens()
}

export const castBallotWithToken = async (payload: CastVotePayload): Promise<any> => {
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

export const fetchLedgerEntries = async (electionId?: string): Promise<any[]> => {
  const db = getDb()
  const baseQuery =
    'SELECT "index" as ledgerIndex, commitment, cipherRef, electionId, timestamp, receiptId FROM ledger'

  const rows = electionId
    ? db.prepare(`${baseQuery} WHERE electionId = ? ORDER BY "index" ASC`).all(electionId)
    : db.prepare(`${baseQuery} ORDER BY "index" ASC`).all()

  return rows
}

export const runElectionTally = async (electionId: string, sharePaths?: string[]): Promise<any> => {
  const keyFile = getKeyFilePath(electionId)
  if (!fs.existsSync(keyFile)) {
    throw new Error(`Key file for '${electionId}' not found`)
  }

  const keyData = readJson(keyFile)
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
): Promise<any> => {
  const keyFile = getKeyFilePath(electionId)
  if (!fs.existsSync(keyFile)) {
    throw new Error(`Key file for '${electionId}' not found`)
  }

  const keyData = readJson(keyFile)
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

export const getSystemOverview = async (): Promise<any> => {
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
