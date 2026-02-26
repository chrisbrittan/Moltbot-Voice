import OpenClawProtocol
import SwiftUI

/// Model for a skill that needs an API key
struct SkillNeedingAPIKey: Identifiable, Codable {
    var id: String { skillKey }
    let skillKey: String
    let name: String
    let description: String
    let primaryEnv: String
    let emoji: String?
}

/// Response from skills.needs_api_keys gateway method
struct SkillsNeedingAPIKeysResponse: Codable {
    let skills: [SkillNeedingAPIKey]
}

/// View model for JIT skill API key prompts
@MainActor
@Observable
final class SkillAPIKeyPromptModel {
    var skills: [SkillNeedingAPIKey] = []
    var isLoading = false
    var error: String?

    /// Current skill being prompted (if showing prompt)
    var currentSkill: SkillNeedingAPIKey?
    var apiKeyInput: String = ""
    var isSaving = false

    /// Check for skills needing API keys
    func checkForMissingKeys() async {
        isLoading = true
        error = nil

        do {
            let data = try await GatewayConnection.shared.requestRaw(
                method: "skills.needs_api_keys",
                params: nil)
            let response = try JSONDecoder().decode(SkillsNeedingAPIKeysResponse.self, from: data)
            skills = response.skills
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    /// Show prompt for a specific skill
    func promptForKey(skill: SkillNeedingAPIKey) {
        currentSkill = skill
        apiKeyInput = ""
    }

    /// Save the API key for the current skill
    func saveAPIKey() async -> Bool {
        guard let skill = currentSkill, !apiKeyInput.isEmpty else { return false }

        isSaving = true

        do {
            let params: [String: AnyCodable] = [
                "skillKey": AnyCodable(skill.skillKey),
                "apiKey": AnyCodable(apiKeyInput)
            ]
            _ = try await GatewayConnection.shared.requestRaw(
                method: "skills.set_api_key",
                params: params)

            // Remove from list
            skills.removeAll { $0.skillKey == skill.skillKey }
            currentSkill = nil
            apiKeyInput = ""
            isSaving = false
            return true
        } catch {
            self.error = error.localizedDescription
            isSaving = false
            return false
        }
    }

    /// Dismiss the current prompt without saving
    func dismissPrompt() {
        currentSkill = nil
        apiKeyInput = ""
    }
}

/// Just-in-time skill API key prompt sheet
struct SkillAPIKeyPromptSheet: View {
    let skill: SkillNeedingAPIKey
    @Binding var apiKey: String
    let isSaving: Bool
    let onSave: () async -> Void
    let onCancel: () -> Void
    let onSkip: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            // Header
            VStack(spacing: 8) {
                if let emoji = skill.emoji {
                    Text(emoji)
                        .font(.system(size: 48))
                }

                Text("Connect \(skill.name)")
                    .font(.title2.weight(.bold))

                Text(skill.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }

            // API Key input
            VStack(alignment: .leading, spacing: 8) {
                Text("Enter your \(friendlyEnvName(skill.primaryEnv))")
                    .font(.headline)

                SecureField("Paste your API key here", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())

                Text("Your key is stored locally and never shared.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)

            // Buttons
            HStack(spacing: 12) {
                Button("Skip for now") {
                    onSkip()
                }
                .buttonStyle(.bordered)

                Button("Cancel") {
                    onCancel()
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await onSave() }
                } label: {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Connect")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(apiKey.isEmpty || isSaving)
            }
        }
        .padding(24)
        .frame(width: 420)
    }

    /// Convert env var name to friendly display name
    private func friendlyEnvName(_ envName: String) -> String {
        // OPENAI_API_KEY -> OpenAI API Key
        // TAVILY_API_KEY -> Tavily API Key
        let parts = envName.split(separator: "_")
        return parts
            .map { part in
                let lower = part.lowercased()
                if lower == "api" || lower == "key" {
                    return part.capitalized
                }
                // Keep acronyms uppercase
                if part.count <= 3 {
                    return String(part)
                }
                return part.capitalized
            }
            .joined(separator: " ")
    }
}

/// Banner showing skills that need API keys
struct SkillsNeedingAPIKeysBanner: View {
    @Bindable var model: SkillAPIKeyPromptModel

    var body: some View {
        if !model.skills.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "key.fill")
                        .foregroundStyle(.orange)
                    Text("Some features need setup")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.skills) { skill in
                            Button {
                                model.promptForKey(skill: skill)
                            } label: {
                                HStack(spacing: 6) {
                                    if let emoji = skill.emoji {
                                        Text(emoji)
                                    }
                                    Text(skill.name)
                                        .font(.caption.weight(.medium))
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(Color.orange.opacity(0.1)))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .strokeBorder(Color.orange.opacity(0.3), lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(NSColor.controlBackgroundColor)))
            .sheet(item: $model.currentSkill) { skill in
                SkillAPIKeyPromptSheet(
                    skill: skill,
                    apiKey: $model.apiKeyInput,
                    isSaving: model.isSaving,
                    onSave: { _ = await model.saveAPIKey() },
                    onCancel: { model.dismissPrompt() },
                    onSkip: { model.dismissPrompt() })
            }
        }
    }
}

/// Standalone prompt view for showing during first use
struct SkillAPIKeyFirstUsePrompt: View {
    let skill: SkillNeedingAPIKey
    @State private var apiKey = ""
    @State private var isSaving = false
    @State private var error: String?
    let onComplete: (Bool) -> Void

