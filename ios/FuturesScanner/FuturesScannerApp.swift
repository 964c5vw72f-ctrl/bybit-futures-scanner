import SwiftUI

@main
struct FuturesScannerApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                ScannerTab()
                    .tabItem { Label("Scanner", systemImage: "chart.line.uptrend.xyaxis") }

                WatchlistView()
                    .tabItem { Label("Watchlist", systemImage: "star") }
            }
        }
    }
}
