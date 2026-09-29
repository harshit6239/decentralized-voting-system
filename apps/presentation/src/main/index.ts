import { app, shell, BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as backend from './backend'

type IpcHandler = (args, event: IpcMainInvokeEvent) => any

const registerIpcHandlers = (): void => {
  const expose = (channel: string, handler: IpcHandler): void => {
    ipcMain.handle(channel, async (event, args) => {
      try {
        const data = await handler(args, event)
        return { ok: true, data }
      } catch (error: any) {
        console.error(`[ipc:${channel}]`, error)
        return {
          ok: false,
          message: error?.message ?? 'Unexpected error'
        }
      }
    })
  }

  expose('overview:get', () => backend.getSystemOverview())
  expose('elections:list', () => backend.getElectionSummaries())
  expose('election:create', (args) => backend.createElectionRecord(args))
  expose('election:delete', (args) => backend.removeElection(args?.electionId))
  expose('election:keys:generate', (args) => backend.ensureElectionKeys(args?.electionId))
  expose('election:keys:detail', (args) => backend.getThresholdDetails(args?.electionId))
  expose('tokens:list', () => backend.listAllTokens())
  expose('token:issue', (args) => backend.issueVoterToken(args))
  expose('ballot:cast', (args) => backend.castBallotWithToken(args))
  expose('ledger:list', (args) => backend.fetchLedgerEntries(args?.electionId))
  expose('receipt:verify', (args) => backend.verifyReceipt(args?.receiptId))
  expose('tally:run', (args) => backend.runElectionTally(args?.electionId, args?.sharePaths))
  expose('audit:run', (args) =>
    backend.runElectionAudit(args?.electionId, {
      sharePaths: args?.sharePaths,
      sampleRate: args?.sampleRate,
      minSample: args?.minSample
    })
  )
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
