import AppKit
import CoreGraphics

// Never prompt for Accessibility permission on an unattended runner.
guard CGPreflightPostEventAccess() else {
    print("OS events unavailable: CGPreflightPostEventAccess=false")
    exit(77)
}
if CommandLine.arguments.count == 3 || CommandLine.arguments.count == 5 {
    let start = CGPoint(x: Double(CommandLine.arguments[1])!, y: Double(CommandLine.arguments[2])!)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)!.post(tap: .cghidEventTap)
    usleep(100_000)
    var end = start
    if CommandLine.arguments.count == 5 {
        end = CGPoint(x: Double(CommandLine.arguments[3])!, y: Double(CommandLine.arguments[4])!)
        for step in 1...20 {
            let progress = Double(step) / 20.0
            let point = CGPoint(x: start.x + (end.x - start.x) * progress, y: start.y + (end.y - start.y) * progress)
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
            usleep(20_000)
        }
    }
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)!.post(tap: .cghidEventTap)
}
print("OS events permitted")
