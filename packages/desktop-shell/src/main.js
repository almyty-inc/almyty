'use strict'

// Absent when this file is loaded outside Electron, which is how the
// pure functions below are tested without starting a window.
const electron = (() => {
  try {
    return require('electron')
  } catch {
    return null
  }
})()

const { app, BrowserWindow, shell, nativeTheme } = electron || {}
const path = require('path')
const fs = require('fs')

/**
 * The window an almyty app ships in.
 *
 * This is a shell, not a product: every build writes its own
 * `app-config.json` beside this file and the result is the customer's
 * app, under their name, pointed at their hosted chat.
 *
 * It renders remote content, so it is locked down accordingly. The
 * renderer gets no Node, no context sharing, and no way to navigate off
 * the app's own origin. A window that can be talked into loading an
 * arbitrary page is a browser with the customer's name on it.
 */

const CONFIG_PATH = path.join(__dirname, 'app-config.json')

/** Config with every field defaulted, because a build wrote this file. */
function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return {
      appName: raw.appName || 'almyty',
      url: raw.url || '',
      primaryColor: isHexColour(raw.primaryColor) ? raw.primaryColor : '#8b5cf6',
      theme: raw.theme === 'dark' || raw.theme === 'light' ? raw.theme : 'system',
    }
  } catch {
    return { appName: 'almyty', url: '', primaryColor: '#8b5cf6', theme: 'system' }
  }
}

/**
 * Whether a value is a colour we can hand to the OS.
 *
 * The config is written by a build from a form field, and both the
 * title bar and the pre-paint background take this string. Anything
 * that is not a hex colour falls back rather than being passed through.
 */
function isHexColour(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

/**
 * Whether a colour is dark enough to need light symbols on it.
 *
 * Rec. 601 luma against the conventional midpoint. The green weight is
 * what makes pure green read as light and pure blue as dark despite the
 * two carrying the same channel value, which is how eyes work and why a
 * plain average gets title bars wrong.
 */
function isDark(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

/**
 * The one origin this app may show.
 *
 * Compared as an origin rather than a prefix: a startsWith check on
 * "https://acme.almyty.app" also passes for
 * "https://acme.almyty.app.attacker.test".
 */
function originOf(url) {
  try {
    const origin = new URL(url).origin
    // A scheme with no host (data:, javascript:, file:) gives the string
    // "null". Returning it would make every such URL share one origin,
    // so a data: app address would let a javascript: URL through the
    // navigation check.
    return origin && origin !== 'null' ? origin : null
  } catch {
    return null
  }
}

/**
 * Whether the window may follow a navigation.
 *
 * Separate from the listener so the rule can be read and tested. A
 * build with no address allows nothing: the page it shows is a message,
 * not somewhere to navigate from.
 */
function mayNavigateTo(allowedOrigin, url) {
  if (!allowedOrigin) return false
  return originOf(url) === allowedOrigin
}

function createWindow(config) {
  const allowedOrigin = originOf(config.url)

  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 420,
    minHeight: 480,
    title: config.appName,
    // Painted before the page loads, in the product's own colour, so a
    // launch shows the customer's brand rather than flashing white,
    // which on a dark theme reads as a broken app.
    backgroundColor: config.primaryColor,
    // The frame follows suit where the platform allows it, so the
    // window is theirs from the title bar down rather than only inside
    // the page. Ignored on platforms that do not support it.
    titleBarOverlay: {
      color: config.primaryColor,
      symbolColor: isDark(config.primaryColor) ? '#ffffff' : '#000000',
    },
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  })

  // A link to somewhere else opens in the user's browser rather than
  // taking over this window, which would leave them on an unrelated
  // site inside an app wearing the customer's name.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (mayNavigateTo(allowedOrigin, url)) return
    event.preventDefault()
    if (/^https?:/.test(url)) shell.openExternal(url)
  })

  // Nothing here needs a camera, a microphone, or a location, and the
  // default is to ask. Refusing outright means a compromised page
  // cannot even put the prompt in front of the user.
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  if (config.theme !== 'system') nativeTheme.themeSource = config.theme

  if (allowedOrigin) {
    window.loadURL(config.url)
  } else {
    // A build with no URL is a packaging mistake. Saying so beats an
    // empty window the user cannot interpret.
    window.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          `<body style="font:14px system-ui;padding:2rem">This copy of ${config.appName} was built without an address to connect to.</body>`,
        ),
    )
  }

  return window
}

function start() {
  const config = readConfig()
  app.setName(config.appName)

  // One instance. A second launch focuses the window that is already
  // open rather than starting a second copy of the same app.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  let mainWindow = null

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    mainWindow = createWindow(config)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(config)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (app) start()

module.exports = { readConfig, originOf, mayNavigateTo, isHexColour, isDark, start }
