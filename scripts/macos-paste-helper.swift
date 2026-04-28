import ApplicationServices
import Foundation

let promptOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary

guard AXIsProcessTrustedWithOptions(promptOptions) else {
  fputs("Echo paste helper needs Accessibility permission.\n", stderr)
  exit(2)
}

if CommandLine.arguments.contains("--check") {
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
  fputs("Could not create paste keyboard event.\n", stderr)
  exit(1)
}

keyDown.flags = flags
keyUp.flags = flags
keyDown.post(tap: .cghidEventTap)
usleep(20_000)
keyUp.post(tap: .cghidEventTap)
