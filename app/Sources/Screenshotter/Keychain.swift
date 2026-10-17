import Foundation
import Security

/// The optional keys: Anthropic's for AI Edit ("anthropic"), Unsplash's for photo search
/// ("unsplash"). Each is handed to the engine as an environment variable and never shown to the
/// web UI.
enum Keychain {
    private static func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Screenshotter.AI",
            kSecAttrAccount as String: account,
        ]
    }

    static func load(_ account: String = "anthropic") -> String? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        let key = String(decoding: data, as: UTF8.self)
        return key.isEmpty ? nil : key
    }

    static func save(_ key: String, account: String = "anthropic") throws {
        let base = base(account)
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            SecItemDelete(base as CFDictionary)
            return
        }
        let data = Data(trimmed.utf8)
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status) }
        var q = base
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(q as CFDictionary, nil)
        if added != errSecSuccess { throw KeychainError(status: added) }
    }

    struct KeychainError: LocalizedError {
        var status: OSStatus
        var errorDescription: String? { "Keychain couldn't save the key (\(status))." }
    }
}
