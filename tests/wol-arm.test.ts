import assert from 'node:assert/strict'
import { it } from 'node:test'
import { armFailureNote, powershellReason } from '../src/main/companion/wol'

it('shows only the PowerShell reason, not the echoed command', () => {
  const err = Object.assign(new Error("Command failed: powershell.exe -NoProfile -Command $adapter = Get-NetAdapter | Where-Object { ... }\nSet-NetAdapterPowerManagement : Ein an das System angeschlossenes Gerät funktioniert nicht."), {
    stderr: 'Set-NetAdapterPowerManagement : Ein an das System angeschlossenes Gerät funktioniert nicht.\r\nIn Zeile:4 Zeichen:1\r\n+ Set-NetAdapterPowerManagement -Name $adapter.Name\r\n    + CategoryInfo          : DeviceError: (MSFT_NetAdapterPowerManagementSettingData)\r\n    + FullyQualifiedErrorId : Windows System Error 31,Set-NetAdapterPowerManagement'
  })
  const reason = powershellReason(err)
  assert.match(reason, /funktioniert nicht/)
  assert.doesNotMatch(reason, /Command failed|Get-NetAdapter \|/)
  assert.equal(powershellReason(new Error('Command failed: powershell.exe -Command x\nZugriff verweigert')), 'Zugriff verweigert')
})

it('turns common failures into a step the user can take', () => {
  assert.match(armFailureNote('Zugriff verweigert', 'Ethernet'), /Administrator/)
  assert.match(armFailureNote('Windows System Error 31', 'Ethernet'), /Geräte-Manager.*Magic Packet/)
  assert.match(armFailureNote('Ein an das System angeschlossenes Gerät funktioniert nicht.', 'Ethernet'), /„Ethernet“/)
  assert.equal(armFailureNote('', 'Ethernet'), 'Windows hat abgelehnt: ohne Begründung')
})