    var body: some View {
        VStack(spacing: 24) {
            // Header with context
            VStack(spacing: 12) {
                if let emoji = skill.emoji {
                    Text(emoji)
                        .font(.system(size: 56))
                }

                Text("To \(actionDescription(for: skill)), I need access to \(skill.name)")
                    .font(.title3.weight(.medium))
                    .multilineTextAlignment(.center)
            }

            // API Key input
            VStack(alignment: .leading, spacing: 8) {
                Text("Enter your \(friendlyEnvName(skill.primaryEnv))")
                    .font(.headline)

                SecureField("Paste your API key here", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())

                if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                HStack(spacing: 4) {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                    Text("Stored locally, never shared")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }

            // Buttons
            HStack(spacing: 12) {
                Button("Not now") {
                    onComplete(false)
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await saveKey() }
                } label: {
                    if isSaving {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Connect \(skill.name)")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(apiKey.isEmpty || isSaving)
            }
        }
        .padding(28)
        .frame(width: 400)
    }

    private func saveKey() async {
        isSaving = true
        error = nil

        do {
            let params: [String: AnyCodable] = [
                "skillKey": AnyCodable(skill.skillKey),
                "apiKey": AnyCodable(apiKey)
            ]
            _ = try await GatewayConnection.shared.requestRaw(
                method: "skills.set_api_key",
                params: params)
            onComplete(true)
        } catch {
            self.error = error.localizedDescription
        }

        isSaving = false
    }

    private func friendlyEnvName(_ envName: String) -> String {
        let parts = envName.split(separator: "_")
        return parts
            .map { part in
                let lower = part.lowercased()
                if lower == "api" || lower == "key" {
                    return part.capitalized
                }
                if part.count <= 3 {
                    return String(part)
                }
                return part.capitalized
            }
            .joined(separator: " ")
    }

    private func actionDescription(for skill: SkillNeedingAPIKey) -> String {
        // Map skill names to friendly action descriptions
        let name = skill.name.lowercased()
        if name.contains("search") || name.contains("tavily") {
            return "search the web"
        }
        if name.contains("notion") {
            return "work with Notion"
        }
        if name.contains("github") {
            return "access GitHub"
        }
        if name.contains("whisper") || name.contains("transcri") {
            return "transcribe audio"
        }
        if name.contains("image") || name.contains("dall") {
            return "generate images"
        }
        return "use this feature"
    }
}
