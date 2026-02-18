import AppKit
import OpenClawIPC
import OpenClawProtocol
import SwiftUI

// MARK: - Simplified Onboarding Pages

/// Simplified 5-step onboarding flow for non-technical users.
/// Pages: Welcome → Sign In → Permissions → About You → Done
///
/// Key differences from the original:
/// - No "Gateway" terminology - defaults to local automatically
/// - No "CLI" page - installation happens silently
/// - No technical jargon - plain English throughout
/// - "About You" page captures user name and communication style
/// - Integrates with Working Memory for personalization
extension OnboardingView {
    // MARK: - Simplified Page Order

    /// Simplified page indices
    enum SimplifiedPage: Int, CaseIterable {
        case welcome = 100
        case signIn = 101
        case permissions = 102
        case aboutYou = 103
        case done = 104
    }

    static let simplifiedPageOrder: [Int] = SimplifiedPage.allCases.map { $0.rawValue }

    @ViewBuilder
    func simplifiedPageView(for pageIndex: Int) -> some View {
        switch pageIndex {
        case SimplifiedPage.welcome.rawValue:
            simplifiedWelcomePage()
        case SimplifiedPage.signIn.rawValue:
            simplifiedSignInPage()
        case SimplifiedPage.permissions.rawValue:
            simplifiedPermissionsPage()
        case SimplifiedPage.aboutYou.rawValue:
            simplifiedAboutYouPage()
        case SimplifiedPage.done.rawValue:
            simplifiedDonePage()
        default:
            EmptyView()
        }
    }

    // MARK: - Page 1: Welcome

