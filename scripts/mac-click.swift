import AppKit
import CoreGraphics

// Never prompt for Accessibility permission on an unattended runner.
guard CGPreflightPostEventAccess() else {
    print("OS events unavailable: CGPreflightPostEventAccess=false")
    exit(77)
}
if CommandLine.arguments.count == 3 {
    let point = CGPoint(x: Double(CommandLine.arguments[1])!, y: Double(CommandLine.arguments[2])!)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
    usleep(100_000)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
}
print("OS events permitted")
