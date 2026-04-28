import ApplicationServices
import Foundation

func argumentValue(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name) else {
    return nil
  }
  let valueIndex = CommandLine.arguments.index(after: index)
  guard valueIndex < CommandLine.arguments.endIndex else {
    return nil
  }
  return CommandLine.arguments[valueIndex]
}

func writeStatus(_ value: String) {
  guard let statusFile = argumentValue("--status-file") else {
    return
  }
  try? value.write(toFile: statusFile, atomically: true, encoding: .utf8)
}

let shouldPrompt = CommandLine.arguments.contains("--request-permission")
let promptOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: shouldPrompt] as CFDictionary

guard AXIsProcessTrustedWithOptions(promptOptions) else {
  writeStatus("needs-permission")
  fputs("Echo paste helper needs Accessibility permission.\n", stderr)
  exit(2)
}

if CommandLine.arguments.contains("--check") {
  writeStatus("trusted")
  print("trusted")
  exit(0)
}

let source = CGEventSource(stateID: .combinedSessionState)
let keyV: CGKeyCode = 0x09
let flags = CGEventFlags.maskCommand

guard
  let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyV, keyDown: true),
  let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyV, keyDown: false)
else {
  writeStatus("event-error")
  fputs("Could not create paste keyboard event.\n", stderr)
  exit(1)
}

keyDown.flags = flags
keyUp.flags = flags
keyDown.post(tap: .cghidEventTap)
usleep(20_000)
keyUp.post(tap: .cghidEventTap)
writeStatus("pasted")
