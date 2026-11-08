import SwiftUI
import WebKit

struct ScannerTab: View {
    private static let scannerURL = URL(string:
        "https://964c5vw72f-ctrl.github.io/bybit-futures-scanner/?market=gylex")!

    @State private var loadFailed = false
    @State private var reloadID = UUID()

    var body: some View {
        NavigationStack {
            ScannerPage(url: Self.scannerURL, loadFailed: $loadFailed)
                .id(reloadID)
                .overlay {
                    if loadFailed {
                        ContentUnavailableView {
                            Label("Scanner unavailable", systemImage: "wifi.exclamationmark")
                        } description: {
                            Text("Check your connection and try again.")
                        } actions: {
                            Button("Reload", action: reload)
                        }
                        .background(.background)
                    }
                }
                .navigationTitle("Futures Scanner")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    Button(action: reload) {
                        Label("Reload scanner", systemImage: "arrow.clockwise")
                    }
                }
        }
    }

    private func reload() {
        loadFailed = false
        reloadID = UUID()
    }
}

private struct ScannerPage: UIViewRepresentable {
    let url: URL
    @Binding var loadFailed: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url, loadFailed: $loadFailed)
    }

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let url: URL
        private var loadFailed: Binding<Bool>

        init(url: URL, loadFailed: Binding<Bool>) {
            self.url = url
            self.loadFailed = loadFailed
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let target = action.request.url
            let isScanner = target?.scheme == "https" && target?.host == url.host && target?.path == url.path
            decisionHandler(isScanner ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            showError(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            showError(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            loadFailed.wrappedValue = true
        }

        private func showError(_ error: Error) {
            if (error as? URLError)?.code != .cancelled {
                loadFailed.wrappedValue = true
            }
        }
    }
}
