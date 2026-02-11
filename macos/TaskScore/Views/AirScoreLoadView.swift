import SwiftUI
import TaskScoreLib

/// Sheet for loading a task from AirScore by pasting a URL
struct AirScoreLoadView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var isLoading: Bool
    var onLoad: (Int, Int, Int?) -> Void

    @State private var urlText = ""
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 16) {
            Text("Load AirScore Task")
                .font(.headline)

            Text("Paste an AirScore tracklog URL to load the competition task and pilot track.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            TextField("https://xc.highcloud.net/tracklog_map.html?trackid=...", text: $urlText)
                .textFieldStyle(.roundedBorder)
                .onSubmit { loadFromURL() }

            if let error = errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)

                Button("Load") {
                    loadFromURL()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(urlText.isEmpty || isLoading)
            }
        }
        .padding(24)
        .frame(width: 440)
    }

    private func loadFromURL() {
        errorMessage = nil

        guard let parsed = AirScoreClient.parseAirScoreURL(urlText) else {
            errorMessage = "Invalid AirScore URL. Expected format:\nhttps://xc.highcloud.net/tracklog_map.html?trackid=...&comPk=...&tasPk=..."
            return
        }

        onLoad(parsed.comPk, parsed.tasPk, parsed.trackId)
        dismiss()
    }
}
