# Futures Scanner for iPhone

The iPhone app uses the existing published scanner and adds a native, locally saved watchlist with timestamped Bybit bid/ask snapshots. It reads public market data and has no exchange login, order entry, or background server.

## Build

Use Xcode 26 or later. In this directory, install XcodeGen with `brew install xcodegen`, run `xcodegen generate`, then open `FuturesScanner.xcodeproj`. The repository's **iOS build** workflow builds for Simulator and attempts to launch the app on a simulated iPhone.

## Upload to TestFlight

1. Sign in to Xcode with the account on the active Apple Developer team. In the app target's **Signing & Capabilities**, select that team and keep automatic signing enabled.
2. Register the bundle identifier and create the matching iOS app record in App Store Connect. The project uses `com.stavrosavraam.futuresscanner`. If the identifier needs changing, update `project.yml` and regenerate.
3. Select a generic iOS device destination in Xcode. Choose **Product → Archive**, then **Distribute App → App Store Connect → Upload** in Organizer. Increment `CURRENT_PROJECT_VERSION` in `project.yml` for each subsequent upload.
4. In App Store Connect, complete the TestFlight beta information and export compliance questions. Add the processed build to an external testing group, submit it for TestFlight review, and send the approved invitation link to testers.

Apple signing credentials belong in Xcode or a private signing setup. The repository contains an unsigned Simulator workflow.
