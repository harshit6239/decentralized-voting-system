// @ts-ignore Use require for electron to avoid TypeScript "is not a module" errors with some electron.d.ts setups
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

type IpcResponse<T> = {
  ok: boolean
  data?: T
  message?: string
}

const invoke = async <T>(channel: string, payload?): Promise<T> => {
  const response = (await ipcRenderer.invoke(channel, payload)) as IpcResponse<T>
  if (!response?.ok) {
    throw new Error(response?.message ?? `Request to ${channel} failed`)
  }
  return response.data as T
}

const api = {
  overview: () => invoke('overview:get'),
  listElections: () => invoke('elections:list'),
  createElection: (payload) => invoke('election:create', payload),
  deleteElection: (payload: { electionId: string }) => invoke('election:delete', payload),
  generateKeys: (payload: { electionId: string }) => invoke('election:keys:generate', payload),
  getThreshold: (payload: { electionId: string }) => invoke('election:keys:detail', payload),
  listTokens: () => invoke('tokens:list'),
  issueToken: (payload) => invoke('token:issue', payload),
  castBallot: (payload) => invoke('ballot:cast', payload),
  listLedger: (payload?: { electionId?: string }) => invoke('ledger:list', payload),
  verifyReceipt: (payload: { receiptId: string }) => invoke('receipt:verify', payload),
  runTally: (payload) => invoke('tally:run', payload),
  runAudit: (payload) => invoke('audit:run', payload)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
