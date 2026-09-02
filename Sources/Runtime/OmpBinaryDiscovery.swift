import Foundation

// OMP BINARY DISCOVERY
// --------------------
// Per spec, do NOT assume /usr/local/bin/dani. Search sensible locations in
// order, then PATH. Allow Settings → Choose DANI executable. Once resolved,
// persist the path.
//
// The binary is invoked as `<binary> --mode rpc`. The same name may be either
// the OMP binary directly (`omp`) or the DANI CLI wrapper (`dani`) — both
// accept `--mode rpc` per the OMP RPC docs.

enum OmpBinaryDiscovery {
    /// User-defaults key for the last successfully resolved binary path.
    static let persistedPathKey = "omp.binaryPath"

    /// Candidate binary names, in preference order. `dani` is tried first
    /// (the spec: "DANI CLI is our OMP-based runtime"); `omp` is the upstream
    /// OMP binary itself.
    static let candidateNames: [String] = ["dani", "omp"]

    /// Search locations, in order. The first existing executable wins.
    static let searchPaths: [String] = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        ("~/.local/bin" as NSString).expandingTildeInPath,
        ("~/.bun/bin" as NSString).expandingTildeInPath,
    ]

    /// Resolve the OMP binary to launch. Order:
    ///   1. User-persisted path (if it still exists + is executable)
    ///   2. Settings-chosen path (passed in from the picker, if non-nil)
    ///   3. searchPaths for each candidate name
    ///   4. $PATH lookup for each candidate name
    /// Returns the absolute path, or nil if nothing was found.
    static func resolve(userChosenPath: String? = nil) -> String? {
        // 1. Persisted path — keep using it if it's still valid.
        if let persisted = UserDefaults.standard.string(forKey: persistedPathKey),
           isExecutable(at: persisted) {
            return persisted
        }
        // 2. Settings picker override.
        if let chosen = userChosenPath?.trimmingCharacters(in: .whitespaces),
           !chosen.isEmpty, isExecutable(at: chosen) {
            persist(chosen)
            return chosen
        }
        // 3. Well-known locations.
        for dir in searchPaths {
            for name in candidateNames {
                let p = (dir as NSString).appendingPathComponent(name)
                if isExecutable(at: p) {
                    persist(p)
                    return p
                }
            }
        }
        // 4. $PATH lookup (which /usr/bin/which — but spawn-free: use the
        // current environment's PATH and check each entry).
        if let path = viaPATH() {
            persist(path)
            return path
        }
        return nil
    }

    /// Force-persist a path chosen by the Settings picker (bypassing the
    /// existence check is intentional — the user may have picked something
    /// that's not yet chmod +x; we'll re-check at launch).
    static func persist(_ path: String) {
        UserDefaults.standard.set(path, forKey: persistedPathKey)
    }

    /// Clear the persisted path (Settings → "Use auto-discovery").
    static func clearPersisted() {
        UserDefaults.standard.removeObject(forKey: persistedPathKey)
    }

    /// Last persisted path, or nil.
    static var persisted: String? {
        UserDefaults.standard.string(forKey: persistedPathKey)
    }

    // MARK: - Private

    private static func isExecutable(at path: String) -> Bool {
        guard FileManager.default.isExecutableFile(atPath: path) else { return false }
        // Reject directories that happen to be "executable" (searchable).
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue
    }

    private static func viaPATH() -> String? {
        guard let pathEnv = ProcessInfo.processInfo.environment["PATH"] else { return nil }
        for dir in pathEnv.split(separator: ":") {
            for name in candidateNames {
                let p = (String(dir) as NSString).appendingPathComponent(name)
                if isExecutable(at: p) { return p }
            }
        }
        return nil
    }
}
