import Foundation

/// Lightweight, dictionary-based UI localization. Strings here cover the
/// status-bar menu, alerts, the DANI execution-state pill, and Settings.
/// Native-language labels (e.g. "中文 (简体)") are not routed through here.
///
/// Bucket selection follows the user's chosen speech locale; "System Default"
/// falls back to `Locale.preferredLanguages`. Missing keys fall back to `en`,
/// then to the raw key — so adding a new English string is always safe even
/// before the other locales catch up.
enum L10n {
    /// Active translation bucket. Mutated via `setLanguage(localeCode:)`.
    private(set) static var current: String = preferredBucket()

    static func t(_ key: String) -> String {
        return strings[current]?[key] ?? strings["en"]?[key] ?? key
    }

    /// `localeCode` is a BCP-47 tag from the menu (e.g. "zh-CN"). Empty string
    /// means "System Default" — fall back to the OS preferred languages.
    static func setLanguage(localeCode: String) {
        current = localeCode.isEmpty ? preferredBucket() : bucket(for: localeCode)
    }

    private static func bucket(for code: String) -> String {
        let lower = code.lowercased()
        if lower.hasPrefix("zh-hant") || lower == "zh-tw" || lower == "zh-hk" || lower == "zh-mo" {
            return "zh-Hant"
        }
        if lower.hasPrefix("zh") { return "zh-Hans" }
        if lower.hasPrefix("ja") { return "ja" }
        if lower.hasPrefix("ko") { return "ko" }
        return "en"
    }

    private static func preferredBucket() -> String {
        for lang in Locale.preferredLanguages {
            let b = bucket(for: lang)
            if strings[b] != nil { return b }
        }
        return "en"
    }

