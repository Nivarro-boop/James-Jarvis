/**
 * `require('electron')` auf den Ersatz umbiegen — für alles, auch für fremde
 * Pakete.
 *
 * Zuerst tat das ein esbuild-Alias, und für unseren eigenen Code reichte das
 * auch. Nur bündelt der Testlauf die Abhängigkeiten bewusst nicht mit (siehe
 * `scripts/run-tests.mjs`), und ein Paket, das als `require` stehenbleibt,
 * fordert `electron` seinerseits an — an esbuild vorbei. `@electron-toolkit/utils`
 * tut das und liest beim Laden `electron.app.isPackaged`. Es bekam das echte
 * Paket, dessen Node-Einstieg bloß den Pfad zur ausführbaren Datei zurückgibt:
 * `app` war undefined, und der Testlauf endete vor dem ersten Test.
 *
 * Ein Haken an `Module._load` sitzt tiefer als jeder Alias — dort kommt jedes
 * `require` vorbei, aus welchem Paket auch immer. Damit gibt es genau eine
 * Stelle, an der Electron ersetzt wird, statt zwei mit verschiedener
 * Reichweite.
 *
 * Wird über NODE_OPTIONS geladen, damit es auch in den Kindprozessen gilt, in
 * denen `node --test` die einzelnen Dateien laufen lässt.
 */
const Module = require('node:module')

const stub = require('./electron-stub.cjs')
const original = Module._load

Module._load = function (request, parent, isMain) {
  if (request === 'electron') return stub
  return original.call(this, request, parent, isMain)
}
