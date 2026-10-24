/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'watch', name: 'JamesWatch', displayName: 'James',
  bundleIdentifier: '.watch', deploymentTarget: '10.0',
  icon: '../../assets/icon.png',
  frameworks: ['SwiftUI', 'WatchConnectivity', 'AVFoundation', 'WatchKit'],
  colors: { $accent: '#80e4d6' }
}