    private static let strings: [String: [String: String]] = [
        "en": [
            // Menu
            "menu.enabled":            "Enabled",
            "menu.language":           "Language",
            "menu.systemDefault":      "System Default",
            "menu.microphone":         "Microphone",
            "menu.mic.auto":           "Auto (Follow Output Device)",
            "menu.settings":           "Settings…",
            "menu.quit":               "Quit Dani",
            // DANI execution-state pill
            "dani.state.listening":     "Listening…",
            "dani.state.transcribing": "Understanding…",
            "dani.state.thinking":     "Thinking…",
            "dani.state.working":      "Working…",
            "dani.state.done":         "Done ✓",
            "dani.state.error":        "Failed",
            "dani.state.needsApproval":"Approve?",
            // DANI text entry
            "dani.prompt.placeholder": "Ask Dani…",
            // DANI Settings
            "dani.settings.title":           "Dani Settings",
            "dani.settings.executable":       "DANI executable (OMP):",
            "dani.settings.executable.choose":"Choose…",
            "dani.settings.executable.discovered": "Discovered: %@",
            "dani.settings.executable.none": "Not found — install OMP or choose the binary.",
            "dani.settings.model":           "Model:",
            "dani.settings.provider":        "Provider:",
            "dani.settings.model.unknown":   "Unknown — start a prompt to populate.",
            "dani.settings.done":            "Done",
            // Alerts
            "alert.permissionRequired":      "Permission Required",
            "alert.languageUnavailable":     "Language Unavailable",
            "alert.accessibilityTitle":      "Accessibility Permission Required",
            "alert.accessibilityBody":       """
                Dani needs Accessibility permission to monitor the Fn key.

                1. Open System Settings → Privacy & Security → Accessibility
                2. Add Dani and toggle it on
                3. Return to this app — it will retry automatically
                """,
            "alert.openSystemSettings":      "Open System Settings",
            "alert.later":                   "Later",
            "alert.ok":                       "OK",
            "alert.executableNotFoundTitle":  "DANI executable not found",
            "alert.executableNotFoundBody":   """
                Dani could not find the OMP / DANI CLI binary.

                Install OMP (Oh My Pi) or choose the binary in Settings →
                DANI executable.
                """,
        ],
        "zh-Hans": [
            "menu.enabled":            "启用",
            "menu.language":           "语言",
            "menu.systemDefault":      "跟随系统",
            "menu.microphone":         "麦克风",
            "menu.mic.auto":           "自动（跟随输出设备）",
            "menu.settings":           "设置…",
            "menu.quit":               "退出 Dani",
            "dani.state.listening":     "聆听中…",
            "dani.state.transcribing": "理解中…",
            "dani.state.thinking":     "思考中…",
            "dani.state.working":      "执行中…",
            "dani.state.done":         "完成 ✓",
            "dani.state.error":        "失败",
            "dani.state.needsApproval":"是否批准？",
            "dani.prompt.placeholder": "询问 Dani…",
            "dani.settings.title":           "Dani 设置",
            "dani.settings.executable":       "DANI 可执行文件（OMP）：",
            "dani.settings.executable.choose":"选择…",
            "dani.settings.executable.discovered": "已发现：%@",
            "dani.settings.executable.none": "未找到 — 请安装 OMP 或选择可执行文件。",
            "dani.settings.model":           "模型：",
            "dani.settings.provider":        "提供商：",
            "dani.settings.model.unknown":   "未知 — 发送一次提示以读取。",
            "dani.settings.done":            "完成",
            "alert.permissionRequired":  "需要授权",
            "alert.languageUnavailable": "语言不可用",
            "alert.accessibilityTitle":  "需要辅助功能权限",
            "alert.accessibilityBody":   """
                Dani 需要辅助功能权限来监听 Fn 键。

                1. 打开 系统设置 → 隐私与安全性 → 辅助功能
                2. 添加 Dani 并开启开关
                3. 返回本应用 — 将自动重试
                """,
            "alert.openSystemSettings": "打开系统设置",
            "alert.later":              "稍后",
            "alert.ok":                 "好",
            "alert.executableNotFoundTitle": "未找到 DANI 可执行文件",
            "alert.executableNotFoundBody": """
                Dani 未找到 OMP / DANI CLI 可执行文件。

                请安装 OMP（Oh My Pi），或在设置 → DANI 可执行文件中选择。
                """,
        ],
        "zh-Hant": [
            "menu.enabled":            "啟用",
            "menu.language":           "語言",
            "menu.systemDefault":      "跟隨系統",
            "menu.microphone":         "麥克風",
            "menu.mic.auto":           "自動（跟隨輸出裝置）",
            "menu.settings":           "設定…",
            "menu.quit":               "結束 Dani",
            "dani.state.listening":     "聆聽中…",
            "dani.state.transcribing": "理解中…",
            "dani.state.thinking":     "思考中…",
            "dani.state.working":      "執行中…",
            "dani.state.done":         "完成 ✓",
            "dani.state.error":        "失敗",
            "dani.state.needsApproval":"是否批准？",
            "dani.prompt.placeholder": "詢問 Dani…",
            "alert.permissionRequired":  "需要授權",
            "alert.languageUnavailable": "語言不可用",
            "alert.accessibilityTitle":  "需要輔助使用權限",
            "alert.accessibilityBody":   """
                Dani 需要輔助使用權限以監聽 Fn 鍵。

                1. 開啟 系統設定 → 隱私權與安全性 → 輔助使用
                2. 加入 Dani 並開啟開關
                3. 回到本應用 — 將自動重試
                """,
            "alert.openSystemSettings": "開啟系統設定",
            "alert.later":              "稍後",
            "alert.ok":                 "好",
        ],
        "ja": [
            "menu.enabled":            "有効",
            "menu.language":           "言語",
            "menu.systemDefault":      "システム設定に従う",
            "menu.microphone":         "マイク",
            "menu.mic.auto":           "自動（出力デバイスに合わせる）",
            "menu.settings":           "設定…",
            "menu.quit":               "Dani を終了",
            "dani.state.listening":     "聞いています…",
            "dani.state.transcribing": "理解しています…",
            "dani.state.thinking":     "考えています…",
            "dani.state.working":      "実行しています…",
            "dani.state.done":         "完了 ✓",
            "dani.state.error":        "失敗",
            "dani.state.needsApproval":"承認しますか？",
            "dani.prompt.placeholder": "Dani に尋ねる…",
            "alert.permissionRequired":  "アクセス許可が必要です",
            "alert.languageUnavailable": "言語が利用できません",
            "alert.accessibilityTitle":  "アクセシビリティの許可が必要です",
            "alert.accessibilityBody":   """
                Dani は Fn キーを監視するためにアクセシビリティ権限が必要です。

                1. システム設定 → プライバシーとセキュリティ → アクセシビリティ を開く
                2. Dani を追加してオンに切り替える
                3. 本アプリに戻る — 自動的に再試行されます
                """,
            "alert.openSystemSettings": "システム設定を開く",
            "alert.later":              "あとで",
            "alert.ok":                 "OK",
        ],
        "ko": [
            "menu.enabled":            "사용",
            "menu.language":           "언어",
            "menu.systemDefault":      "시스템 기본값",
            "menu.microphone":         "마이크",
            "menu.mic.auto":           "자동(출력 장치를 따름)",
            "menu.settings":           "설정…",
            "menu.quit":               "Dani 종료",
            "dani.state.listening":     "듣고 있습니다…",
            "dani.state.transcribing": "이해하고 있습니다…",
            "dani.state.thinking":     "생각하고 있습니다…",
            "dani.state.working":      "실행하고 있습니다…",
            "dani.state.done":         "완료 ✓",
            "dani.state.error":        "실패",
            "dani.state.needsApproval":"승인하시겠습니까?",
            "dani.prompt.placeholder": "Dani 에게 물어보기…",
            "alert.permissionRequired":  "권한이 필요합니다",
            "alert.languageUnavailable": "언어를 사용할 수 없습니다",
            "alert.accessibilityTitle":  "손쉬운 사용 권한이 필요합니다",
            "alert.accessibilityBody":   """
                Dani가 Fn 키를 감지하려면 손쉬운 사용 권한이 필요합니다.

                1. 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 열기
                2. Dani를 추가하고 켜기
                3. 이 앱으로 돌아오면 자동으로 재시도합니다
                """,
            "alert.openSystemSettings": "시스템 설정 열기",
            "alert.later":              "나중에",
            "alert.ok":                 "확인",
        ],
    ]
}