    func simplifiedWelcomePage() -> some View {
        onboardingPage {
            VStack(spacing: 24) {
                Text("👋")
                    .font(.system(size: 64))

                Text("Welcome")
                    .font(.largeTitle.weight(.bold))

                Text("Let's set up your personal assistant")
                    .font(.title3)
                    .foregroundStyle(.secondary)

                onboardingCard(spacing: 12, padding: 16) {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "info.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.blue)
                            .frame(width: 24)

                        VStack(alignment: .leading, spacing: 8) {
                            Text("What your assistant can do")
                                .font(.headline)

                            VStack(alignment: .leading, spacing: 4) {
                                featureBullet("Help with tasks on your Mac")
                                featureBullet("Read and write files")
                                featureBullet("Run commands when you ask")
                                featureBullet("Connect to WhatsApp or Telegram")
                            }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                            Text("You control what it can access.")
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .padding(.top, 4)
                        }
                    }
                }
                .frame(maxWidth: 440)
            }
            .padding(.top, 16)
        }
    }

    private func featureBullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
            Text(text)
        }
    }

    // MARK: - Page 2: Sign In

    func simplifiedSignInPage() -> some View {
        onboardingPage {
            VStack(spacing: 24) {
                Text("Sign in to your AI account")
                    .font(.largeTitle.weight(.bold))

                Text("Pick the AI service you'd like to use.\nYou can add more later in Settings.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                onboardingCard(spacing: 12, padding: 16) {
                    // Claude (Recommended)
                    signInProviderButton(
                        title: "Continue with Claude",
                        subtitle: "Recommended",
                        color: .orange,
                        selected: anthropicAuthVerified)
                    {
                        startAnthropicOAuth()
                    }

                    // OAuth code input (shows after clicking authorize)
                    if anthropicAuthPKCE != nil && !anthropicAuthVerified {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Paste the code from your browser:")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)

                            HStack(spacing: 8) {
                                TextField("code#state", text: $anthropicAuthCode)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.system(.body, design: .monospaced))

                                Button("Connect") {
                                    Task { await finishAnthropicOAuth() }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(anthropicAuthCode.isEmpty || anthropicAuthBusy)
                            }

                            if let status = anthropicAuthStatus {
                                Text(status)
                                    .font(.caption)
                                    .foregroundStyle(status.contains("fail") ? .red : .secondary)
                            }
                        }
                        .padding(.vertical, 8)
                    }

                    // ChatGPT
                    signInProviderButton(
                        title: "Continue with ChatGPT",
                        subtitle: nil,
                        color: .green,
                        selected: false)
                    {
                        // TODO: OpenAI OAuth
                        openProviderSettings("openai")
                    }

                    // Gemini
                    signInProviderButton(
                        title: "Continue with Gemini",
                        subtitle: nil,
                        color: .blue,
                        selected: false)
                    {
                        // TODO: Google OAuth
                        openProviderSettings("google")
                    }

                    Divider().padding(.vertical, 8)

                    // Status indicator
                    if anthropicAuthVerified {
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text("Connected to Claude")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    } else if anthropicAuthBusy {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Connecting...")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }

                    // Advanced options (collapsed by default)
                    DisclosureGroup("Other options") {
                        VStack(alignment: .leading, spacing: 8) {
                            Button("I have an API key...") {
                                openProviderSettings("api-key")
                            }
                            .buttonStyle(.link)

                            Button("Use OpenRouter") {
                                openProviderSettings("openrouter")
                            }
                            .buttonStyle(.link)

                            Button("Use GitHub Copilot") {
                                openProviderSettings("github-copilot")
                            }
                            .buttonStyle(.link)
                        }
                        .padding(.top, 8)
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: 400)
            }
        }
        .task { await verifyAnthropicOAuthIfNeeded() }
    }

    private func signInProviderButton(
        title: String,
        subtitle: String?,
        color: Color,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Circle()
                    .fill(color)
                    .frame(width: 12, height: 12)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body.weight(.medium))
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    Image(systemName: "arrow.right.circle")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? color.opacity(0.1) : Color(NSColor.controlBackgroundColor)))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(selected ? color.opacity(0.4) : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func openProviderSettings(_ provider: String) {
        // TODO: Open settings to the provider configuration page
        // For now, just open general settings
        openSettings(tab: .general)
    }

    // MARK: - Page 3: Permissions

    func simplifiedPermissionsPage() -> some View {
        onboardingPage {
            VStack(spacing: 24) {
                Text("Allow access to help you")
                    .font(.largeTitle.weight(.bold))

                Text("Your assistant needs a few permissions\nto work properly on your Mac.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                onboardingCard(spacing: 0, padding: 0) {
                    VStack(spacing: 0) {
                        simplifiedPermissionRow(
                            title: "Control your computer",
                            description: "Needed to click buttons and type for you",
                            capability: .accessibility,
                            status: self.permissionMonitor.status[.accessibility] ?? false)

                        Divider()

                        simplifiedPermissionRow(
                            title: "See your screen",
                            description: "Needed to understand what you're looking at",
                            capability: .screenRecording,
                            status: self.permissionMonitor.status[.screenRecording] ?? false)

                        Divider()

                        simplifiedPermissionRow(
                            title: "Run automations",
                            description: "Needed to control apps on your behalf",
                            capability: .appleScript,
                            status: self.permissionMonitor.status[.appleScript] ?? false)
                    }
                }
                .frame(maxWidth: 440)

                HStack(spacing: 12) {
                    Button("Refresh") {
                        Task { await refreshPerms() }
                    }
                    .buttonStyle(.bordered)

                    if isRequesting {
                        ProgressView().controlSize(.small)
                    }
                }

                Text("You can change these anytime in System Settings.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func simplifiedPermissionRow(
        title: String,
        description: String,
        capability: Capability,
        status: Bool
    ) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body.weight(.medium))
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if status {
                Label("Allowed", systemImage: "checkmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.green)
            } else {
                Button("Allow") {
                    Task { await request(capability) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Page 4: About You

    func simplifiedAboutYouPage() -> some View {
        onboardingPage {
            VStack(spacing: 24) {
                Text("Let's get to know you")
                    .font(.largeTitle.weight(.bold))

                Text("This helps your assistant remember you\nand communicate the way you prefer.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                onboardingCard(spacing: 20, padding: 20) {
                    // Name input
                    VStack(alignment: .leading, spacing: 8) {
                        Text("What should I call you?")
                            .font(.headline)

                        TextField("Your name", text: self.$simplifiedUserName)
                            .textFieldStyle(.roundedBorder)
                            .font(.body)
                    }

                    Divider()

                    // Communication style
                    VStack(alignment: .leading, spacing: 12) {
                        Text("How should I talk to you?")
                            .font(.headline)

                        VStack(spacing: 8) {
                            communicationStyleOption(
                                title: "Casual & friendly",
                                description: "Like chatting with a friend",
                                value: "casual")

                            communicationStyleOption(
                                title: "Professional",
                                description: "Clear and to the point",
                                value: "professional")

                            communicationStyleOption(
                                title: "Warm & supportive",
                                description: "Encouraging and patient",
                                value: "warm")
                        }
                    }
                }
                .frame(maxWidth: 440)
            }
        }
    }

    private func communicationStyleOption(
        title: String,
        description: String,
        value: String
    ) -> some View {
        Button {
            self.simplifiedCommunicationStyle = value
        } label: {
            HStack(spacing: 12) {
                Image(systemName: self.simplifiedCommunicationStyle == value
                    ? "largecircle.fill.circle"
                    : "circle")
                    .foregroundStyle(self.simplifiedCommunicationStyle == value ? Color.accentColor : .secondary)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body.weight(.medium))
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(self.simplifiedCommunicationStyle == value
                        ? Color.accentColor.opacity(0.1)
                        : Color.clear))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Page 5: Done

    func simplifiedDonePage() -> some View {
        onboardingPage {
            VStack(spacing: 24) {
                Text("🎉")
                    .font(.system(size: 64))

                Text("You're ready!")
                    .font(.largeTitle.weight(.bold))

                Text("Your assistant is set up and waiting.")
                    .font(.body)
                    .foregroundStyle(.secondary)

                onboardingCard(spacing: 16, padding: 20) {
                    doneFeatureRow(
                        emoji: "💬",
                        title: "Click the menu bar icon to chat")

                    doneFeatureRow(
                        emoji: "🎤",
                        title: "Say \"Hey assistant\" for voice",
                        subtitle: "Enable in Settings → Voice")

                    doneFeatureRow(
                        emoji: "📱",
                        title: "Connect WhatsApp or Telegram",
                        subtitle: "Settings → Channels")
                }
                .frame(maxWidth: 400)

                Toggle("Launch at login", isOn: $state.launchAtLogin)
                    .onChange(of: state.launchAtLogin) { _, newValue in
                        AppStateStore.updateLaunchAtLogin(enabled: newValue)
                    }
                    .padding(.top, 8)
            }
        }
        .task {
            // Save user preferences to Working Memory when reaching done page
            await saveUserPreferencesToWorkingMemory()
        }
    }

    private func doneFeatureRow(
        emoji: String,
        title: String,
        subtitle: String? = nil
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(emoji)
                .font(.title2)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()
        }
    }

    // MARK: - Working Memory Integration

    /// Save user name and communication style to Working Memory
    func saveUserPreferencesToWorkingMemory() async {
        guard !self.simplifiedUserName.isEmpty || !self.simplifiedCommunicationStyle.isEmpty else { return }

        do {
            // Build params for the gateway call
            var params: [String: AnyCodable] = [:]
            if !self.simplifiedUserName.isEmpty {
                params["name"] = AnyCodable(self.simplifiedUserName)
            }
            if !self.simplifiedCommunicationStyle.isEmpty {
                params["tone"] = AnyCodable(self.simplifiedCommunicationStyle)
            }

            // Call the Working Memory onboarding.complete method via gateway
            _ = try await GatewayConnection.shared.requestRaw(
                method: "working_memory.onboarding.complete",
                params: params)
        } catch {
            // Log but don't fail - user can still use the app
            print("Failed to save user preferences to Working Memory: \(error)")
        }
    }
}

// MARK: - Simplified Onboarding State Keys

enum SimplifiedOnboardingKeys {
    static let userName = "moltbot.onboarding.userName"
    static let communicationStyle = "moltbot.onboarding.communicationStyle"
}

// Note: These state properties are added to Onboarding.swift as @State vars:
// @State var simplifiedUserName: String = ""
// @State var simplifiedCommunicationStyle: String = "professional"
