'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
function credentialPath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/Devin/User/globalStorage/state.vscdb');
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('credentials_unavailable');
    return path.join(env.APPDATA, 'Devin/User/globalStorage/state.vscdb');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Devin/User/globalStorage/state.vscdb');
}
function readKey({ env = process.env, dbPath, database } = {}) {
  if (env.WINDSURF_API_KEY) {
    if (typeof env.WINDSURF_API_KEY !== 'string' || env.WINDSURF_API_KEY.length > 8192) throw new Error('credentials_unavailable');
    return env.WINDSURF_API_KEY;
  }
  dbPath ||= credentialPath({ env });
  if (!fs.existsSync(dbPath)) throw new Error('credentials_unavailable');
  let db;
  try {
    // Read one known record, including WAL state, without copying the database
    // or exposing credentials through a tool, child-process argv, or log.
    const DatabaseSync = database || require('node:sqlite').DatabaseSync;
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'").get();
    const key = JSON.parse(row?.value || '{}').apiKey;
    if (typeof key !== 'string' || !key || key.length > 8192) throw new Error();
    return key;
  } catch { throw new Error('credentials_unavailable'); }
  finally { db?.close(); }
}
module.exports = { credentialPath, readKey };
