import SwiftUI

private struct MarketQuote: Decodable {
    let symbol: String
    let bid1Price: String?
    let ask1Price: String?

    var validBook: Bool {
        guard let bid = Double(bid1Price ?? ""), let ask = Double(ask1Price ?? "") else { return false }
        return bid.isFinite && ask.isFinite && bid > 0 && ask >= bid
    }
}

private struct MarketSnapshot: Decodable {
    struct Market: Decodable {
        let list: [MarketQuote]
    }

    let retCode: Int
    let time: Double
    let result: Market

    var date: Date { Date(timeIntervalSince1970: time / 1_000) }

    func isFresh(at now: Date) -> Bool {
        let age = now.timeIntervalSince(date)
        return age >= -5 && age < 25
    }

    static func fetch() async throws -> MarketSnapshot {
        let url = URL(string: "https://api.bybit.com/v5/market/tickers?category=linear")!
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        let snapshot = try JSONDecoder().decode(Self.self, from: data)
        guard snapshot.retCode == 0, snapshot.isFresh(at: .now), !snapshot.result.list.isEmpty else {
            throw URLError(.cannotParseResponse)
        }
        return snapshot
    }
}

struct WatchlistView: View {
    @AppStorage("watchlist.symbols") private var storedSymbols = "BTCUSDT,ETHUSDT,SOLUSDT"
    @Environment(\.scenePhase) private var scenePhase
    @State private var snapshot: MarketSnapshot?
    @State private var showAdd = false
    @State private var newSymbol = ""
    @State private var errorMessage: String?
    @State private var inputError: String?
    @State private var isRefreshing = false

    private var symbols: [String] { storedSymbols.split(separator: ",").map(String.init) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(symbols, id: \.self) { symbol in
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            quoteRow(symbol, snapshot: freshSnapshot(at: context.date))
                        }
                    }
                    .onDelete { offsets in
                        var updated = symbols
                        updated.remove(atOffsets: offsets)
                        storedSymbols = updated.joined(separator: ",")
                    }

                    if symbols.isEmpty {
                        Text("Add a USDT pair with the plus button.")
                            .foregroundStyle(.secondary)
                    } else {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if let fresh = freshSnapshot(at: context.date) {
                                LabeledContent("Bybit snapshot", value: fresh.date.formatted(date: .omitted, time: .standard))
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } footer: {
                    Text("Watchlist quotes come from Bybit. Check the price on your execution venue separately.")
                }

                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Watchlist")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        newSymbol = ""
                        showAdd = true
                    } label: {
                        Label("Add pair", systemImage: "plus")
                    }
                }
            }
            .refreshable { await refresh() }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    await refresh()
                    try? await Task.sleep(for: .seconds(10))
                }
            }
            .alert("Add USDT pair", isPresented: $showAdd) {
                TextField("BTC/USDT", text: $newSymbol)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                Button("Add", action: addSymbol)
                Button("Cancel", role: .cancel) {}
            }
            .alert("Pair could not be added", isPresented: Binding(
                get: { inputError != nil }, set: { if !$0 { inputError = nil } }
            )) {
                Button("OK") { inputError = nil }
            } message: {
                Text(inputError ?? "")
            }
        }
    }

    private func freshSnapshot(at now: Date) -> MarketSnapshot? {
        snapshot.flatMap { $0.isFresh(at: now) ? $0 : nil }
    }

    private func quoteRow(_ symbol: String, snapshot: MarketSnapshot?) -> some View {
        let quote = snapshot?.result.list.first { $0.symbol == symbol && $0.validBook }
        return VStack(alignment: .leading, spacing: 4) {
            Text(symbol).font(.headline)
            if let quote, let bid = quote.bid1Price, let ask = quote.ask1Price {
                Text("Bid \(bid)   Ask \(ask)").monospacedDigit()
            } else {
                Text("No fresh Bybit bid/ask").foregroundStyle(.secondary)
            }
        }
    }

    private func addSymbol() {
        let pair = newSymbol.trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased().replacingOccurrences(of: "/", with: "")
        guard pair.range(of: #"^[\p{L}0-9]{1,32}USDT$"#, options: .regularExpression) != nil else {
            inputError = "Enter a USDT pair such as BTC/USDT."
            return
        }
        if !symbols.contains(pair) { storedSymbols = (symbols + [pair]).joined(separator: ",") }
    }

    @MainActor
    private func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let fresh = try await MarketSnapshot.fetch()
            try Task.checkCancellation()
            snapshot = fresh
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            snapshot = nil
            errorMessage = "Bybit quotes are unavailable. Pull down to retry."
        }
    }
}
